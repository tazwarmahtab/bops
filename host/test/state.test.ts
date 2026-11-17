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