import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../auth.ts";
import { readJson, sendJson } from "../http.ts";

export async function sizeRoutes(
  actor: Actor,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<number | null> {
  if (path !== "/api/bops/computer/size") return null;
  if (method !== "POST") return null;
  if (actor.kind === "computer") {
    sendJson(res, 401, { error: "unauthorized" });
    return 401;
  }
  const body = await readJson(req);
  const size = typeof body.size === "string" ? body.size : "";
  sendJson(res, 200, { size, changed: false, restarted: false });
  return 200;
}