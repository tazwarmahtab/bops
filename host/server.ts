import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { who } from "./auth.ts";
import type { IncusDriver } from "./incus.ts";
import { HttpError, sendJson } from "./http.ts";
import { logLine } from "./log.ts";
import { emptyFile, openStore, type Store } from "./state.ts";

export type StartOpts = {
  driver: IncusDriver;
  statePath: string;
  now: () => number;
  host: string;
  port: number;
  accountKey: string;
};

type RunningOpts = StartOpts & { store: Store };

export function start(opts: StartOpts) {
  const store = openStore(opts.statePath);
  const running: RunningOpts = { ...opts, store };
  const server = createServer((req, res) => {
    void handle(running, req, res);
  });
  return {
    server,
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(opts.port, opts.host, () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : opts.port);
        });
      }),
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function handle(opts: RunningOpts, req: IncomingMessage, res: ServerResponse) {
  const started = Date.now();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let status = 500;
  let template = url.pathname;
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      const state = await opts.store.read();
      if ("error" in state) {
        status = 503;
        sendJson(res, 503, { ok: false, code: "state_unreadable" });
        return;
      }
      try {
        await opts.driver.version();
        status = 200;
        sendJson(res, 200, { ok: true });
      } catch {
        status = 503;
        sendJson(res, 503, { ok: false, code: "incus_down" });
      }
      return;
    }
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      status = 401;
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/user/profile") {
      const state = await opts.store.read();
      if ("error" in state) {
        status = 503;
        sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
        return;
      }
      const actor = who(token, opts.accountKey, state);
      if (!actor) {
        status = 401;
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }
      if (actor.kind === "account") {
        status = 200;
        sendJson(res, 200, { id: "local", full_name: "Local", api_key: { scope: "account" } });
        return;
      }
      await opts.store.update((file) => {
        const key = file.keys[actor.keyId];
        if (key) key.lastUsed = new Date(opts.now()).toISOString();
      });
      status = 200;
      sendJson(res, 200, { id: "local", api_key: { scope: "computer", computer_id: actor.computerId } });
      return;
    }

    const state = await opts.store.read();
    if ("error" in state) {
      const actor = who(token, opts.accountKey, emptyFile());
      if (actor?.kind === "account") {
        status = 404;
        sendJson(res, 404, { error: "not found" });
        return;
      }
      status = 401;
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    const actor = who(token, opts.accountKey, state);
    if (!actor || actor.kind === "computer") {
      status = 401;
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    status = 404;
    sendJson(res, 404, { error: "not found" });
  } catch (e) {
    if (e instanceof HttpError) {
      status = e.status;
      sendJson(res, e.status, { error: e.message, ...e.extra });
      return;
    }
    status = 500;
    sendJson(res, 500, { error: "internal" });
  } finally {
    logLine(req.method ?? "GET", template, status, Date.now() - started, null);
  }
}