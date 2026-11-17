import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../auth.ts";
import { HttpError, readJson, sendJson } from "../http.ts";
import type { PlaneFile, Store } from "../state.ts";

const PAIRING_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function requireAccount(actor: Actor) {
  if (actor.kind === "computer") throw new HttpError(401, "unauthorized");
}

function pairingCode() {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += PAIRING_ALPHABET[bytes[i]! % PAIRING_ALPHABET.length];
  return out;
}

function deviceId() {
  return randomBytes(8).toString("hex");
}

function upstreamBody(file: PlaneFile, computerId: string) {
  const stored = file.computerEgress[computerId];
  if (!stored) {
    return { mode: "residential" as const, device_id: null, proxy_on: false as const };
  }
  const mode = stored.mode === "direct" ? ("residential" as const) : ("device" as const);
  return { mode, device_id: stored.deviceId, proxy_on: stored.proxyOn };
}

function parseComputerEgress(path: string) {
  const upstream = path.match(/^\/api\/computers\/([^/]+)\/egress\/upstream$/);
  if (upstream) return { kind: "upstream" as const, id: upstream[1]! };
  const proxy = path.match(/^\/api\/computers\/([^/]+)\/residential-proxy$/);
  if (proxy) return { kind: "proxy" as const, id: proxy[1]! };
  return null;
}

export async function egressRoutes(
  store: Store,
  actor: Actor,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<number | null> {
  if (path === "/api/egress-devices") {
    requireAccount(actor);
    if (method === "GET") {
      const state = await store.read();
      if ("error" in state) {
        sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
        return 503;
      }
      const devices = Object.values(state.egressDevices).map((d) => ({
        id: d.id,
        name: d.name,
        online: null,
      }));
      const rendezvous = process.env.BOPS_HEADSCALE_URL ?? null;
      sendJson(res, 200, { devices, rendezvous });
      return 200;
    }
    if (method === "POST") {
      const body = await readJson(req);
      const name = typeof body.name === "string" ? body.name : "";
      if (!name) throw new HttpError(400, "name required");
      const id = deviceId();
      const code = pairingCode();
      await store.update((file) => {
        file.egressDevices[id] = { id, name, pairingCode: code };
      });
      sendJson(res, 200, { id, name, pairing_code: code });
      return 200;
    }
    return null;
  }

  const computerPath = parseComputerEgress(path);
  if (!computerPath) return null;

  requireAccount(actor);
  const state = await store.read();
  if ("error" in state) {
    sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
    return 503;
  }
  const computer = state.computers[computerPath.id];
  if (!computer) {
    sendJson(res, 404, { error: "not found" });
    return 404;
  }

  if (computerPath.kind === "upstream") {
    if (method === "GET") {
      sendJson(res, 200, upstreamBody(state, computerPath.id));
      return 200;
    }
    if (method === "POST") {
      const body = await readJson(req);
      const mode = body.mode;
      if (mode === "residential") {
        await store.update((file) => {
          file.computerEgress[computerPath.id] = { mode: "direct", deviceId: null, proxyOn: false };
        });
        sendJson(res, 200, { proxy_on: false });
        return 200;
      }
      if (mode === "device") {
        const device_id = typeof body.device_id === "string" ? body.device_id : "";
        if (!device_id || !state.egressDevices[device_id]) {
          throw new HttpError(400, "unknown device");
        }
        await store.update((file) => {
          file.computerEgress[computerPath.id] = { mode: "device", deviceId: device_id, proxyOn: false };
        });
        sendJson(res, 200, { proxy_on: false });
        return 200;
      }
      throw new HttpError(400, "bad mode");
    }
    return null;
  }

  if (computerPath.kind === "proxy" && method === "POST") {
    const body = await readJson(req);
    if (body.enabled === true) {
      sendJson(res, 409, { code: "residential_unavailable", error: "residential unavailable" });
      return 409;
    }
    if (body.enabled !== false) throw new HttpError(400, "bad enabled");
    sendJson(res, 200, { proxy_on: false });
    return 200;
  }

  return null;
}