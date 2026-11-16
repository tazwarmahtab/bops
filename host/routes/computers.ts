import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sha256, type Actor } from "../auth.ts";
import { HttpError, readJson, sendJson } from "../http.ts";
import type { IncusDriver } from "../incus.ts";
import type { Computer, PlaneFile, ScreenId, StoredKey, Store } from "../state.ts";

const SCREENS: ScreenId[] = ["default", "screen-100", "screen-101", "screen-102"];

function newComputerId() {
  return randomBytes(8).toString("hex");
}

function newVncPassword() {
  return randomBytes(12).toString("base64url");
}

function parseComputerPath(path: string) {
  const m = path.match(/^\/api\/computers\/([^/]+)(?:\/(.+))?$/);
  if (!m) return null;
  return { id: m[1], sub: m[2] ?? null };
}

class ResumeInProgress extends Error {}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string) {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

function resumeInProgress(res: ServerResponse) {
  sendJson(res, 409, { error: "resume in progress", code: "resume_in_progress" }, { "Retry-After": "2" });
  return 409;
}

async function needsGuest(
  store: Store,
  computer: Computer,
  driver: IncusDriver,
  kind: "action" | "screenshot",
): Promise<void> {
  const { status, id, instance } = computer;
  if (status === "stopped" || status === "error") {
    throw new HttpError(409, "not suspended");
  }
  if (status === "suspended") {
    if (kind === "screenshot") {
      throw new HttpError(409, "computer asleep", { code: "computer_asleep" });
    }
    await store.update((file) => {
      file.computers[id].status = "resuming";
    });
    try {
      await driver.start(instance);
    } catch {
      await store.update((file) => {
        file.computers[id].status = "suspended";
      });
      throw new HttpError(503, "incus down", { code: "incus_down" });
    }
    await store.update((file) => {
      file.computers[id].status = "running";
    });
    throw new ResumeInProgress();
  }
  if (status === "starting" || status === "resuming" || status === "suspending") {
    throw new ResumeInProgress();
  }
  if (status === "running") return;
  throw new HttpError(409, "not suspended");
}

function screenFrom(req: IncomingMessage) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const screen = url.searchParams.get("screen");
  return screen && screen.length > 0 ? screen : "default";
}

function screenshotOpts(req: IncomingMessage) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const formatRaw = url.searchParams.get("format") ?? "jpeg";
  const format = formatRaw === "png" ? "png" : "jpeg";
  const scaleRaw = url.searchParams.get("scale");
  const scale = scaleRaw !== null && scaleRaw !== "" ? Number(scaleRaw) : 0.75;
  return { format: format as "jpeg" | "png", scale: Number.isFinite(scale) ? scale : 0.75 };
}

function nameTaken(file: PlaneFile, name: string) {
  return Object.values(file.computers).some((c) => c.name === name);
}

function uniqueName(file: PlaneFile, base: string) {
  if (!nameTaken(file, base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (!nameTaken(file, candidate)) return candidate;
  }
}

function resolveComputer(file: PlaneFile, key: string) {
  const direct = file.computers[key];
  if (direct) return { id: key, computer: direct };
  const found = Object.entries(file.computers).find(([, c]) => c.instance === key);
  return found ? { id: found[0], computer: found[1] } : null;
}

function computerStoredKey(file: PlaneFile, computerId: string): StoredKey | null {
  return Object.values(file.keys).find((k) => k.computerId === computerId) ?? null;
}

function keyPrefix(secret: string) {
  return secret.replace(/[^A-Za-z0-9_]/g, "a").slice(0, 8);
}

async function writeOrgoSecrets(driver: IncusDriver, instance: string, secret: string | null) {
  const contents = secret ? Buffer.from(`export ORGO_API_KEY='${secret}'\n`) : Buffer.from("");
  await driver.writeFile(instance, "/root/.orgo-secrets.env", contents, 0o600);
}

function dropComputerKey(file: PlaneFile, computerId: string) {
  for (const [keyId, key] of Object.entries(file.keys)) {
    if (key.computerId === computerId) delete file.keys[keyId];
  }
}

function sshView(bindHost: string, ssh: PlaneFile["ssh"][string] | undefined) {
  if (!ssh?.enabled) {
    return {
      enabled: false as const,
      authorized_key_set: false,
      ipv4_host: null,
      ipv4_port: null,
      ssh_user: null,
      ssh_command: null,
    };
  }
  if (ssh.hostPort === null) {
    return {
      enabled: true as const,
      authorized_key_set: false,
      ipv4_host: null,
      ipv4_port: null,
      ssh_user: null,
      ssh_command: null,
    };
  }
  const port = ssh.hostPort > 0 ? ssh.hostPort : null;
  return {
    enabled: true as const,
    authorized_key_set: true,
    ipv4_host: bindHost,
    ipv4_port: port,
    ssh_user: "root" as const,
    ssh_command: port !== null ? `ssh root@${bindHost} -p ${port}` : null,
  };
}

async function writeSshIfPending(store: Store, driver: IncusDriver, computerId: string, instance: string) {
  const state = await store.read();
  if ("error" in state) return;
  const ssh = state.ssh[computerId];
  if (!ssh?.enabled || !ssh.publicKey || ssh.hostPort !== null) return;
  await driver.writeFile(instance, "/root/.ssh/authorized_keys", Buffer.from(`${ssh.publicKey}\n`), 0o600);
  const port = await driver.sshPort(instance);
  await store.update((file) => {
    const row = file.ssh[computerId];
    if (row) row.hostPort = port ?? 0;
  });
}

async function requireReady(store: Store, driver: IncusDriver, res: ServerResponse): Promise<PlaneFile | null> {
  const state = await store.read();
  if ("error" in state) {
    sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
    return null;
  }
  try {
    await driver.version();
  } catch {
    sendJson(res, 503, { code: "incus_down", error: "incus down" });
    return null;
  }
  return state;
}

export function view(computer: Computer) {
  return {
    id: computer.id,
    name: computer.name,
    status: computer.status,
    vnc_password: computer.vncPassword,
    workspace_id: computer.workspaceId,
    project_id: computer.workspaceId,
    cpu: computer.cpu,
    ram: computer.ramMb / 1024,
    os: "linux" as const,
    instance_details: { webrtc: false },
  };
}

function removeComputerRows(file: PlaneFile, id: string) {
  delete file.computers[id];
  for (const [keyId, key] of Object.entries(file.keys)) {
    if (key.computerId === id) delete file.keys[keyId];
  }
  delete file.activity[id];
  delete file.computerEgress[id];
  delete file.ssh[id];
}

export async function computerRoutes(
  store: Store,
  driver: IncusDriver,
  actor: Actor,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  bindHost: string,
  now: () => number,
): Promise<number | null> {
  if (path === "/api/computers") {
    if (method !== "POST") return null;
    if (actor.kind === "computer") {
      sendJson(res, 401, { error: "unauthorized" });
      return 401;
    }
    const state = await requireReady(store, driver, res);
    if (!state) return 503;
    const body = await readJson(req);
    const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : "";
    const name = typeof body.name === "string" ? body.name : "";
    const templateRef = typeof body.template_ref === "string" ? body.template_ref : "";
    if (!workspaceId || !name || !templateRef) throw new HttpError(400, "bad body");
    if (templateRef !== "bops-base") throw new HttpError(400, "unknown template");
    if (!state.workspaces[workspaceId]) {
      sendJson(res, 404, { error: "not found" });
      return 404;
    }
    if (nameTaken(state, name)) throw new HttpError(409, "name taken");
    const ramGb = typeof body.ram === "number" ? body.ram : 16;
    const ramMb = ramGb * 1024;
    const cpu = 4;
    const diskGb = 80;
    const free = await driver.free();
    if (free.ramMb < ramMb || free.diskGb < diskGb) {
      sendJson(res, 409, {
        code: "host_full",
        error: "host full",
        free_ram_mb: free.ramMb,
        free_disk_gb: free.diskGb,
      });
      return 409;
    }
    const id = newComputerId();
    const { instance } = await driver.create({ name, image: "bops-base", cpu, ramMb, diskGb });
    await driver.start(instance);
    const computer: Computer = {
      id,
      name,
      workspaceId,
      instance,
      status: "running",
      vncPassword: newVncPassword(),
      cpu,
      ramMb,
      diskGb,
      screens: [...SCREENS],
    };
    await store.update((file) => {
      file.computers[id] = computer;
    });
    sendJson(res, 200, { id, name, status: "running" as const });
    return 200;
  }

  const parsed = parseComputerPath(path);
  if (!parsed) return null;
  const computerId = parsed.id;

  if (parsed.sub === null) {
    if (method === "GET") {
      if (actor.kind === "computer") {
        sendJson(res, 401, { error: "unauthorized" });
        return 401;
      }
      const state = await requireReady(store, driver, res);
      if (!state) return 503;
      const computer = state.computers[computerId];
      if (!computer) {
        sendJson(res, 404, { error: "not found" });
        return 404;
      }
      sendJson(res, 200, view(computer));
      return 200;
    }

    if (method === "DELETE") {
      if (actor.kind === "computer") {
        sendJson(res, 401, { error: "unauthorized" });
        return 401;
      }
      const state = await store.read();
      if ("error" in state) {
        sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
        return 503;
      }
      const computer = state.computers[computerId];
      if (!computer) {
        sendJson(res, 404, { error: "not found" });
        return 404;
      }
      await driver.delete(computer.instance);
      await store.update((file) => {
        removeComputerRows(file, computerId);
      });
      sendJson(res, 200, { deleted: true });
      return 200;
    }

    return null;
  }

  const extraSubs = new Set(["orgo-key", "fork", "clone", "resize", "webrtc", "ssh"]);
  if (extraSubs.has(parsed.sub ?? "")) {
    if (actor.kind === "computer") {
      sendJson(res, 401, { error: "unauthorized" });
      return 401;
    }

    if (parsed.sub === "fork" && method === "POST") {
      const forkState = await store.read();
      if ("error" in forkState) {
        sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
        return 503;
      }
      if (!resolveComputer(forkState, computerId)) {
        sendJson(res, 404, { error: "not found" });
        return 404;
      }
      sendJson(res, 409, { code: "live_fork_unavailable", error: "live fork unavailable" });
      return 409;
    }

    const state = await requireReady(store, driver, res);
    if (!state) return 503;
    const resolved = resolveComputer(state, computerId);
    if (!resolved) {
      sendJson(res, 404, { error: "not found" });
      return 404;
    }
    const { id: resolvedId, computer } = resolved;

    if (parsed.sub === "webrtc" && method === "POST") {
      sendJson(res, 200, { webrtc: false });
      return 200;
    }

    if (parsed.sub === "ssh") {
      if (method === "GET") {
        sendJson(res, 200, sshView(bindHost, state.ssh[resolvedId]));
        return 200;
      }
      if (method === "POST") {
        const body = await readJson(req);
        const publicKey = typeof body.public_key === "string" ? body.public_key : "";
        if (!publicKey) throw new HttpError(400, "bad body");
        await store.update((file) => {
          file.ssh[resolvedId] = { enabled: true, publicKey, hostPort: null };
        });
        sendJson(res, 200, { enabled: true, pending: true });
        return 200;
      }
      return null;
    }

    if (parsed.sub === "resize") {
      if (method === "GET") {
        const free = await driver.free();
        sendJson(res, 200, {
          current_disk_gb: computer.diskGb,
          max_disk_gb: computer.diskGb + free.diskGb,
        });
        return 200;
      }
      if (method === "PATCH") {
        const body = await readJson(req);
        if (typeof body.disk_size_gb !== "number") {
          const size = typeof body.size === "string" ? body.size : "";
          sendJson(res, 200, { size, changed: false, restarted: false });
          return 200;
        }
        const free = await driver.free();
        const maxDisk = computer.diskGb + free.diskGb;
        if (body.disk_size_gb > maxDisk) {
          sendJson(res, 409, {
            code: "disk_full",
            current_disk_gb: computer.diskGb,
            max_disk_gb: maxDisk,
          });
          return 409;
        }
        await driver.resizeDisk(computer.instance, body.disk_size_gb);
        await store.update((file) => {
          file.computers[resolvedId].diskGb = body.disk_size_gb;
        });
        sendJson(res, 200, { disk_gb: body.disk_size_gb });
        return 200;
      }
      return null;
    }

    if (parsed.sub === "clone" && method === "POST") {
      const body = await readJson(req);
      const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : "";
      if (!workspaceId || !state.workspaces[workspaceId]) {
        sendJson(res, 404, { error: "not found" });
        return 404;
      }
      const free = await driver.free();
      if (free.ramMb < computer.ramMb || free.diskGb < computer.diskGb) {
        sendJson(res, 409, {
          code: "host_full",
          error: "host full",
          free_ram_mb: free.ramMb,
          free_disk_gb: free.diskGb,
        });
        return 409;
      }
      const name =
        typeof body.name === "string" && body.name.length > 0 ? body.name : uniqueName(state, computer.name);
      if (nameTaken(state, name)) throw new HttpError(409, "name taken");
      const { instance } = await driver.clone(computer.instance, name);
      await driver.start(instance);
      const id = newComputerId();
      const cloneComputer: Computer = {
        id,
        name,
        workspaceId,
        instance,
        status: "running",
        vncPassword: newVncPassword(),
        cpu: computer.cpu,
        ramMb: computer.ramMb,
        diskGb: computer.diskGb,
        screens: [...computer.screens],
      };
      await store.update((file) => {
        file.computers[id] = cloneComputer;
      });
      sendJson(res, 200, { id, name, status: "running" as const });
      return 200;
    }

    if (parsed.sub === "orgo-key") {
      try {
        if (method === "GET") {
          const key = computerStoredKey(state, resolvedId);
          if (!key) {
            sendJson(res, 404, { code: "key_not_found", error: "key not found" });
            return 404;
          }
          sendJson(res, 200, {
            keyId: key.keyId,
            prefix: key.prefix,
            name: key.name,
            createdAt: key.createdAt,
            lastUsed: key.lastUsed,
            expiresAt: key.expiresAt,
          });
          return 200;
        }

        if (method === "DELETE") {
          const key = computerStoredKey(state, resolvedId);
          if (!key) {
            sendJson(res, 404, { code: "key_not_found", error: "key not found" });
            return 404;
          }
          if (computer.status === "running") {
            await writeOrgoSecrets(driver, computer.instance, null);
          }
          await store.update((file) => {
            delete file.keys[key.keyId];
          });
          sendJson(res, 200, { deleted: true });
          return 200;
        }

        if (method === "PUT") {
          await needsGuest(store, computer, driver, "action");
          const secret = randomBytes(32).toString("base64url");
          const keyId = randomBytes(8).toString("hex");
          const record: StoredKey = {
            keyId,
            computerId: resolvedId,
            hash: sha256(secret),
            prefix: keyPrefix(secret),
            name: `Computer key for ${computer.name}`,
            createdAt: new Date(now()).toISOString(),
            lastUsed: null,
            expiresAt: null,
          };
          await store.update((file) => {
            dropComputerKey(file, resolvedId);
            file.keys[keyId] = record;
          });
          const after = await store.read();
          if ("error" in after) throw new HttpError(503, "state unreadable", { code: "state_unreadable" });
          const current = after.computers[resolvedId]!;
          if (current.status === "running") {
            await writeOrgoSecrets(driver, current.instance, secret);
          }
          sendJson(res, 200, { keyId });
          return 200;
        }
      } catch (e) {
        if (e instanceof ResumeInProgress) return resumeInProgress(res);
        throw e;
      }
      return null;
    }

    return null;
  }

  if (actor.kind === "computer") {
    sendJson(res, 401, { error: "unauthorized" });
    return 401;
  }

  const guestActions = new Set(["bash", "click", "type", "key", "screenshot", "screens", "resume", "restart"]);
  const screenRoute = parsed.sub === "screens" || (parsed.sub?.startsWith("screens/") ?? false);
  if (!guestActions.has(parsed.sub ?? "") && !screenRoute) return null;

  const state = await requireReady(store, driver, res);
  if (!state) return 503;
  const computer = state.computers[computerId];
  if (!computer) {
    sendJson(res, 404, { error: "not found" });
    return 404;
  }

  try {
    if (parsed.sub === "resume" && method === "POST") {
      if (computer.status === "running") {
        sendJson(res, 200, { status: "running" });
        return 200;
      }
      if (computer.status === "suspended") {
        await driver.start(computer.instance);
        await store.update((file) => {
          file.computers[computerId].status = "running";
        });
        await writeSshIfPending(store, driver, computerId, computer.instance);
        sendJson(res, 200, { status: "running" });
        return 200;
      }
      throw new HttpError(409, "not suspended");
    }

    if (parsed.sub === "restart" && method === "POST") {
      await needsGuest(store, computer, driver, "action");
      await driver.restart(computer.instance);
      sendJson(res, 200, { restarted: true });
      return 200;
    }

    if (parsed.sub === "bash" && method === "POST") {
      await needsGuest(store, computer, driver, "action");
      const body = await readJson(req);
      const command = typeof body.command === "string" ? body.command : "";
      const timeout = typeof body.timeout === "number" ? body.timeout : 30;
      const result = await driver.exec(computer.instance, command, timeout);
      sendJson(res, 200, { exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr });
      return 200;
    }

    if ((parsed.sub === "click" || parsed.sub === "type" || parsed.sub === "key") && method === "POST") {
      await needsGuest(store, computer, driver, "action");
      const body = await readJson(req);
      const screen = screenFrom(req);
      await driver.input(computer.instance, parsed.sub, body, screen);
      sendJson(res, 200, { ok: true });
      return 200;
    }

    if (parsed.sub === "screenshot" && method === "GET") {
      await needsGuest(store, computer, driver, "screenshot");
      const screen = screenFrom(req);
      const { format, scale } = screenshotOpts(req);
      const bytes = await driver.screenshot(computer.instance, screen, format, scale);
      const contentType = format === "png" ? "image/png" : "image/jpeg";
      sendBytes(res, 200, bytes, contentType);
      return 200;
    }

    if (parsed.sub === "screens" && method === "GET") {
      await needsGuest(store, computer, driver, "screenshot");
      sendJson(res, 200, { screens: computer.screens });
      return 200;
    }

    if (parsed.sub === "screens" && method === "POST") {
      await needsGuest(store, computer, driver, "action");
      const stateAfter = await store.read();
      if ("error" in stateAfter) throw new HttpError(503, "state unreadable", { code: "state_unreadable" });
      const current = stateAfter.computers[computerId]!;
      if (current.screens.length >= SCREENS.length) {
        sendJson(res, 409, { error: "four displays" });
        return 409;
      }
      const next = SCREENS.find((id) => !current.screens.includes(id));
      if (!next) {
        sendJson(res, 409, { error: "four displays" });
        return 409;
      }
      await store.update((file) => {
        file.computers[computerId].screens.push(next);
      });
      sendJson(res, 200, { id: next, default: next === "default" });
      return 200;
    }

    const screenParts = parsed.sub?.match(/^screens\/([^/]+)$/) ?? null;
    if (screenParts && method === "DELETE") {
      const screenId = screenParts[1] as ScreenId;
      await needsGuest(store, computer, driver, "action");
      if (screenId === "default") {
        sendJson(res, 409, { error: "cannot delete default" });
        return 409;
      }
      const stateAfter = await store.read();
      if ("error" in stateAfter) throw new HttpError(503, "state unreadable", { code: "state_unreadable" });
      const current = stateAfter.computers[computerId]!;
      if (!current.screens.includes(screenId)) {
        sendJson(res, 404, { error: "not found" });
        return 404;
      }
      await store.update((file) => {
        file.computers[computerId].screens = file.computers[computerId].screens.filter((s) => s !== screenId);
      });
      sendJson(res, 200, { deleted: true });
      return 200;
    }

    if (screenParts && screenParts[1] === "default" && method === "PATCH") {
      const body = await readJson(req);
      const width = typeof body.width === "number" ? body.width : 0;
      const height = typeof body.height === "number" ? body.height : 0;
      if (!width || !height) throw new HttpError(400, "bad body");
      sendJson(res, 200, { id: "default", width, height, default: true, display: ":99" });
      return 200;
    }
  } catch (e) {
    if (e instanceof ResumeInProgress) return resumeInProgress(res);
    throw e;
  }

  return null;
}

export function purgeWorkspaceComputers(file: PlaneFile, workspaceId: string) {
  for (const [id, computer] of Object.entries(file.computers)) {
    if (computer.workspaceId === workspaceId) removeComputerRows(file, id);
  }
}