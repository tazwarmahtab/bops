import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "../auth.ts";
import { HttpError, readBody, readJson, sendJson } from "../http.ts";
import type { IncusDriver } from "../incus.ts";
import type { Computer, Store } from "../state.ts";

class ResumeInProgress extends Error {}

function resumeInProgress(res: ServerResponse) {
  sendJson(res, 409, { error: "resume in progress", code: "resume_in_progress" }, { "Retry-After": "2" });
  return 409;
}

async function needsGuest(
  store: Store,
  computer: Computer,
  driver: IncusDriver,
): Promise<void> {
  const { status, id, instance } = computer;
  if (status === "stopped" || status === "error") {
    throw new HttpError(409, "not suspended");
  }
  if (status === "suspended") {
    await store.update((file) => {
      file.computers[id].status = "resuming";
    });
    try {
      await driver.start(instance);
    } catch {
      await store.update((file) => {
        file.computers[id].status = "suspended";
      });
      throw new HttpError(503, "incus down", { code: "incus_down" });
    }
    await store.update((file) => {
      file.computers[id].status = "running";
    });
    throw new ResumeInProgress();
  }
  if (status === "starting" || status === "resuming" || status === "suspending") {
    throw new ResumeInProgress();
  }
  if (status === "running") return;
  throw new HttpError(409, "not suspended");
}

function uploadOrigin() {
  const origin = process.env.BOPS_UPLOAD_ORIGIN ?? "";
  return origin.startsWith("https://") ? origin.replace(/\/$/, "") : null;
}

function newUploadToken() {
  return randomBytes(16).toString("base64url");
}

export async function handleUploadPut(
  store: Store,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<number> {
  const state = await store.read();
  if ("error" in state) {
    sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
    return 503;
  }
  const upload = state.uploads[token];
  if (!upload) {
    sendJson(res, 404, { error: "not found" });
    return 404;
  }
  const cap = Math.max(upload.sizeBytes, 0) + 1;
  const body = await readBody(req, cap > 1 ? cap : 1);
  if (body.length !== upload.sizeBytes) {
    sendJson(res, 400, { error: "size mismatch" });
    return 400;
  }
  await store.update((file) => {
    const row = file.uploads[token];
    if (!row) return;
    row.received = true;
    row.bytes = body.toString("base64");
  });
  sendJson(res, 200, { ok: true });
  return 200;
}

export async function filesRoutes(
  store: Store,
  driver: IncusDriver,
  actor: Actor,
  method: string,
  path: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<number | null> {
  if (path === "/api/files/uploads" && method === "POST") {
    if (actor.kind === "computer") {
      sendJson(res, 401, { error: "unauthorized" });
      return 401;
    }
    const origin = uploadOrigin();
    if (!origin) {
      sendJson(res, 409, { code: "upload_needs_https", error: "upload needs https" });
      return 409;
    }
    const body = await readJson(req);
    const desktopId = typeof body.desktopId === "string" ? body.desktopId : "";
    const filename = typeof body.filename === "string" ? body.filename : "";
    const size_bytes = typeof body.size_bytes === "number" ? body.size_bytes : -1;
    const destPath = typeof body.destPath === "string" ? body.destPath : "";
    if (!desktopId || !filename || !destPath || size_bytes < 0) {
      throw new HttpError(400, "bad body");
    }
    const state = await store.read();
    if ("error" in state) {
      sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
      return 503;
    }
    if (!state.computers[desktopId]) {
      sendJson(res, 404, { error: "not found" });
      return 404;
    }
    const token = newUploadToken();
    await store.update((file) => {
      file.uploads[token] = {
        token,
        desktopId,
        destPath,
        sizeBytes: size_bytes,
        received: false,
        bytes: "",
      };
    });
    sendJson(res, 200, {
      upload_url: `${origin}/api/files/uploads/${token}`,
      upload_token: token,
    });
    return 200;
  }

  if (path === "/api/files/uploads/complete" && method === "POST") {
    if (actor.kind === "computer") {
      sendJson(res, 401, { error: "unauthorized" });
      return 401;
    }
    const body = await readJson(req);
    const desktopId = typeof body.desktopId === "string" ? body.desktopId : "";
    const upload_token = typeof body.upload_token === "string" ? body.upload_token : "";
    if (!desktopId || !upload_token) {
      throw new HttpError(400, "bad body");
    }
    const state = await store.read();
    if ("error" in state) {
      sendJson(res, 503, { code: "state_unreadable", error: "state unreadable" });
      return 503;
    }
    const upload = state.uploads[upload_token];
    if (!upload || upload.desktopId !== desktopId) {
      throw new HttpError(404, "not found");
    }
    if (!upload.received) {
      sendJson(res, 409, { error: "incomplete upload" });
      return 409;
    }
    const computer = state.computers[desktopId];
    if (!computer) {
      sendJson(res, 404, { error: "not found" });
      return 404;
    }
    try {
      await needsGuest(store, computer, driver);
      const contents = Buffer.from(upload.bytes, "base64");
      await driver.writeFile(computer.instance, upload.destPath, contents, 0o644);
      await store.update((file) => {
        delete file.uploads[upload_token];
      });
      sendJson(res, 200, { ok: true });
      return 200;
    } catch (e) {
      if (e instanceof ResumeInProgress) return resumeInProgress(res);
      throw e;
    }
  }

  return null;
}