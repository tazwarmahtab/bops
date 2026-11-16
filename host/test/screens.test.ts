import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
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