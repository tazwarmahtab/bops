import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { test } from "node:test";
import { FakeDriver } from "../incus-fake.ts";
import { openStore } from "../state.ts";
import { withPlane } from "./helpers.ts";

test("a fifth screen is 409 with no code", async () => {
  const plane = await withPlane();
  const ws = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  const workspaceId = (await ws.json()).id;
  const made = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  const id = (await made.json()).id as string;
  const extra = await fetch(`${plane.base}/api/computers/${id}/screens`, { method: "POST", headers: plane.auth });
  assert.equal(extra.status, 409);
  const body = await extra.json();
  assert.equal(body.error, "four displays");
  assert.equal("code" in body, false);
  await plane.close();
});

// Value: protects=websockify accepts the computer vnc password with no account bearer and 404s an unknown desktop; fails_when=a valid token is rejected or a missing desktop upgrades; why_new=only a bad token 401 was tested; seam=none; no_claim=does not cover proxying when the VNC port is open
test("websockify accepts the vnc token without a bearer", async () => {
  const driver = new FakeDriver();
  driver.vncPort = async () => 1;
  const plane = await withPlane({ driver });
  const ws = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  const workspaceId = (await ws.json()).id as string;
  const made = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  const created = (await made.json()) as { id: string };
  const got = await fetch(`${plane.base}/api/computers/${created.id}`, { headers: plane.auth });
  const computer = (await got.json()) as { vnc_password: string };
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const expectAccept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  const upgrade = (url: string) =>
    new Promise<{ status: number; accept: string | null }>((resolve, reject) => {
      const req = request(url, {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": key,
          "sec-websocket-version": "13",
        },
      });
      const finish = (status: number, accept: string | null) => resolve({ status, accept });
      req.setTimeout(2000, () => {
        req.destroy();
        reject(new Error("upgrade timed out"));
      });
      req.on("upgrade", (res, socket) => {
        const accept = res.headers["sec-websocket-accept"];
        socket.destroy();
        finish(101, typeof accept === "string" ? accept : null);
      });
      req.on("response", (res) => {
        res.resume();
        finish(res.statusCode ?? 0, null);
      });
      req.on("error", reject);
      req.end();
    });
  const ok = await upgrade(`${plane.base}/desktops/${created.id}/ws/websockify?token=${encodeURIComponent(computer.vnc_password)}`);
  assert.equal(ok.status, 101);
  assert.equal(ok.accept, expectAccept);
  const missing = await upgrade(`${plane.base}/desktops/no-such-desktop/ws/websockify?token=${encodeURIComponent(computer.vnc_password)}`);
  assert.equal(missing.status, 404);
  await plane.close();
});

test("websockify checks the token and not the bearer", async () => {
  const plane = await withPlane();
  const ws = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  const workspaceId = (await ws.json()).id;
  const made = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  const computer = await made.json();
  const bad = await new Promise<number>((resolve) => {
    const req = request(`${plane.base}/desktops/${computer.id}/ws/websockify?token=nope`, { headers: { connection: "Upgrade", upgrade: "websocket" } });
    req.on("upgrade", () => resolve(101));
    req.on("response", (res) => resolve(res.statusCode ?? 0));
    req.end();
  });
  assert.equal(bad, 401);
  const store = openStore(plane.statePath);
  const file = await store.read();
  assert.ok(!("error" in file));
  await plane.close();
});