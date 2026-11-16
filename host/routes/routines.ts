import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../auth.ts";
import { HttpError, readBody, readJson, sendJson } from "../http.ts";
import type { Store } from "../state.ts";

function requireAccount(actor: Actor) {
  if (actor.kind === "computer") throw new HttpError(401, "unauthorized");
}

function routinesOf(file: { routines: Record<string, { projectId: string; routineId: string; nextRunAt: number | null; onMac: boolean; run: string }> }, projectId: string) {
  return Object.values(file.routines)
    .filter((item) => item.projectId === projectId)
    .map((item) => ({ id: item.routineId, nextRunAt: item.nextRunAt, onMac: item.onMac, run: item.run }));
}

export async function routineRoutes(
  store: Store,
  actor: Actor,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
  now: () => number,
): Promise<number | null> {
  if (path === "/api/bops/computer/active" && method === "POST") {
    const body = await readJson(req);
    const via = body.via === "runner" ? "runner" : null;
    const at = now();
    await store.update((file) => {
      if (actor.kind === "account") {
        for (const id of Object.keys(file.computers)) {
          file.activity[id] = { at, via };
        }
      } else {
        file.activity[actor.computerId] = { at, via };
      }
    });
    sendJson(res, 200, { ok: true });
    return 200;
  }

  const routinesMatch = path.match(/^\/api\/projects\/([^/]+)\/routines$/);
  if (routinesMatch) {
    const projectId = routinesMatch[1];
    requireAccount(actor);
    if (method === "PUT") {
      const raw = await readBody(req, 1024 * 1024);
      let list: unknown;
      try {
        list = JSON.parse(raw.length ? raw.toString("utf8") : "[]");
      } catch {
        throw new HttpError(400, "body isn't json");
      }
      if (!Array.isArray(list)) throw new HttpError(400, "body isn't json");
      await store.update((file) => {
        for (const key of Object.keys(file.routines)) {
          if (file.routines[key].projectId === projectId) delete file.routines[key];
        }
        for (const item of list) {
          if (!item || typeof item !== "object" || Array.isArray(item)) continue;
          const row = item as Record<string, unknown>;
          const id = typeof row.id === "string" ? row.id : null;
          if (!id) continue;
          file.routines[`${projectId}/${id}`] = {
            projectId,
            routineId: id,
            nextRunAt: typeof row.nextRunAt === "number" ? row.nextRunAt : null,
            onMac: row.onMac === true,
            run: typeof row.run === "string" ? row.run : "",
          };
        }
      });
      sendJson(res, 200, list);
      return 200;
    }
    if (method === "GET") {
      const state = await store.read();
      if ("error" in state) {
        sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
        return 503;
      }
      sendJson(res, 200, routinesOf(state, projectId));
      return 200;
    }
    return null;
  }

  const routineOne = path.match(/^\/api\/projects\/([^/]+)\/routines\/([^/]+)$/);
  if (routineOne && method === "DELETE") {
    const projectId = routineOne[1];
    const routineId = routineOne[2];
    requireAccount(actor);
    const key = `${projectId}/${routineId}`;
    const state = await store.read();
    if ("error" in state) {
      sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
      return 503;
    }
    if (!state.routines[key]) {
      sendJson(res, 404, { error: "not found" });
      return 404;
    }
    await store.update((file) => {
      delete file.routines[key];
    });
    sendJson(res, 200, { ok: true });
    return 200;
  }

  const runsMatch = path.match(/^\/api\/projects\/([^/]+)\/routines\/([^/]+)\/runs$/);
  if (runsMatch) {
    const projectId = runsMatch[1];
    const routineId = runsMatch[2];
    const key = `${projectId}/${routineId}`;
    requireAccount(actor);
    if (method === "POST") {
      const state = await store.read();
      if ("error" in state) {
        sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
        return 503;
      }
      if (!state.routines[key]) {
        sendJson(res, 404, { error: "not found" });
        return 404;
      }
      const raw = await readBody(req, 1024 * 1024);
      let body: unknown = {};
      try {
        body = JSON.parse(raw.length ? raw.toString("utf8") : "{}");
      } catch {
        throw new HttpError(400, "body isn't json");
      }
      await store.update((file) => {
        file.runs[key] = { id: key, routineId, projectId, body };
      });
      sendJson(res, 200, body);
      return 200;
    }
    if (method === "GET") {
      const state = await store.read();
      if ("error" in state) {
        sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
        return 503;
      }
      if (!state.routines[key]) {
        sendJson(res, 404, { error: "not found" });
        return 404;
      }
      const stored = state.runs[key];
      sendJson(res, 200, stored?.body ?? {});
      return 200;
    }
    return null;
  }

  const bopsMatch = path.match(/^\/api\/projects\/([^/]+)\/bops$/);
  if (bopsMatch) {
    const projectId = bopsMatch[1];
    requireAccount(actor);
    if (method === "PUT") {
      const raw = await readBody(req, 1024 * 1024);
      let body: unknown = {};
      try {
        body = JSON.parse(raw.length ? raw.toString("utf8") : "{}");
      } catch {
        throw new HttpError(400, "body isn't json");
      }
      await store.update((file) => {
        file.bops[projectId] = body;
      });
      sendJson(res, 200, body);
      return 200;
    }
    if (method === "GET") {
      const state = await store.read();
      if ("error" in state) {
        sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
        return 503;
      }
      const value = state.bops[projectId];
      sendJson(res, 200, value === undefined ? {} : value);
      return 200;
    }
    return null;
  }

  return null;
}