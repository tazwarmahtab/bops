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

function computerIdFrom(path: string) {
  const m = path.match(/^\/api\/computers\/([^/]+)$/);
  return m?.[1] ?? null;
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

  const computerId = computerIdFrom(path);
  if (!computerId) return null;

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

export function purgeWorkspaceComputers(file: PlaneFile, workspaceId: string) {
  for (const [id, computer] of Object.entries(file.computers)) {
    if (computer.workspaceId === workspaceId) removeComputerRows(file, id);
  }
}