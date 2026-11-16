import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { IncusDriver } from "./incus.ts";
import { HttpError, sendJson } from "./http.ts";
import { logLine } from "./log.ts";

export type StartOpts = {
  driver: IncusDriver;
  statePath: string;
  now: () => number;
  host: string;
  port: number;
  accountKey: string;
};

export function start(opts: StartOpts) {
  const server = createServer((req, res) => {
    void handle(opts, req, res);
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

async function handle(opts: StartOpts, req: IncomingMessage, res: ServerResponse) {
  const started = Date.now();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  let status = 500;
  let template = url.pathname;
  try {
    if (req.method === "GET" && url.pathname === "/health") {
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
    if (!token || token !== opts.accountKey) {
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