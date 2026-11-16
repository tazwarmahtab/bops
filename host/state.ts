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