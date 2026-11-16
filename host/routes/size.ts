import type { IncomingMessage, ServerResponse } from "node:http";
import { readJson, sendJson } from "../http.ts";

export async function sizeRoutes(
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<number | null> {
  if (path !== "/api/bops/computer/size") return null;
  if (method !== "POST") return null;
  const body = await readJson(req);
  const size = typeof body.size === "string" ? body.size : "";
  sendJson(res, 200, { size, changed: false, restarted: false });
  return 200;
}