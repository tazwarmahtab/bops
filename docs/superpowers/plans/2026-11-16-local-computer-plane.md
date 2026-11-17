# Local Computer Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Linux computer plane in `host/` so the Mac app can point `BOPS_ORGO_ORIGIN` at it and keep using `lib/server/orgo.ts`.

**Architecture:** One Node 24 process. `host/server.ts` composes route modules. Incus sits behind `IncusDriver`. Tests inject `FakeDriver`, a temp state file, and a manual clock. The real `incus` binary is used only by `host/incus-cli.ts` when `start` is called without an injected driver.

**Tech Stack:** Node 24, `node:http`, `node:test`, TypeScript stripped by Node, no new npm dependency.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-11-16-local-computer-plane-design.md`. HTTP behavior that this plan does not restate still comes from `docs/plans/self-host-computer.md`.
- Do not edit `lib/server/orgo.ts`. Do not import `cloud/`.
- No new npm dependency. Relative imports. Node 24.
- One JSON file, `host/state/plane.json`, version 1. Not SQLite. Not Postgres.
- Default bind `127.0.0.1:8788`. A non-loopback `BOPS_HOST_ADDR` prints `non-loopback bind is unsupported` and exits non-zero. The plane does not mint a certificate.
- Bearer on every route except `GET /health`, the websockify socket, and `PUT /api/files/uploads/{token}`.
- Account bearer is `ORGO_API_KEY`. It is compared in memory and never written to the state file.
- Request log is one line: method, route template, status, milliseconds, computer id. Never log the bearer, bash text, key file, screenshot bytes, response bodies, websockify `token`, upload token, or `vnc_password`. Log the upload PUT as `/api/files/uploads/{token}`.
- Bash kills at the body `timeout` seconds and returns a non-zero `exitCode`. Do not wait the client's extra 20 seconds.
- Idle stop is `suspended`. No activity POST yet does not idle-suspend. `via: "runner"` idles at 5 minutes. Any other POST idles at 15 minutes. A task routine with `onMac: false` due within 5 minutes blocks idle suspend.
- Tests call `tick(now)`. They do not sleep for those windows.
- `node --test host/test/` must pass on a Mac with the fake driver.
- Image build does not call `https://www.orgo.ai/api/templates`. `template_ref` must be `bops-base`.
- Secrets are 501 `{ "code": "not_on_this_plane", "error": "not on this plane" }`, never 404.
- Deploy, logs, rollback, public URL, and domain attach are 404 `{ "code": "DEPLOYS_DISABLED", "error": "deploys disabled" }`.
- Sync families return 404 `{ "error": "not found" }` with no `code` property.
- Create defaults: 4 CPU, 16384 MB RAM, 80 GB disk. `Retry-After: 2` on `resume_in_progress`.

This is one plan. The pieces share one process, one state file, and one test command. Each task leaves `node --test host/test/` passing.

---

### Task 1: HTTP server and health

**Files:**
- Create: `host/http.ts`
- Create: `host/incus.ts`
- Create: `host/incus-fake.ts`
- Create: `host/log.ts`
- Create: `host/server.ts`
- Create: `host/test/helpers.ts`
- Test: `host/test/health.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `start(opts) -> { server, port, close }`, `FakeDriver`, `IncusDriver`, `sendJson`, `HttpError`, `logLine`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDriver } from "../incus-fake.ts";
import { withPlane } from "./helpers.ts";

test("health is 200 when the fake answers version", async () => {
  const plane = await withPlane();
  const res = await fetch(`${plane.base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  await plane.close();
});

test("health is 503 incus_down when version rejects", async () => {
  const driver = new FakeDriver();
  driver.versionError = new Error("down");
  const plane = await withPlane({ driver });
  const res = await fetch(`${plane.base}/health`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, code: "incus_down" });
  await plane.close();
});

test("a missing bearer on a private route is 401", async () => {
  const plane = await withPlane();
  const res = await fetch(`${plane.base}/api/workspaces`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
  await plane.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/health.test.ts`

Expected: FAIL, cannot find module `../incus-fake.ts` or `./helpers.ts`.

- [ ] **Step 3: Write the implementation**

`host/http.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(data.length), "cache-control": "no-store", ...headers });
  res.end(data);
}

export async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) throw new HttpError(413, "too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req, 1024 * 1024);
  try {
    const value = JSON.parse(raw.length ? raw.toString("utf8") : "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "body isn't json");
  }
}
```

`host/incus.ts`:

```ts
export type IncusFailure = "incus_down" | "host_full" | "disk_full";

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

export type IncusDriver = {
  version(): Promise<string>;
  free(): Promise<{ ramMb: number; diskGb: number }>;
  create(input: { name: string; image: string; cpu: number; ramMb: number; diskGb: number }): Promise<{ instance: string }>;
  start(instance: string): Promise<void>;
  stop(instance: string): Promise<void>;
  restart(instance: string): Promise<void>;
  delete(instance: string): Promise<void>;
  clone(instance: string, name: string): Promise<{ instance: string }>;
  resizeDisk(instance: string, diskGb: number): Promise<void>;
  exec(instance: string, command: string, timeoutSec: number): Promise<ExecResult>;
  screenshot(instance: string, screen: string, format: "jpeg" | "png", scale: number): Promise<Buffer>;
  input(instance: string, kind: "click" | "type" | "key", body: unknown, screen: string): Promise<void>;
  writeFile(instance: string, path: string, contents: Buffer, mode: number): Promise<void>;
  vncPort(instance: string, screenId: string): Promise<number>;
  sshPort(instance: string): Promise<number | null>;
};
```

`host/incus-fake.ts`:

```ts
import type { ExecResult, IncusDriver } from "./incus.ts";

export class FakeDriver implements IncusDriver {
  versionError: Error | null = null;
  freeRamMb = 65536;
  freeDiskGb = 400;
  execs: { instance: string; command: string; timeoutSec: number }[] = [];
  inputs: unknown[] = [];
  screenshots: { screen: string; format: string; scale: number }[] = [];
  writes: { instance: string; path: string; mode: number; contents: Buffer }[] = [];
  created = 0;
  cloned = 0;
  deleted: string[] = [];
  started: string[] = [];
  stopped: string[] = [];
  async version() {
    if (this.versionError) throw this.versionError;
    return "fake";
  }
  async free() {
    return { ramMb: this.freeRamMb, diskGb: this.freeDiskGb };
  }
  async create(input: { name: string }) {
    this.created += 1;
    return { instance: `inst-${input.name}` };
  }
  async start(instance: string) {
    this.started.push(instance);
  }
  async stop(instance: string) {
    this.stopped.push(instance);
  }
  async restart(instance: string) {
    this.stopped.push(instance);
    this.started.push(instance);
  }
  async delete(instance: string) {
    this.deleted.push(instance);
  }
  async clone(instance: string, name: string) {
    this.cloned += 1;
    return { instance: `${instance}-clone-${name}` };
  }
  async resizeDisk() {}
  async exec(instance: string, command: string, timeoutSec: number): Promise<ExecResult> {
    this.execs.push({ instance, command, timeoutSec });
    if (timeoutSec <= 1) return { exitCode: 124, stdout: "", stderr: "killed" };
    return { exitCode: 0, stdout: "ok\n", stderr: "" };
  }
  async screenshot(_instance: string, screen: string, format: "jpeg" | "png", scale: number) {
    this.screenshots.push({ screen, format, scale });
    return Buffer.from(`fake:${screen}:${format}:${scale}`);
  }
  async input(_instance: string, kind: "click" | "type" | "key", body: unknown, screen: string) {
    this.inputs.push({ kind, body, screen });
  }
  async writeFile(instance: string, path: string, contents: Buffer, mode: number) {
    this.writes.push({ instance, path, mode, contents });
  }
  async vncPort() {
    return 5900;
  }
  async sshPort() {
    return 2222;
  }
}
```

`host/log.ts`:

```ts
export function logLine(method: string, template: string, status: number, ms: number, computerId: string | null) {
  const id = computerId ?? "-";
  process.stdout.write(`${method} ${template} ${status} ${ms} ${id}\n`);
}
```

`host/server.ts` for this task only serves health and 401 for anything else. Later tasks add routes without changing `start`'s option names.

```ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { IncusDriver } from "./incus.ts";
import { HttpError, sendJson } from "./http.ts";
import { logLine } from "./log.ts";

export type StartOpts = {
  driver: IncusDriver;
  statePath: string;
  now: () => number;
  host: string;
  port: number;
  accountKey: string;
};

export function start(opts: StartOpts) {
  const server = createServer((req, res) => {
    void handle(opts, req, res);
  });
  return {
    server,
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(opts.port, opts.host, () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : opts.port);
        });
      }),
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function handle(opts: StartOpts, req: IncomingMessage, res: ServerResponse) {
  const started = Date.now();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let status = 500;
  let template = url.pathname;
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      try {
        await opts.driver.version();
        status = 200;
        sendJson(res, 200, { ok: true });
      } catch {
        status = 503;
        sendJson(res, 503, { ok: false, code: "incus_down" });
      }
      return;
    }
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || token !== opts.accountKey) {
      status = 401;
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    status = 404;
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof HttpError) {
      status = e.status;
      sendJson(res, e.status, { error: e.message, ...e.extra });
      return;
    }
    status = 500;
    sendJson(res, 500, { error: "internal" });
  } finally {
    logLine(req.method ?? "GET", template, status, Date.now() - started, null);
  }
}
```

`host/test/helpers.ts`:

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncusDriver } from "../incus.ts";
import { FakeDriver } from "../incus-fake.ts";
import { start } from "../server.ts";

export const ACCOUNT = "test-account-key";

export async function withPlane(opts: { driver?: IncusDriver; now?: () => number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bops-plane-"));
  const statePath = join(dir, "plane.json");
  const driver = opts.driver ?? new FakeDriver();
  const now = opts.now ?? (() => 1_700_000_000_000);
  const plane = start({ driver, statePath, now, host: "127.0.0.1", port: 0, accountKey: ACCOUNT });
  const port = await plane.listen();
  return {
    base: `http://127.0.0.1:${port}`,
    driver,
    statePath,
    auth: { authorization: `Bearer ${ACCOUNT}` },
    close: async () => {
      await plane.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test host/test/health.test.ts`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add host/http.ts host/incus.ts host/incus-fake.ts host/log.ts host/server.ts host/test/helpers.ts host/test/health.test.ts
git commit -m "feat(host): serve health and reject a missing bearer"
```

---

### Task 2: Atomic state file

**Files:**
- Create: `host/state.ts`
- Modify: `host/server.ts` (health reads the store before `version()`)
- Test: `host/test/state.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 except the test helper's temp path
- Produces: `emptyFile()`, `openStore(statePath)`, `Store.read()`, `Store.update(fn)`, type `PlaneFile`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { open, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { emptyFile, openStore } from "../state.ts";
import { withPlane } from "./helpers.ts";

test("a missing file becomes empty version 1 and health is 200", async () => {
  const plane = await withPlane();
  const res = await fetch(`${plane.base}/health`);
  assert.equal(res.status, 200);
  const store = openStore(plane.statePath);
  const file = await store.read();
  assert.ok(!("error" in file));
  if (!("error" in file)) assert.equal(file.version, 1);
  await plane.close();
});

test("a corrupt file is 503 state_unreadable and stays corrupt", async () => {
  const plane = await withPlane();
  await writeFile(plane.statePath, "{", "utf8");
  const res = await fetch(`${plane.base}/health`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, code: "state_unreadable" });
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(plane.statePath, "utf8"), "{");
  await plane.close();
});

test("two updates leave one whole nextRunAt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bops-state-"));
  const store = openStore(join(dir, "plane.json"));
  await store.update((file) => {
    file.routines["p/r"] = { projectId: "p", routineId: "r", nextRunAt: null, onMac: false, run: "task" };
  });
  await Promise.all([
    store.update((file) => {
      file.routines["p/r"].nextRunAt = 111;
    }),
    store.update((file) => {
      file.routines["p/r"].nextRunAt = 222;
    }),
  ]);
  const file = await store.read();
  assert.ok(!("error" in file));
  if (!("error" in file)) {
    const at = file.routines["p/r"].nextRunAt;
    assert.ok(at === 111 || at === 222);
  }
});

test("a second process waits on plane.lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bops-lock-"));
  const statePath = join(dir, "plane.json");
  const store = openStore(statePath);
  await store.update(() => {});
  const lock = await open(join(dir, "plane.lock"), "wx");
  const child = spawn(process.execPath, ["--experimental-strip-types", "host/test/lock-child.ts", statePath], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (b) => {
    out += b.toString();
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(out.includes("done"), false);
  await lock.close();
  const { unlink } = await import("node:fs/promises");
  await unlink(join(dir, "plane.lock"));
  const code = await new Promise<number>((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
  assert.equal(code, 0);
  assert.match(out, /done/);
});

void emptyFile;
```

`host/test/lock-child.ts`:

```ts
import { openStore } from "../state.ts";

const store = openStore(process.argv[2]);
await store.update((file) => {
  file.settings.runsOn = "cloud";
});
process.stdout.write("done\n");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/state.test.ts`

Expected: FAIL, `openStore` is not exported.

- [ ] **Step 3: Write `host/state.ts`**

```ts
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export type ScreenId = "default" | "screen-100" | "screen-101" | "screen-102";
export type ComputerStatus = "starting" | "running" | "suspending" | "suspended" | "resuming" | "stopped" | "error";

export type Computer = {
  id: string;
  name: string;
  workspaceId: string;
  instance: string;
  status: ComputerStatus;
  vncPassword: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  screens: ScreenId[];
};

export type Routine = { projectId: string; routineId: string; nextRunAt: number | null; onMac: boolean; run: string };

export type StoredKey = {
  keyId: string;
  computerId: string;
  hash: string;
  prefix: string;
  name: string;
  createdAt: string;
  lastUsed: string | null;
  expiresAt: null;
};

export type PlaneFile = {
  version: 1;
  workspaces: Record<string, { id: string; name: string; bopsWsId: string | null }>;
  computers: Record<string, Computer>;
  routines: Record<string, Routine>;
  runs: Record<string, { id: string; routineId: string; projectId: string; body: unknown }>;
  bops: Record<string, unknown>;
  settings: { runsOn: "cloud" | "mac" | null };
  activity: Record<string, { at: number; via: string | null }>;
  keys: Record<string, StoredKey>;
  egressDevices: Record<string, { id: string; name: string; pairingCode: string }>;
  computerEgress: Record<string, { mode: "direct" | "device"; deviceId: string | null; proxyOn: false }>;
  uploads: Record<string, { token: string; desktopId: string; destPath: string; sizeBytes: number; received: boolean; bytes: string }>;
  ssh: Record<string, { enabled: boolean; publicKey: string | null; hostPort: number | null }>;
};

export function emptyFile(): PlaneFile {
  return {
    version: 1,
    workspaces: {},
    computers: {},
    routines: {},
    runs: {},
    bops: {},
    settings: { runsOn: null },
    activity: {},
    keys: {},
    egressDevices: {},
    computerEgress: {},
    uploads: {},
    ssh: {},
  };
}

export type Store = {
  read(): Promise<PlaneFile | { error: "state_unreadable" }>;
  update(fn: (file: PlaneFile) => void): Promise<PlaneFile | { error: "state_unreadable" }>;
};

export function openStore(statePath: string): Store {
  const lockPath = join(dirname(statePath), "plane.lock");
  let queue: Promise<unknown> = Promise.resolve();

  async function lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn);
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function acquire() {
    await mkdir(dirname(statePath), { recursive: true });
    for (;;) {
      try {
        return await open(lockPath, "wx");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        await new Promise((r) => setTimeout(r, 15));
      }
    }
  }

  async function commit(file: PlaneFile) {
    const handle = await acquire();
    try {
      const tmp = `${statePath}.tmp-${randomBytes(4).toString("hex")}`;
      const out = await open(tmp, "w");
      await out.writeFile(JSON.stringify(file));
      await out.sync();
      await out.close();
      await rename(tmp, statePath);
    } finally {
      await handle.close();
      await unlink(lockPath).catch(() => undefined);
    }
  }

  return {
    async read() {
      return lock(async () => {
        try {
          const text = await readFile(statePath, "utf8");
          const json = JSON.parse(text) as PlaneFile;
          if (!json || json.version !== 1 || typeof json.computers !== "object") return { error: "state_unreadable" as const };
          return json;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") {
            const file = emptyFile();
            await commit(file);
            return file;
          }
          return { error: "state_unreadable" as const };
        }
      });
    },
    async update(fn) {
      return lock(async () => {
        const current = await (async () => {
          try {
            const text = await readFile(statePath, "utf8");
            const json = JSON.parse(text) as PlaneFile;
            if (!json || json.version !== 1) return { error: "state_unreadable" as const };
            return json;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyFile();
            return { error: "state_unreadable" as const };
          }
        })();
        if ("error" in current) return current;
        fn(current);
        await commit(current);
        return current;
      });
    },
  };
}
```

Fix the nested lock: `read()` and `update()` both call `lock()`, and `read()`'s ENOENT path calls `commit()`, which calls `acquire()`. `update` must not call `read()` (that would deadlock the in-process queue). The code above inlines the parse. `commit` must not call `lock()` again. It only takes the file lock. Good.

Health in `host/server.ts` calls `openStore(opts.statePath).read()` before `driver.version()`. On `{ error: "state_unreadable" }` return 503 `{ ok: false, code: "state_unreadable" }` and do not call `version()`.

`PlaneFile.uploads` includes `bytes: string` (base64) so a later task can complete an upload without a second store. The spec's `received` flag stays.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test host/test/state.test.ts host/test/health.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/state.ts host/server.ts host/test/state.test.ts host/test/lock-child.ts
git commit -m "feat(host): store the plane in one atomic JSON file"
```

---

### Task 3: Account bearer, computer keys, and profile

**Files:**
- Create: `host/auth.ts`
- Modify: `host/server.ts`
- Test: `host/test/auth.test.ts`

**Interfaces:**
- Consumes: `Store`, `PlaneFile`, `ACCOUNT` from helpers
- Produces: `who(header, accountKey, file) -> { kind: "account" } | { kind: "computer", computerId: string } | null`, `sha256(value) -> string`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { openStore } from "../state.ts";
import { ACCOUNT, withPlane } from "./helpers.ts";

test("the account bearer gets the local profile", async () => {
  const plane = await withPlane();
  const res = await fetch(`${plane.base}/api/user/profile`, { headers: plane.auth });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "local", full_name: "Local", api_key: { scope: "account" } });
  await plane.close();
});

test("a computer bearer gets computer scope", async () => {
  const plane = await withPlane();
  const secret = `cmp_${randomBytes(16).toString("hex")}`;
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers.c1 = {
      id: "c1",
      name: "One",
      workspaceId: "w1",
      instance: "inst-One",
      status: "running",
      vncPassword: "pw",
      cpu: 4,
      ramMb: 16384,
      diskGb: 80,
      screens: ["default"],
    };
    file.keys.k1 = {
      keyId: "k1",
      computerId: "c1",
      hash: createHash("sha256").update(secret).digest("hex"),
      prefix: "cmp_abcd",
      name: "Computer key for One",
      createdAt: new Date(0).toISOString(),
      lastUsed: null,
      expiresAt: null,
    };
  });
  const res = await fetch(`${plane.base}/api/user/profile`, { headers: { authorization: `Bearer ${secret}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "local", api_key: { scope: "computer", computer_id: "c1" } });
  const denied = await fetch(`${plane.base}/api/workspaces/w1/delete-preview`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(denied.status, 401);
  await plane.close();
});

void ACCOUNT;
```

The delete-preview assertion becomes 403 in Task 5. In this task a computer bearer may call profile and receives 401 on every other route. Task 5 replaces that 401 with 403 `owner_only` for workspace delete and member routes, and allows computer bearers on computer routes.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/auth.test.ts`

Expected: FAIL, profile is 404.

- [ ] **Step 3: Implement `host/auth.ts` and profile**

```ts
import { createHash, timingSafeEqual } from "node:crypto";
import type { PlaneFile } from "./state.ts";

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function sameSecret(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type Actor = { kind: "account" } | { kind: "computer"; computerId: string; keyId: string };

export function who(token: string, accountKey: string, file: PlaneFile): Actor | null {
  if (accountKey && sameSecret(token, accountKey)) return { kind: "account" };
  const hash = sha256(token);
  const key = Object.values(file.keys).find((item) => item.hash === hash);
  return key ? { kind: "computer", computerId: key.computerId, keyId: key.keyId } : null;
}
```

Wire `GET /api/user/profile` in `host/server.ts`. Load the store. A corrupt file on this route is 503 `{ code: "state_unreadable", error: "state unreadable" }`. Account actor returns the account JSON. Computer actor returns the computer JSON. Update `lastUsed` on that key to `new Date(opts.now()).toISOString()` inside `store.update`.

- [ ] **Step 4: Run tests**

Run: `node --test host/test/auth.test.ts host/test/health.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/auth.ts host/server.ts host/test/auth.test.ts
git commit -m "feat(host): identify the account key and a computer key"
```

---

### Task 4: Closed paths and settings

**Files:**
- Create: `host/routes/closed.ts`
- Create: `host/routes/settings.ts`
- Modify: `host/server.ts`
- Test: `host/test/closed.test.ts`

**Interfaces:**
- Consumes: `sendJson`, `Store`
- Produces: `closedRoutes()`, `settingsRoutes()`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { withPlane } from "./helpers.ts";

const secrets = ["GET /api/secrets", "POST /api/secrets", "POST /api/secrets/reveal", "POST /api/secrets/call", "DELETE /api/secrets/demo"];

test("secrets are 501 and not 404", async () => {
  const plane = await withPlane();
  for (const row of secrets) {
    const [method, path] = row.split(" ");
    const res = await fetch(`${plane.base}${path}`, { method, headers: plane.auth });
    assert.equal(res.status, 501, row);
    const body = await res.json();
    assert.equal(body.code, "not_on_this_plane");
    assert.equal(body.error, "not on this plane");
  }
  await plane.close();
});

test("crm and skills are 404 with no code", async () => {
  const plane = await withPlane();
  for (const path of ["/api/projects/p/crm", "/api/projects/p/skills"]) {
    const res = await fetch(`${plane.base}${path}`, { headers: plane.auth });
    assert.equal(res.status, 404, path);
    const body = await res.json();
    assert.equal(body.error, "not found");
    assert.equal("code" in body, false);
  }
  await plane.close();
});

test("deploy is 404 DEPLOYS_DISABLED", async () => {
  const plane = await withPlane();
  const res = await fetch(`${plane.base}/api/computers/c1/deploy-projects`, { headers: plane.auth });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { code: "DEPLOYS_DISABLED", error: "deploys disabled" });
  await plane.close();
});

test("settings default to mac and accept cloud", async () => {
  const plane = await withPlane();
  const first = await fetch(`${plane.base}/api/bops/settings`, { headers: plane.auth });
  assert.deepEqual(await first.json(), { runsOn: "mac" });
  const put = await fetch(`${plane.base}/api/bops/settings`, {
    method: "PUT",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ runsOn: "cloud" }),
  });
  assert.equal(put.status, 200);
  const again = await fetch(`${plane.base}/api/bops/settings`, { headers: plane.auth });
  assert.deepEqual(await again.json(), { runsOn: "cloud" });
  await plane.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/closed.test.ts`

Expected: FAIL, status 404 without `code` on secrets, or 401.

- [ ] **Step 3: Implement the routers**

`closed.ts` exports `matchClosed(method, path) -> { status, body } | null`.

Rules, first match wins:

- Path starts with `/api/secrets`: 501 `{ code: "not_on_this_plane", error: "not on this plane" }`.
- Path includes `/deploy-projects`, `/deployments`, `/public-urls`, or `/computers/` and `/domains`: 404 `{ code: "DEPLOYS_DISABLED", error: "deploys disabled" }`.
- Path is `/api/domains/search` or starts with `/api/projects/` and includes `/domains/`: 501 not_on_this_plane. `GET /api/projects/{id}/domains` exactly (one id segment, no further slash) is not closed. It is implemented in Task 5.
- Path includes `/crm`, `/skills`, `/skill-labels`, `/access`, `/orbit`, or `/bops/apps`: 404 `{ error: "not found" }` and the object has no `code` key.
- Otherwise null.

`settings.ts`:

- `GET /api/bops/settings` returns `{ runsOn: file.settings.runsOn ?? "mac" }`.
- `PUT` body `runsOn` of `cloud` or `mac` saves it and returns that object. Any other value throws `HttpError(400, "bad runsOn")`.

Register both before the generic 404 in `server.ts`.

- [ ] **Step 4: Run tests**

Run: `node --test host/test/closed.test.ts host/test/auth.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/routes/closed.ts host/routes/settings.ts host/server.ts host/test/closed.test.ts
git commit -m "feat(host): close secrets, deploys, and sync routes"
```

---

### Task 5: Workspaces, members, and delete preview

**Files:**
- Create: `host/routes/workspaces.ts`
- Modify: `host/server.ts`
- Modify: `host/test/auth.test.ts` (computer bearer on workspace delete is 403, not 401)
- Test: `host/test/workspaces.test.ts`

**Interfaces:**
- Consumes: `Store`, `Actor`, `HttpError`
- Produces: workspace ids, `GET /api/workspaces/{id}` body `{ desktops: { id, name }[] }`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { withPlane } from "./helpers.ts";

test("creates a workspace, rejects a duplicate name, and lists desktops", async () => {
  const plane = await withPlane();
  const made = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  assert.equal(made.status, 200);
  const ws = await made.json();
  const again = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  assert.equal(again.status, 400);
  assert.equal((await again.json()).code, "WORKSPACE_NAME_TAKEN");
  const one = await fetch(`${plane.base}/api/workspaces/${ws.id}`, { headers: plane.auth });
  assert.deepEqual(await one.json(), { id: ws.id, name: "Bops", desktops: [] });
  const preview = await fetch(`${plane.base}/api/workspaces/${ws.id}/delete-preview`, { headers: plane.auth });
  assert.deepEqual(await preview.json(), {
    computers: [],
    keys: [],
    skills: [],
    apps: [],
    madeApps: [],
    crmFiles: [],
    routines: [],
    orbitIssues: [],
  });
  const members = await fetch(`${plane.base}/api/workspaces/${ws.id}/members`, { headers: plane.auth });
  assert.deepEqual(await members.json(), { members: [{ id: "local", role: "owner", name: "Local" }], invites: [] });
  const domains = await fetch(`${plane.base}/api/projects/${ws.id}/domains`, { headers: plane.auth });
  assert.deepEqual(await domains.json(), { registrar: false, enabled: false, domains: [] });
  await plane.close();
});
```

Change the Task 3 computer-bearer test: `POST /api/projects/w1/delete` with the computer bearer expects 403 `{ code: "owner_only", error: "owner only" }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/workspaces.test.ts`

Expected: FAIL, 404.

- [ ] **Step 3: Implement `host/routes/workspaces.ts`**

Account actor only for writes, member routes, invite routes, and `POST /api/projects/{id}/delete`. A computer actor on those receives 403 `{ code: "owner_only", error: "owner only" }`.

- `POST /api/workspaces` `{ name }` creates `{ id, name, bopsWsId: null }`. Duplicate name, case-sensitive, is 400 `{ code: "WORKSPACE_NAME_TAKEN", error: "name taken" }`.
- `GET /api/workspaces` returns `{ workspaces: [...] }`.
- `PATCH /api/workspaces/{id}` accepts `name` and `bops_ws_id` (stored as `bopsWsId`).
- `GET /api/workspaces/{id}` returns `{ id, name, desktops }` where each desktop is `{ id, name }` of computers with that `workspaceId`.
- `GET /api/workspaces/{id}/delete-preview` returns the eight keys from the test. `computers` is `{ id, name }[]` from that workspace. The other arrays are `[]`.
- `POST /api/projects/{id}/delete` deletes the workspace and its computers' state rows. It does not have to call Incus until Task 6. When Task 6 exists, this handler calls `driver.delete` for each computer instance.
- Member and invite `GET`, `POST`, `PATCH`, and `DELETE` return 200 and the members body from the spec. They do not change state.
- `GET /api/projects/{id}/domains` returns `{ registrar: false, enabled: false, domains: [] }`.
- `POST /api/projects/{id}/domains` returns 501 `{ code: "not_on_this_plane", error: "not on this plane" }`.
- Unknown workspace is 404 `{ error: "not found" }`.
- When `read()` is `state_unreadable` or `driver.version()` rejects, `GET` workspace and `POST /api/workspaces` return 503 `{ code, error }` using `state unreadable` or `incus down`.

- [ ] **Step 4: Run tests**

Run: `node --test host/test/workspaces.test.ts host/test/auth.test.ts host/test/closed.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/routes/workspaces.ts host/server.ts host/test/workspaces.test.ts host/test/auth.test.ts
git commit -m "feat(host): add the single-user workspace routes"
```

---

### Task 6: Create, get, and delete a computer

**Files:**
- Create: `host/routes/computers.ts`
- Modify: `host/server.ts`
- Test: `host/test/computers.test.ts`

**Interfaces:**
- Consumes: `IncusDriver`, `FakeDriver.created`, `Store`, `Computer`
- Produces: `POST /api/computers` response `{ id, name, status: "running" }`, `view(computer)` used by later tasks

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDriver } from "../incus-fake.ts";
import { withPlane } from "./helpers.ts";

async function workspace(plane: Awaited<ReturnType<typeof withPlane>>) {
  const res = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  return (await res.json()).id as string;
}

test("creates and deletes a computer", async () => {
  const driver = new FakeDriver();
  const plane = await withPlane({ driver });
  const workspaceId = await workspace(plane);
  const made = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  assert.equal(made.status, 200);
  const body = await made.json();
  assert.equal(body.status, "running");
  assert.equal(driver.created, 1);
  const got = await fetch(`${plane.base}/api/computers/${body.id}`, { headers: plane.auth });
  const computer = await got.json();
  assert.equal(computer.vnc_password.length > 0, true);
  assert.equal(computer.workspace_id, workspaceId);
  assert.equal(computer.project_id, workspaceId);
  assert.deepEqual(computer.instance_details, { webrtc: false });
  assert.equal(computer.cpu, 4);
  assert.equal(computer.ram, 16);
  const dup = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  assert.equal(dup.status, 409);
  const del = await fetch(`${plane.base}/api/computers/${body.id}`, { method: "DELETE", headers: plane.auth });
  assert.equal(del.status, 200);
  assert.equal(driver.deleted.length, 1);
  await plane.close();
});

test("a full host does not create", async () => {
  const driver = new FakeDriver();
  driver.freeRamMb = 1000;
  const plane = await withPlane({ driver });
  const workspaceId = await workspace(plane);
  const res = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "host_full");
  assert.equal(body.free_ram_mb, 1000);
  assert.equal(driver.created, 0);
  await plane.close();
});

test("an unknown template is 400", async () => {
  const plane = await withPlane();
  const workspaceId = await workspace(plane);
  const res = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "other" }),
  });
  assert.equal(res.status, 400);
  await plane.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/computers.test.ts`

Expected: FAIL, 404.

- [ ] **Step 3: Implement create, get, and delete**

`POST /api/computers`:

- Require `workspace_id`, `name`, `template_ref`.
- `template_ref !== "bops-base"` throws `HttpError(400, "unknown template")`.
- Duplicate name is 409 `{ error: "name taken" }`.
- `ram` in the body, when present, is GB. `ramMb = ram * 1024`, otherwise 16384. `cpu = 4`. `diskGb = 80`.
- Call `free()`. If `freeRamMb < ramMb` or `freeDiskGb < 80`, return 409 `{ code: "host_full", error: "host full", free_ram_mb, free_disk_gb }` and do not call `create`.
- Call `driver.create`, then `driver.start`. Store status `running`, a random `vncPassword`, screens `["default", "screen-100", "screen-101", "screen-102"]`.
- If `version()` rejects, return 503 `incus_down` before create.

`GET` returns `id`, `name`, `status`, `vnc_password`, `workspace_id`, `project_id` (same workspace id), `cpu`, `ram` (`ramMb / 1024`), `os: "linux"`, `instance_details: { webrtc: false }`.

`DELETE` calls `driver.delete`, removes the computer, its keys, activity, egress, and ssh rows, and returns `{ deleted: true }`. Unknown id is 404.

- [ ] **Step 4: Run tests**

Run: `node --test host/test/computers.test.ts`

Expected: PASS. `driver.created` is 1 on the happy path and 0 on `host_full`.

- [ ] **Step 5: Commit**

```bash
git add host/routes/computers.ts host/server.ts host/test/computers.test.ts
git commit -m "feat(host): create and delete a computer through the fake driver"
```

---

### Task 7: Status, bash, screenshot, and input

**Files:**
- Modify: `host/routes/computers.ts`
- Test: `host/test/guest.test.ts`

**Interfaces:**
- Consumes: `FakeDriver.execs`, `FakeDriver.inputs`, `FakeDriver.screenshots`, `Computer.status`
- Produces: the status table from the spec

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDriver } from "../incus-fake.ts";
import { openStore } from "../state.ts";
import { withPlane } from "./helpers.ts";

async function make(driver = new FakeDriver()) {
  const plane = await withPlane({ driver });
  const ws = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  const workspaceId = (await ws.json()).id as string;
  const made = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  const id = (await made.json()).id as string;
  return { plane, driver, id };
}

test("bash on a running computer returns the fake exit", async () => {
  const { plane, driver, id } = await make();
  const started = Date.now();
  const res = await fetch(`${plane.base}/api/computers/${id}/bash`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ command: "echo hi", timeout: 30 }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).exit_code, 0);
  assert.equal(driver.execs[0].command, "echo hi");
  console.log(`bash ${Date.now() - started}ms`);
  await plane.close();
});

test("bash timeout 1 returns a non-zero exit", async () => {
  const { plane, id } = await make();
  const started = Date.now();
  const res = await fetch(`${plane.base}/api/computers/${id}/bash`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ command: "sleep 9", timeout: 1 }),
  });
  const body = await res.json();
  assert.equal(body.exit_code, 124);
  console.log(`bash-timeout ${Date.now() - started}ms`);
  await plane.close();
});

test("a suspended click does not call input", async () => {
  const { plane, driver, id } = await make();
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers[id].status = "suspended";
  });
  const res = await fetch(`${plane.base}/api/computers/${id}/click?screen=screen-100`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ x: 1, y: 2 }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "resume_in_progress");
  assert.equal(res.headers.get("retry-after"), "2");
  assert.equal(driver.inputs.length, 0);
  assert.equal(driver.started.length, 2);
  const again = await fetch(`${plane.base}/api/computers/${id}/click?screen=screen-100`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ x: 1, y: 2 }),
  });
  assert.equal(again.status, 200);
  assert.equal(driver.inputs.length, 1);
  await plane.close();
});

test("a running screenshot returns the fake bytes", async () => {
  const { plane, id } = await make();
  const started = Date.now();
  const res = await fetch(`${plane.base}/api/computers/${id}/screenshot?screen=default&format=png&scale=1`, { headers: plane.auth });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "fake:default:png:1");
  console.log(`screenshot ${Date.now() - started}ms`);
  await plane.close();
});

test("a suspended screenshot does not call screenshot", async () => {
  const { plane, driver, id } = await make();
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers[id].status = "suspended";
  });
  const started = Date.now();
  const res = await fetch(`${plane.base}/api/computers/${id}/screenshot?screen=default&format=jpeg&scale=0.75`, { headers: plane.auth });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "computer_asleep");
  assert.equal(driver.screenshots.length, 0);
  console.log(`screenshot-asleep ${Date.now() - started}ms`);
  await plane.close();
});

test("stopped bash says not suspended", async () => {
  const { plane, driver, id } = await make();
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers[id].status = "stopped";
  });
  const res = await fetch(`${plane.base}/api/computers/${id}/bash`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ command: "true", timeout: 5 }),
  });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /not suspended/i);
  assert.equal(driver.execs.length, 0);
  await plane.close();
});
```

`driver.started.length === 2` because create already calls `start` once, and the suspended click calls `start` once more. After that update the status is `running`, so the retry clicks.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/guest.test.ts`

Expected: FAIL, 404.

- [ ] **Step 3: Implement the status table**

Add `needsGuest(computer, driver, kind)`:

- `stopped` or `error`: throw `HttpError(409, "not suspended")`.
- `suspended`: set `resuming`, `await driver.start`. On rejection set `suspended` and throw `HttpError(503, "incus down", { code: "incus_down" })`. On success set `running`, then throw `HttpError(409, "resume in progress", { code: "resume_in_progress" })` with header `Retry-After: 2`. Do not exec in that response.
- `starting` or `resuming`: the same 409, and do not call `start`.
- `running`: return.

`screenshot` and `GET /api/computers/{id}/screens` on `suspended` return 409 `{ code: "computer_asleep", error: "computer asleep" }` and do not call the driver. On `starting` or `resuming` they return 409 `resume_in_progress`.

`POST bash` on `running` calls `driver.exec(instance, command, timeout)` and returns `{ exit_code, stdout, stderr }`. Empty command still calls `exec`.

`POST click|type|key` on `running` calls `driver.input`. `screen` query defaults to `default`.

`GET screenshot` on `running` calls `driver.screenshot`. Default `format` is `jpeg`, default `scale` is `0.75`. Respond with the bytes, `content-type` `image/jpeg` or `image/png`.

`POST resume`: `suspended` calls `start` and sets `running` (this route is the one that finishes the wake, unlike bash). `running` returns 200. Other statuses return 409 `not suspended`. `POST restart` calls `driver.restart` only when `running`, else the status table.

- [ ] **Step 4: Run tests**

Run: `node --test host/test/guest.test.ts host/test/computers.test.ts`

Expected: PASS. The duration lines are printed. There is no millisecond assertion.

- [ ] **Step 5: Commit**

```bash
git add host/routes/computers.ts host/test/guest.test.ts
git commit -m "feat(host): wake for input and keep a suspended screenshot asleep"
```

---

### Task 8: Screens and the websockify socket

**Files:**
- Modify: `host/routes/computers.ts`
- Modify: `host/server.ts`
- Test: `host/test/screens.test.ts`

**Interfaces:**
- Consumes: `vncPassword`, `vncPort`, `Computer.screens`
- Produces: upgrade path `/desktops/{id}/ws/websockify`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import { openStore } from "../state.ts";
import { withPlane } from "./helpers.ts";

test("a fifth screen is 409 with no code", async () => {
  const plane = await withPlane();
  const ws = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  const workspaceId = (await ws.json()).id;
  const made = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  const id = (await made.json()).id as string;
  const extra = await fetch(`${plane.base}/api/computers/${id}/screens`, { method: "POST", headers: plane.auth });
  assert.equal(extra.status, 409);
  const body = await extra.json();
  assert.equal(body.error, "four displays");
  assert.equal("code" in body, false);
  await plane.close();
});

test("websockify checks the token and not the bearer", async () => {
  const plane = await withPlane();
  const ws = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  const workspaceId = (await ws.json()).id;
  const made = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  const computer = await made.json();
  const bad = await new Promise<number>((resolve) => {
    const req = request(`${plane.base}/desktops/${computer.id}/ws/websockify?token=nope`, { headers: { connection: "Upgrade", upgrade: "websocket" } });
    req.on("upgrade", () => resolve(101));
    req.on("response", (res) => resolve(res.statusCode ?? 0));
    req.end();
  });
  assert.equal(bad, 401);
  const store = openStore(plane.statePath);
  const file = await store.read();
  assert.ok(!("error" in file));
  await plane.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/screens.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement screens and the upgrade**

Create already stores four screens, so `POST /screens` returns 409 `{ error: "four displays" }` with no `code`. `DELETE /screens/{screenId}` removes that id when it is not the last `default`. `PATCH /screens/default` accepts `{ width, height }` and returns 200 without calling Incus. `GET /screens` returns `{ screens: computer.screens }`.

`server.on("upgrade")`: path `/desktops/{id}/ws/websockify`. Compare `token` to `vncPassword`. Missing or wrong token writes `HTTP/1.1 401 Unauthorized` and destroys the socket. Do not read `Authorization`. On a match, call `vncPort(instance, screenId)` where no `screen` means `default`. Open a TCP connection to `127.0.0.1:port` only when the fake's port is a real listener. For the unit test, a correct token may reply `101 Switching Protocols` and then end, because the fake has no VNC server. Log the template `/desktops/{id}/ws/websockify` and do not log the query string.

- [ ] **Step 4: Run tests**

Run: `node --test host/test/screens.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/routes/computers.ts host/server.ts host/test/screens.test.ts
git commit -m "feat(host): limit screens to four and check the VNC token"
```

---

### Task 9: Keys, SSH, resize, clone, fork, webrtc, and size

**Files:**
- Modify: `host/routes/computers.ts`
- Create: `host/routes/size.ts`
- Test: `host/test/keys.test.ts`

**Interfaces:**
- Consumes: `sha256`, `writeFile`, `sshPort`, `free`, `clone`
- Produces: computer key hash in `file.keys`, guest file contents only in `driver.writes`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDriver } from "../incus-fake.ts";
import { openStore } from "../state.ts";
import { ACCOUNT, withPlane } from "./helpers.ts";

async function boot(driver = new FakeDriver()) {
  const plane = await withPlane({ driver });
  const ws = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  const workspaceId = (await ws.json()).id as string;
  const made = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  const id = (await made.json()).id as string;
  return { plane, driver, workspaceId, id };
}

test("the computer key is written to the guest and not returned", async () => {
  const { plane, driver, id } = await boot();
  const put = await fetch(`${plane.base}/api/computers/${id}/orgo-key`, { method: "PUT", headers: plane.auth });
  const body = await put.json();
  assert.equal(typeof body.keyId, "string");
  assert.equal("key" in body, false);
  assert.equal(driver.writes[0].path, "/root/.orgo-secrets.env");
  assert.equal(driver.writes[0].mode, 0o600);
  const text = driver.writes[0].contents.toString();
  assert.match(text, /export ORGO_API_KEY='/);
  assert.equal(text.includes(ACCOUNT), false);
  const got = await fetch(`${plane.base}/api/computers/${id}/orgo-key`, { headers: plane.auth });
  const key = await got.json();
  assert.match(key.prefix, /^[A-Za-z0-9_]{8}$/);
  assert.equal(key.expiresAt, null);
  assert.equal(key.name, "Computer key for Sam");
  const del = await fetch(`${plane.base}/api/computers/${id}/orgo-key`, { method: "DELETE", headers: plane.auth });
  assert.equal(del.status, 200);
  const missing = await fetch(`${plane.base}/api/computers/${id}/orgo-key`, { headers: plane.auth });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "key_not_found");
  await plane.close();
});

test("fork is unavailable and clone checks free space", async () => {
  const { plane, driver, workspaceId, id } = await boot();
  const fork = await fetch(`${plane.base}/api/computers/${id}/fork`, { method: "POST", headers: plane.auth });
  assert.equal(fork.status, 409);
  assert.equal((await fork.json()).code, "live_fork_unavailable");
  const cloned = await fetch(`${plane.base}/api/computers/${id}/clone`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
  assert.equal(cloned.status, 200);
  assert.equal(driver.cloned, 1);
  driver.freeRamMb = 1000;
  const full = await fetch(`${plane.base}/api/computers/${id}/clone`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
  assert.equal(full.status, 409);
  assert.equal((await full.json()).code, "host_full");
  assert.equal(driver.cloned, 1);
  await plane.close();
});

test("resize, webrtc, size, and ssh follow the contract", async () => {
  const driver = new FakeDriver();
  const { plane, id } = await boot(driver);
  const resize = await fetch(`${plane.base}/api/computers/${id}/resize`, { headers: plane.auth });
  const disk = await resize.json();
  assert.equal(disk.current_disk_gb, 80);
  assert.equal(disk.max_disk_gb, 80 + driver.freeDiskGb);
  const tooBig = await fetch(`${plane.base}/api/computers/${id}/resize`, {
    method: "PATCH",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ disk_size_gb: 99999 }),
  });
  assert.equal(tooBig.status, 409);
  assert.equal((await tooBig.json()).code, "disk_full");
  const rtc = await fetch(`${plane.base}/api/computers/${id}/webrtc`, { method: "POST", headers: plane.auth });
  assert.deepEqual(await rtc.json(), { webrtc: false });
  const size = await fetch(`${plane.base}/api/bops/computer/size`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ size: "pro" }),
  });
  assert.deepEqual(await size.json(), { size: "pro", changed: false, restarted: false });
  const off = await fetch(`${plane.base}/api/computers/${id}/ssh`, { headers: plane.auth });
  assert.deepEqual(await off.json(), {
    enabled: false,
    authorized_key_set: false,
    ipv4_host: null,
    ipv4_port: null,
    ssh_user: null,
    ssh_command: null,
  });
  const on = await fetch(`${plane.base}/api/computers/${id}/ssh`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ public_key: "ssh-ed25519 AAAA" }),
  });
  assert.deepEqual(await on.json(), { enabled: true, pending: true });
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers[id].status = "suspended";
  });
  await fetch(`${plane.base}/api/computers/${id}/resume`, { method: "POST", headers: plane.auth });
  const ready = await fetch(`${plane.base}/api/computers/${id}/ssh`, { headers: plane.auth });
  assert.deepEqual(await ready.json(), {
    enabled: true,
    authorized_key_set: true,
    ipv4_host: "127.0.0.1",
    ipv4_port: 2222,
    ssh_user: "root",
    ssh_command: "ssh root@127.0.0.1 -p 2222",
  });
  await plane.close();
});
```

`FakeDriver.clone` increments `cloned`, which starts at 0.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/keys.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement**

Mint the key with `randomBytes`. Prefix is the first 8 characters of the secret after replacing any character outside `[A-Za-z0-9_]` with `a`. Store only `sha256`. Write `export ORGO_API_KEY='<secret>'` through `writeFile` when status is `running`. Use the guest status table when it is not. `DELETE` removes the key. When `running`, `writeFile` the file again with the line removed. Computer `DELETE` also deletes matching keys.

`POST /fork` returns the 409 before any driver call. `POST /clone` checks `free()` the same way as create, then `driver.clone`, and stores a new computer in the requested workspace.

`GET /resize` uses `current_disk_gb` from the computer and `max_disk_gb = current + free().diskGb`. `PATCH` with `disk_size_gb` above that max is 409 `disk_full`. A body with `size` and no `disk_size_gb` returns `{ size, changed: false, restarted: false }`.

SSH follows the spec. The write of `authorized_keys` happens inside the resume transition to `running`, as a `writeFile` of `/root/.ssh/authorized_keys` mode `0600`. `GET` does not call `start`.

- [ ] **Step 4: Run tests**

Run: `node --test host/test/keys.test.ts host/test/guest.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/routes/computers.ts host/routes/size.ts host/incus-fake.ts host/server.ts host/test/keys.test.ts
git commit -m "feat(host): mint computer keys and refuse a live fork"
```

---

### Task 10: Wake, routines, and activity

**Files:**
- Create: `host/wake.ts`
- Create: `host/routes/routines.ts`
- Modify: `host/server.ts` (`bindWake`, return `tick`)
- Modify: `host/test/helpers.ts` (expose `tick`)
- Test: `host/test/wake.test.ts`

**Interfaces:**
- Consumes: `Store`, `IncusDriver`, `now`
- Produces: `bindWake(deps)`, `tick(now: number)`

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDriver } from "../incus-fake.ts";
import { openStore } from "../state.ts";
import { withPlane } from "./helpers.ts";

const MIN = 60_000;

test("a due task routine starts a suspended computer", async () => {
  const driver = new FakeDriver();
  let now = 1_000_000;
  const plane = await withPlane({ driver, now: () => now });
  const ws = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  const workspaceId = (await ws.json()).id;
  const made = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  const id = (await made.json()).id as string;
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers[id].status = "suspended";
  });
  const put = await fetch(`${plane.base}/api/projects/${workspaceId}/routines`, {
    method: "PUT",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify([{ id: "r1", nextRunAt: now, onMac: false, run: "task" }]),
  });
  assert.equal(put.status, 200);
  const before = driver.started.length;
  await plane.tick(now);
  assert.equal(driver.started.length, before + 1);
  const file = await store.read();
  if (!("error" in file)) assert.equal(file.computers[id].status, "running");
  await plane.close();
});

test("no activity POST does not idle-suspend", async () => {
  const driver = new FakeDriver();
  let now = 1_000_000;
  const plane = await withPlane({ driver, now: () => now });
  const ws = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  const workspaceId = (await ws.json()).id;
  const made = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  const id = (await made.json()).id as string;
  await plane.tick(now + 60 * MIN);
  const store = openStore(plane.statePath);
  const file = await store.read();
  if (!("error" in file)) assert.equal(file.computers[id].status, "running");
  assert.equal(driver.stopped.length, 0);
  await plane.close();
});

test("runner idle is 5 minutes and any other POST is 15", async () => {
  const driver = new FakeDriver();
  let now = 1_000_000;
  const plane = await withPlane({ driver, now: () => now });
  const secret = await computerSecret(plane);
  await fetch(`${plane.base}/api/bops/computer/active`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ via: "runner" }),
  });
  await plane.tick(now + 4 * MIN);
  assert.equal(driver.stopped.length, 0);
  await plane.tick(now + 5 * MIN);
  assert.equal(driver.stopped.length, 1);
  await plane.close();
});
```

`computerSecret` is this helper in the same file. It creates a workspace and computer, PUTs the orgo-key, and returns the secret from `driver.writes[0].contents` matched with `/ORGO_API_KEY='([^']+)'/`.

```ts
async function computerSecret(plane: Awaited<ReturnType<typeof withPlane>>) {
  const driver = plane.driver as FakeDriver;
  const ws = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  const workspaceId = (await ws.json()).id as string;
  const made = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  const id = (await made.json()).id as string;
  await fetch(`${plane.base}/api/computers/${id}/orgo-key`, { method: "PUT", headers: plane.auth });
  const secret = /ORGO_API_KEY='([^']+)'/.exec(driver.writes[0].contents.toString())?.[1];
  if (!secret) throw new Error("key was not written");
  return { id, workspaceId, secret };
}

test("an account POST idles at 15 minutes", async () => {
  const driver = new FakeDriver();
  let now = 1_000_000;
  const plane = await withPlane({ driver, now: () => now });
  const { id } = await computerSecret(plane);
  await fetch(`${plane.base}/api/bops/computer/active`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  await plane.tick(now + 14 * MIN);
  assert.equal(driver.stopped.length, 0);
  await plane.tick(now + 15 * MIN);
  const store = openStore(plane.statePath);
  const file = await store.read();
  if (!("error" in file)) assert.equal(file.computers[id].status, "suspended");
  await plane.close();
});

test("a routine due within 5 minutes blocks runner idle", async () => {
  const driver = new FakeDriver();
  let now = 1_000_000;
  const plane = await withPlane({ driver, now: () => now });
  const { id, workspaceId, secret } = await computerSecret(plane);
  await fetch(`${plane.base}/api/projects/${workspaceId}/routines`, {
    method: "PUT",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify([{ id: "r1", nextRunAt: now + 4 * MIN, onMac: false, run: "task" }]),
  });
  await fetch(`${plane.base}/api/bops/computer/active`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ via: "runner" }),
  });
  await plane.tick(now + 5 * MIN);
  const store = openStore(plane.statePath);
  const file = await store.read();
  if (!("error" in file)) assert.equal(file.computers[id].status, "running");
  await plane.close();
});

test("an empty routine list does not start, and the bops map is not a clock", async () => {
  const driver = new FakeDriver();
  let now = 1_000_000;
  const plane = await withPlane({ driver, now: () => now });
  const { id, workspaceId } = await computerSecret(plane);
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers[id].status = "suspended";
  });
  const started = driver.started.length;
  await fetch(`${plane.base}/api/projects/${workspaceId}/routines`, {
    method: "PUT",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify([]),
  });
  await fetch(`${plane.base}/api/projects/${workspaceId}/bops`, {
    method: "PUT",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ nextRunAt: now }),
  });
  const map = await fetch(`${plane.base}/api/projects/${workspaceId}/bops`, { headers: plane.auth });
  assert.deepEqual(await map.json(), { nextRunAt: now });
  await plane.tick(now);
  assert.equal(driver.started.length, started);
  await plane.close();
});
```

A computer whose stored status is `stopped` or `error` is left unchanged by `tick`. `POST /fork` looks up the computer by `id` or by `instance`, because `lib/server/orgo.ts` sends the instance id.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/wake.test.ts`

Expected: FAIL, `plane.tick` is not a function.

- [ ] **Step 3: Implement `host/wake.ts`**

```ts
import type { IncusDriver } from "./incus.ts";
import type { Store } from "./state.ts";

const RUNNER_IDLE = 5 * 60_000;
const OTHER_IDLE = 15 * 60_000;
const DUE_HOLD = 5 * 60_000;

let deps: { store: Store; driver: IncusDriver } | null = null;

export function bindWake(next: { store: Store; driver: IncusDriver }) {
  deps = next;
}

export async function tick(now: number) {
  if (!deps) return;
  const file = await deps.store.read();
  if ("error" in file) return;
  for (const routine of Object.values(file.routines)) {
    if (routine.onMac || routine.run !== "task" || routine.nextRunAt === null || routine.nextRunAt > now) continue;
    const computer = Object.values(file.computers).find((item) => item.workspaceId === routine.projectId);
    if (!computer || computer.status === "stopped" || computer.status === "error" || computer.status === "running") continue;
    try {
      await deps.driver.start(computer.instance);
      await deps.store.update((draft) => {
        if (draft.computers[computer.id]) draft.computers[computer.id].status = "running";
      });
    } catch (e) {
      console.error(`wake ${computer.id} failed`);
    }
  }
  const again = await deps.store.read();
  if ("error" in again) return;
  for (const computer of Object.values(again.computers)) {
    if (computer.status !== "running") continue;
    const beat = again.activity[computer.id];
    if (!beat) continue;
    const held = Object.values(again.routines).some(
      (routine) =>
        routine.projectId === computer.workspaceId &&
        !routine.onMac &&
        routine.run === "task" &&
        routine.nextRunAt !== null &&
        routine.nextRunAt <= now + DUE_HOLD,
    );
    if (held) continue;
    const limit = beat.via === "runner" ? RUNNER_IDLE : OTHER_IDLE;
    if (now - beat.at < limit) continue;
    await deps.driver.stop(computer.instance);
    await deps.store.update((draft) => {
      if (draft.computers[computer.id]) draft.computers[computer.id].status = "suspended";
    });
  }
}
```

`host/routes/routines.ts` stores the PUT array under `projectId/routineId`. An empty array deletes routines for that project. `GET` returns the array. `DELETE /api/projects/{id}/routines/{routineId}` removes one and 404s when missing. `POST` and `GET .../runs` store and return the body that was sent. Activity `POST` uses the actor rule from the spec: computer bearer updates that computer, account bearer updates every computer. `at` is `opts.now()`. `via` is the string `runner` only when the body says so, otherwise null.

`start()` calls `bindWake` and returns `tick`. The production timer is `setInterval(() => void tick(opts.now()), 60_000)` and is not started when `opts.port === 0` so tests do not arm a timer. Tests call `plane.tick(now)`.

- [ ] **Step 4: Run tests**

Run: `node --test host/test/wake.test.ts`

Expected: PASS. No test waits 5 minutes.

- [ ] **Step 5: Commit**

```bash
git add host/wake.ts host/routes/routines.ts host/server.ts host/test/helpers.ts host/test/wake.test.ts
git commit -m "feat(host): wake due routines and honor the idle windows"
```

---

### Task 11: Egress

**Files:**
- Create: `host/routes/egress.ts`
- Create: `host/headscale.md`
- Test: `host/test/egress.test.ts`

**Interfaces:**
- Consumes: `Store.computerEgress`, `process.env.BOPS_HEADSCALE_URL`
- Produces: `{ id, name, pairing_code }` and upstream `{ mode, device_id, proxy_on }`

- [ ] **Step 1: Write the failing test**

Assert:

- `POST /api/egress-devices` `{ name: "Mac" }` returns `id`, `name`, and `pairing_code` of 8 characters.
- `GET` returns `{ devices: [{ id, name, online: null }], rendezvous: null }` when `BOPS_HEADSCALE_URL` is unset, and the URL when it is set.
- `GET /api/computers/{id}/egress/upstream` before a choice is `{ mode: "residential", device_id: null, proxy_on: false }`.
- `POST` `{ mode: "residential" }` returns 200 and the GET stays `residential` with `proxy_on: false`.
- `POST` `{ mode: "device", device_id }` returns 200 and GET returns that device id.
- `POST /residential-proxy` `{ enabled: false }` is 200. `{ enabled: true }` is 409 `{ code: "residential_unavailable", error: "residential unavailable" }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/egress.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement and document**

Store `mode: "residential"` as `computerEgress.mode = "direct"`. The HTTP field stays `"residential"`. `mode: "device"` stores `device`. `pairing_code` is 8 characters from `[A-Za-z0-9]`. `online` is always null.

`host/headscale.md` tells the operator to run one Headscale server, create one user, and set `BOPS_HEADSCALE_URL` to that server. The guest joins with the Tailscale client from `orgo/bops-base.mjs`. The plane does not start Headscale.

- [ ] **Step 4: Run tests**

Run: `node --test host/test/egress.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/routes/egress.ts host/headscale.md host/server.ts host/test/egress.test.ts
git commit -m "feat(host): record Headscale egress without a residential proxy"
```

---

### Task 12: Uploads

**Files:**
- Create: `host/routes/files.ts`
- Modify: `host/server.ts` (the upload PUT skips the bearer)
- Test: `host/test/uploads.test.ts`

**Interfaces:**
- Consumes: `BOPS_UPLOAD_ORIGIN`, `writeFile`, guest status table
- Produces: `upload_url`, `upload_token`

- [ ] **Step 1: Write the failing test**

Assert:

- With `BOPS_UPLOAD_ORIGIN` unset, `POST /api/files/uploads` is 409 `{ code: "upload_needs_https", error: "upload needs https" }`.
- With `BOPS_UPLOAD_ORIGIN=https://uploads.example`, the POST `{ desktopId, filename: "a.txt", size_bytes: 4, destPath: "/tmp/a.txt" }` returns `upload_url` starting `https://uploads.example/api/files/uploads/` and `upload_token`.
- `PUT` that URL path on the plane, with no Authorization and body `abcd`, is 200.
- `PUT` with body `abc` is 400 `{ error: "size mismatch" }`.
- `POST /complete` before a successful PUT is 409 `{ error: "incomplete upload" }`.
- After the good PUT, while the computer is `running`, `POST /complete` `{ desktopId, upload_token }` is 200 and `driver.writes` contains `/tmp/a.txt`.
- An unknown token PUT is 404.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/uploads.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement**

Store the token, size, dest, and `received: false`. The PUT compares `Buffer.byteLength` to `sizeBytes`. On a match, set `received` and store `bytes` as base64. `complete` uses the guest status table, then `writeFile` with mode `0644`, then deletes the upload row. Log the PUT template `/api/files/uploads/{token}`.

- [ ] **Step 4: Run tests**

Run: `node --test host/test/uploads.test.ts host/test/guest.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/routes/files.ts host/server.ts host/test/uploads.test.ts
git commit -m "feat(host): accept https file uploads into a running guest"
```

---

### Task 13: Route freeze

**Files:**
- Create: `host/routes.md`
- Test: `host/test/routes.test.ts`

**Interfaces:**
- Consumes: the route handlers from Tasks 4–12
- Produces: one row per path the scanner finds

- [ ] **Step 1: Write the failing test**

`host/test/routes.test.ts` reads every `lib/server/**/*.ts` file. It strips block comments and `//` comments. It finds calls named `call(`, `hostingCall(`, `callOrgo(`, and `postOrgo(`, then takes string and template literals in that call's argument text. It also takes a template that contains `/screenshot` on a line that contains `base()`. Normalize by replacing `${...}` with `{id}`, deleting the query string, and prefixing `/api` when the path does not already have it. A path matches a `routes.md` row when the row is equal or the row ends in `*` and the path starts with the row minus `*`.

Each row is `METHOD PATH CLASS` or `* PATH CLASS` when every method shares a class. `CLASS` is one of `implement`, `404 no code`, `404 DEPLOYS_DISABLED`, `501 not_on_this_plane`. The test fails when a scanned path has no row, or a row's class is not one of those four.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/routes.test.ts`

Expected: FAIL, `host/routes.md` is missing.

- [ ] **Step 3: Write `host/routes.md`**

Include a row for every path in the Global Constraints and for these prefixes:

- `* /api/secrets*` `501 not_on_this_plane`
- `* /api/computers/{id}/deploy-projects*` `404 DEPLOYS_DISABLED`
- `* /api/computers/{id}/deployments*` `404 DEPLOYS_DISABLED`
- `* /api/computers/{id}/public-urls*` `404 DEPLOYS_DISABLED`
- `* /api/computers/{id}/domains*` `404 DEPLOYS_DISABLED`
- `* /api/domains/search` `501 not_on_this_plane`
- `* /api/projects/{id}/domains/*` `501 not_on_this_plane`
- `GET /api/projects/{id}/domains` `implement`
- `POST /api/projects/{id}/domains` `501 not_on_this_plane`
- `* /api/projects/{id}/crm*` `404 no code`
- `* /api/projects/{id}/skills*` `404 no code`
- `* /api/workspaces/{id}/skills*` `404 no code`
- `* /api/projects/{id}/skill-labels*` `404 no code`
- `* /api/projects/{id}/access*` `404 no code`
- `* /api/projects/{id}/orbit*` `404 no code`
- `* /api/projects/{id}/bops/apps*` `404 no code`

Add an `implement` row for each computer, workspace, routine, egress, upload, settings, profile, and size path this plan's tests call. Run the test and add any scanned path it still reports, using the class rules above. A scanned path that is billing (`/api/bops/plan`, `/api/bops/portal`, `/api/bops/checkout`, `/api/bops/credit/`) is `501 not_on_this_plane`.

- [ ] **Step 4: Run tests**

Run: `node --test host/test/routes.test.ts`

Expected: PASS, and the test prints the scanned path count.

- [ ] **Step 5: Commit**

```bash
git add host/routes.md host/test/routes.test.ts
git commit -m "test(host): freeze every Orgo path the app calls"
```

---

### Task 14: Image recipe and the CLI driver

**Files:**
- Create: `host/image/build.mjs`
- Create: `host/incus-cli.ts`
- Test: `host/test/image.test.ts`
- Test: `host/test/incus-cli.test.ts`

**Interfaces:**
- Consumes: `orgo/bops-base.mjs` as text, `IncusDriver`
- Produces: `execArgv(binary, instance, command, timeoutSec)`, `node host/image/build.mjs --print`

- [ ] **Step 1: Write the failing tests**

`image.test.ts` runs `node host/image/build.mjs --print` and asserts stdout contains `bops-base`, `gimp`, `0.160.0`, `2.1.292`, and `bops-screen-layout`. It reads `host/image/build.mjs` and asserts the source does not contain `www.orgo.ai`.

`incus-cli.test.ts` asserts `execArgv("incus", "inst", "echo hi", 5)` equals `["incus", "exec", "inst", "--", "timeout", "5", "bash", "-lc", "echo hi"]` and that the command is one argv element. Assert the module source does not contain `shell: true`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test host/test/image.test.ts host/test/incus-cli.test.ts`

Expected: FAIL, files missing.

- [ ] **Step 3: Implement**

`build.mjs` reads `orgo/bops-base.mjs` as text. It does not import it. It prints the apt package names, the Codex version, the Claude Code version, and the `files[].to` destinations. `--print` exits 0. With no flag, on Linux, it writes that recipe to stdout and runs `incus image` only when `incus` is on `PATH`. When `incus` is missing it prints `incus is not on PATH` and exits 2. It never calls `fetch`.

`incus-cli.ts` exports `execArgv` and `cliDriver(binary = "incus")` implementing `IncusDriver` with `spawn(binary, args, { shell: false })`. `exec` kills the child when `timeoutSec * 1000` elapses and resolves `{ exitCode: 124, stdout, stderr }`.

`host/main.ts` parses `BOPS_HOST_ADDR` or `127.0.0.1:8788`. A non-loopback host prints `non-loopback bind is unsupported` and `process.exit(1)`. It calls `start` with `cliDriver()` and `accountKey: process.env.ORGO_API_KEY ?? ""`.

- [ ] **Step 4: Run tests**

Run: `node --test host/test/image.test.ts host/test/incus-cli.test.ts`

Expected: PASS. Do not require a Linux `incus` binary.

- [ ] **Step 5: Commit**

```bash
git add host/image/build.mjs host/incus-cli.ts host/main.ts host/test/image.test.ts host/test/incus-cli.test.ts
git commit -m "feat(host): add the Incus recipe and the real driver argv"
```

---

### Task 15: Self-host profile in the README

**Files:**
- Modify: `.env.example` at the `BOPS_ORGO_ORIGIN` comment
- Modify: `README.md` section `## Run it yourself`
- Test: `host/test/docs.test.ts`

**Interfaces:**
- Consumes: the finished plane
- Produces: the operator paragraph and the systemd snippet

- [ ] **Step 1: Write the failing test**

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the self-host profile names the Linux plane", () => {
  const env = readFileSync(".env.example", "utf8");
  assert.match(env, /BOPS_ORGO_ORIGIN=/);
  assert.match(env, /Linux host/);
  assert.match(env, /BOPS_UPLOAD_ORIGIN=/);
  assert.match(env, /BOPS_WEBRTC=0/);
  assert.match(env, /BOPS_HEADSCALE_URL=/);
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /Run it yourself/);
  assert.match(readme, /Incus/);
  assert.match(readme, /Headscale/);
  assert.match(readme, /Keys and Your Apps are closed on this plane/);
  assert.match(readme, /non-loopback bind is unsupported/);
  assert.match(readme, /systemd/);
  assert.match(readme, /auth: key/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test host/test/docs.test.ts`

Expected: FAIL, the new sentences are absent.

- [ ] **Step 3: Edit the docs**

Under `BOPS_ORGO_ORIGIN=` in `.env.example`, add comments: the value is the Linux host URL, the Mac's loopback only when the app runs on that same box. Add:

```
# https origin the runner's file PUT requires. The plane returns 409 upload_needs_https until this is https.
BOPS_UPLOAD_ORIGIN=
# The Mac app stays on VNC for this plane.
BOPS_WEBRTC=0
# Optional Headscale URL recorded as egress rendezvous. The plane does not start Headscale.
BOPS_HEADSCALE_URL=
```

In `README.md` under `## Run it yourself`, add a subsection `### Your own computer plane`. State that the plane runs on a Linux host with Incus and Node 24, the Mac app stays the client, and the operator points `BOPS_ORGO_ORIGIN` at `http://127.0.0.1:8788` only on that same box. Say Keys and Your Apps are closed on this plane. Say a non-loopback bind is unsupported until the operator terminates TLS, and the plane does not mint a certificate. Include this systemd unit:

```
[Service]
WorkingDirectory=/opt/bops
ExecStart=/usr/bin/node host/main.ts
Environment=ORGO_API_KEY=replace-me
Environment=BOPS_WEBRTC=0
```

The manual check in that subsection: create a computer, open its screen in the app, run a one-line bash, and confirm the runner log says `auth: key`. No new required key besides the local `ORGO_API_KEY`.

- [ ] **Step 4: Run the whole suite**

Run: `node --test host/test/`

Expected: PASS. Then run `node host/image/build.mjs --print` and expect stdout that contains `bops-base`.

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md host/test/docs.test.ts
git commit -m "docs(host): tell operators how to run the local plane"
```

---

## Self-review notes

Spec coverage is the task list: health and the state file (Tasks 1–2), auth and profile (Task 3), closed paths and settings (Task 4), workspaces (Task 5), create and delete (Task 6), guest status (Task 7), screens and the socket (Task 8), keys and the remaining computer routes (Task 9), wake (Task 10), egress (Task 11), uploads (Task 12), the route freeze (Task 13), the image and CLI driver (Task 14), and the README (Task 15).

The manual screen check stays a README step. It is not a unit test, because it needs a Linux guest.
