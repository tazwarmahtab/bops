import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../auth.ts";
import { HttpError, readJson, sendJson } from "../http.ts";
import type { IncusDriver } from "../incus.ts";
import type { PlaneFile, Store } from "../state.ts";

const MEMBERS_BODY = {
  members: [{ id: "local", role: "owner", name: "Local" }],
  invites: [] as [],
};

const EMPTY_PREVIEW = {
  keys: [] as [],
  skills: [] as [],
  apps: [] as [],
  madeApps: [] as [],
  crmFiles: [] as [],
  routines: [] as [],
  orbitIssues: [] as [],
};

function requireAccount(actor: Actor) {
  if (actor.kind === "computer") throw new HttpError(403, "owner only", { code: "owner_only" });
}

function newWorkspaceId() {
  return randomBytes(8).toString("hex");
}

function workspaceIdFrom(path: string) {
  const m = path.match(/^\/api\/workspaces\/([^/]+)/);
  return m?.[1] ?? null;
}

function projectIdFrom(path: string) {
  const m = path.match(/^\/api\/projects\/([^/]+)/);
  return m?.[1] ?? null;
}

function desktops(file: PlaneFile, workspaceId: string) {
  return Object.values(file.computers)
    .filter((c) => c.workspaceId === workspaceId)
    .map((c) => ({ id: c.id, name: c.name }));
}

function findWorkspace(file: PlaneFile, id: string) {
  return file.workspaces[id] ?? null;
}

function nameTaken(file: PlaneFile, name: string, exceptId?: string) {
  return Object.values(file.workspaces).some((ws) => ws.name === name && ws.id !== exceptId);
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

export async function workspaceRoutes(
  store: Store,
  driver: IncusDriver,
  actor: Actor,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<number | null> {
  if (path === "/api/workspaces") {
    if (method === "GET") {
      const state = await requireReady(store, driver, res);
      if (!state) return 503;
      sendJson(res, 200, { workspaces: Object.values(state.workspaces) });
      return 200;
    }
    if (method === "POST") {
      requireAccount(actor);
      const state = await requireReady(store, driver, res);
      if (!state) return 503;
      const body = await readJson(req);
      const name = typeof body.name === "string" ? body.name : "";
      if (!name) throw new HttpError(400, "bad name");
      if (nameTaken(state, name)) throw new HttpError(400, "name taken", { code: "WORKSPACE_NAME_TAKEN" });
      const id = newWorkspaceId();
      await store.update((file) => {
        file.workspaces[id] = { id, name, bopsWsId: null };
      });
      sendJson(res, 200, { id, name, bopsWsId: null });
      return 200;
    }
    return null;
  }

  const wsId = workspaceIdFrom(path);
  if (wsId) {
    const rest = path.slice(`/api/workspaces/${wsId}`.length);

    if (rest === "") {
      if (method === "GET") {
        const state = await requireReady(store, driver, res);
        if (!state) return 503;
        const ws = findWorkspace(state, wsId);
        if (!ws) {
          sendJson(res, 404, { error: "not found" });
          return 404;
        }
        sendJson(res, 200, { id: ws.id, name: ws.name, desktops: desktops(state, wsId) });
        return 200;
      }
      if (method === "PATCH") {
        requireAccount(actor);
        const state = await store.read();
        if ("error" in state) {
          sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
          return 503;
        }
        const ws = findWorkspace(state, wsId);
        if (!ws) {
          sendJson(res, 404, { error: "not found" });
          return 404;
        }
        const body = await readJson(req);
        const name = typeof body.name === "string" ? body.name : undefined;
        const bopsWsId =
          body.bops_ws_id === null || typeof body.bops_ws_id === "string" ? (body.bops_ws_id as string | null) : undefined;
        if (name !== undefined && nameTaken(state, name, wsId)) {
          throw new HttpError(400, "name taken", { code: "WORKSPACE_NAME_TAKEN" });
        }
        await store.update((file) => {
          const row = file.workspaces[wsId];
          if (!row) return;
          if (name !== undefined) row.name = name;
          if (bopsWsId !== undefined) row.bopsWsId = bopsWsId;
        });
        const fresh = await store.read();
        const next = "error" in fresh ? ws : (findWorkspace(fresh, wsId) ?? ws);
        sendJson(res, 200, { id: next.id, name: next.name, bopsWsId: next.bopsWsId });
        return 200;
      }
      return null;
    }

    if (rest === "/delete-preview" && method === "GET") {
      const state = await requireReady(store, driver, res);
      if (!state) return 503;
      const ws = findWorkspace(state, wsId);
      if (!ws) {
        sendJson(res, 404, { error: "not found" });
        return 404;
      }
      sendJson(res, 200, { computers: desktops(state, wsId), ...EMPTY_PREVIEW });
      return 200;
    }

    if (rest === "/members" || rest.startsWith("/invite")) {
      requireAccount(actor);
      const state = await store.read();
      if ("error" in state) {
        sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
        return 503;
      }
      if (!findWorkspace(state, wsId)) {
        sendJson(res, 404, { error: "not found" });
        return 404;
      }
      sendJson(res, 200, MEMBERS_BODY);
      return 200;
    }
  }

  const projectId = projectIdFrom(path);
  if (projectId) {
    const rest = path.slice(`/api/projects/${projectId}`.length);
    if (rest === "/delete" && method === "POST") {
      requireAccount(actor);
      const state = await store.read();
      if ("error" in state) {
        sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
        return 503;
      }
      if (!findWorkspace(state, projectId)) {
        sendJson(res, 404, { error: "not found" });
        return 404;
      }
      await store.update((file) => {
        delete file.workspaces[projectId];
        const gone = new Set<string>();
        for (const [id, computer] of Object.entries(file.computers)) {
          if (computer.workspaceId === projectId) {
            gone.add(id);
            delete file.computers[id];
          }
        }
        for (const [id, key] of Object.entries(file.keys)) {
          if (gone.has(key.computerId)) delete file.keys[id];
        }
      });
      sendJson(res, 200, { success: true });
      return 200;
    }
    if (rest === "/domains") {
      if (method === "GET") {
        const state = await requireReady(store, driver, res);
        if (!state) return 503;
        if (!findWorkspace(state, projectId)) {
          sendJson(res, 404, { error: "not found" });
          return 404;
        }
        sendJson(res, 200, { registrar: false, enabled: false, domains: [] });
        return 200;
      }
      if (method === "POST") {
        sendJson(res, 501, { code: "not_on_this_plane", error: "not on this plane" });
        return 501;
      }
    }
  }

  return null;
}