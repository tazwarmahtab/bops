import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../auth.ts";
import { HttpError, readJson, sendJson } from "../http.ts";
import type { IncusDriver } from "../incus.ts";
import type { Computer, PlaneFile, ScreenId, Store } from "../state.ts";

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

  if (actor.kind === "computer") {
    sendJson(res, 401, { error: "unauthorized" });
    return 401;
  }

  const guestActions = new Set(["bash", "click", "type", "key", "screenshot", "screens", "resume", "restart"]);
  if (!guestActions.has(parsed.sub)) return null;

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