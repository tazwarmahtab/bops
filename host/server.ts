import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Duplex } from "node:net";
import { who } from "./auth.ts";
import type { IncusDriver } from "./incus.ts";
import { HttpError, sendJson } from "./http.ts";
import { closedRoutes } from "./routes/closed.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { computerRoutes } from "./routes/computers.ts";
import { workspaceRoutes } from "./routes/workspaces.ts";
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
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    void handleUpgrade(running, req, socket, head);
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

function denyUpgrade(socket: Duplex, status: number, reason: string) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function acceptWebsocket(req: IncomingMessage, socket: Duplex) {
  const key = req.headers["sec-websocket-key"];
  if (!key || typeof key !== "string") {
    denyUpgrade(socket, 400, "Bad Request");
    return;
  }
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.end();
}

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect({ host: "127.0.0.1", port });
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
    probe.setTimeout(250, () => {
      probe.destroy();
      resolve(false);
    });
  });
}

async function handleUpgrade(opts: RunningOpts, req: IncomingMessage, socket: Duplex, head: Buffer) {
  const started = Date.now();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const template = "/desktops/{id}/ws/websockify";
  let status = 404;
  let computerId: string | null = null;
  try {
    const m = url.pathname.match(/^\/desktops\/([^/]+)\/ws\/websockify$/);
    if (!m) {
      denyUpgrade(socket, 404, "Not Found");
      return;
    }
    computerId = m[1];
    const token = url.searchParams.get("token") ?? "";
    const screen = url.searchParams.get("screen");
    const screenId = screen && screen.length > 0 ? screen : "default";
    const state = await opts.store.read();
    if ("error" in state) {
      status = 503;
      denyUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    const computer = state.computers[computerId];
    if (!computer) {
      denyUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!token || token !== computer.vncPassword) {
      status = 401;
      denyUpgrade(socket, 401, "Unauthorized");
      return;
    }
    const port = await opts.driver.vncPort(computer.instance, screenId);
    if (await portListening(port)) {
      status = 101;
      const remote = connect({ host: "127.0.0.1", port });
      remote.once("connect", () => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined) continue;
          lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
        }
        lines.push("", "");
        remote.write(lines.join("\r\n"));
        if (head.length) remote.write(head);
        remote.pipe(socket);
        socket.pipe(remote);
        remote.once("error", () => {
          socket.destroy();
          remote.destroy();
        });
        socket.once("error", () => {
          socket.destroy();
          remote.destroy();
        });
        remote.once("close", () => socket.destroy());
        socket.once("close", () => remote.destroy());
      });
      remote.once("error", () => acceptWebsocket(req, socket));
      return;
    }
    acceptWebsocket(req, socket);
    status = 101;
  } finally {
    logLine(req.method ?? "GET", template, status, Date.now() - started, computerId);
  }
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
    const actorFile = "error" in state ? emptyFile() : state;
    const actor = who(token, opts.accountKey, actorFile);
    if (!actor) {
      status = 401;
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const workspaceStatus = await workspaceRoutes(
      opts.store,
      opts.driver,
      actor,
      req.method ?? "GET",
      url.pathname,
      req,
      res,
    );
    if (workspaceStatus !== null) {
      status = workspaceStatus;
      return;
    }

    const computerStatus = await computerRoutes(
      opts.store,
      opts.driver,
      actor,
      req.method ?? "GET",
      url.pathname,
      req,
      res,
    );
    if (computerStatus !== null) {
      status = computerStatus;
      return;
    }

    if (actor.kind === "computer") {
      status = 401;
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    const closed = closedRoutes(req.method ?? "GET", url.pathname);
    if (closed) {
      status = closed.status;
      sendJson(res, closed.status, closed.body);
      return;
    }

    const settingsStatus = await settingsRoutes(opts.store, req.method ?? "GET", url.pathname, req, res);
    if (settingsStatus !== null) {
      status = settingsStatus;
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