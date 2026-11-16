import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpError, readJson, sendJson } from "../http.ts";
import type { Store } from "../state.ts";

export async function settingsRoutes(
  store: Store,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<number | null> {
  if (path !== "/api/bops/settings") return null;

  if (method === "GET") {
    const state = await store.read();
    if ("error" in state) {
      sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
      return 503;
    }
    sendJson(res, 200, { runsOn: state.settings.runsOn ?? "mac" });
    return 200;
  }

  if (method === "PUT") {
    const state = await store.read();
    if ("error" in state) {
      sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
      return 503;
    }
    const body = await readJson(req);
    const runsOn = body.runsOn;
    if (runsOn !== "cloud" && runsOn !== "mac") {
      throw new HttpError(400, "bad runsOn");
    }
    await store.update((file) => {
      file.settings.runsOn = runsOn;
    });
    sendJson(res, 200, { runsOn });
    return 200;
  }

  return null;
}