import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDriver } from "../incus-fake.ts";
import { withPlane } from "./helpers.ts";

test("creates a workspace, rejects a duplicate name, and lists desktops", async () => {
  const plane = await withPlane();
  const made = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  assert.equal(made.status, 200);
  const ws = await made.json();
  const again = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  assert.equal(again.status, 400);
  assert.equal((await again.json()).code, "WORKSPACE_NAME_TAKEN");
  const one = await fetch(`${plane.base}/api/workspaces/${ws.id}`, { headers: plane.auth });
  assert.deepEqual(await one.json(), { id: ws.id, name: "Bops", desktops: [] });
  const preview = await fetch(`${plane.base}/api/workspaces/${ws.id}/delete-preview`, { headers: plane.auth });
  assert.deepEqual(await preview.json(), {
    computers: [],
    keys: [],
    skills: [],
    apps: [],
    madeApps: [],
    crmFiles: [],
    routines: [],
    orbitIssues: [],
  });
  const members = await fetch(`${plane.base}/api/workspaces/${ws.id}/members`, { headers: plane.auth });
  assert.deepEqual(await members.json(), { members: [{ id: "local", role: "owner", name: "Local" }], invites: [] });
  const domains = await fetch(`${plane.base}/api/projects/${ws.id}/domains`, { headers: plane.auth });
  assert.deepEqual(await domains.json(), { registrar: false, enabled: false, domains: [] });
  await plane.close();
});

test("PATCH /api/projects/{id} renames the workspace", async () => {
  const plane = await withPlane();
  const made = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Alpha" }),
  });
  const { id } = (await made.json()) as { id: string };
  const patched = await fetch(`${plane.base}/api/projects/${id}`, {
    method: "PATCH",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Beta", bops_ws_id: "ws-1" }),
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(await patched.json(), { id, name: "Beta", bopsWsId: "ws-1" });
  const dup = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Taken" }),
  });
  const other = (await dup.json()) as { id: string };
  const conflict = await fetch(`${plane.base}/api/projects/${id}`, {
    method: "PATCH",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Taken" }),
  });
  assert.equal(conflict.status, 400);
  assert.deepEqual(await conflict.json(), { code: "WORKSPACE_NAME_TAKEN", error: "name taken" });
  const missing = await fetch(`${plane.base}/api/projects/no-such-id`, {
    method: "PATCH",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Nope" }),
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not found" });
  const okOther = await fetch(`${plane.base}/api/projects/${other.id}`, {
    method: "PATCH",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Gamma" }),
  });
  assert.equal(okOther.status, 200);
  await plane.close();
});

// Value: protects=project delete removes that workspace's Incus instance and the workspace row; fails_when=the computer or workspace remains, another workspace's computer is deleted, or an unknown id returns 200; why_new=the only delete check is a computer-key 403; seam=none; no_claim=does not cover driver.delete throwing
test("POST /api/projects/{id}/delete removes computers and the workspace", async () => {
  const driver = new FakeDriver();
  const plane = await withPlane({ driver });
  const made = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  const keep = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Other" }),
  });
  const workspaceId = (await made.json()).id as string;
  const otherId = (await keep.json()).id as string;
  const sam = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  const ada = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: otherId, name: "Ada", template_ref: "bops-base" }),
  });
  const samId = (await sam.json()).id as string;
  const adaId = (await ada.json()).id as string;
  const missing = await fetch(`${plane.base}/api/projects/no-such-id/delete`, { method: "POST", headers: plane.auth });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not found" });
  const deleted = await fetch(`${plane.base}/api/projects/${workspaceId}/delete`, { method: "POST", headers: plane.auth });
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { success: true });
  assert.deepEqual(driver.deleted, ["inst-Sam"]);
  const goneWs = await fetch(`${plane.base}/api/workspaces/${workspaceId}`, { headers: plane.auth });
  assert.equal(goneWs.status, 404);
  const goneComputer = await fetch(`${plane.base}/api/computers/${samId}`, { headers: plane.auth });
  assert.equal(goneComputer.status, 404);
  const still = await fetch(`${plane.base}/api/computers/${adaId}`, { headers: plane.auth });
  assert.equal(still.status, 200);
  const listed = await fetch(`${plane.base}/api/workspaces`, { headers: plane.auth });
  const body = (await listed.json()) as { workspaces: { id: string }[] };
  assert.equal(body.workspaces.some((ws) => ws.id === workspaceId), false);
  assert.equal(body.workspaces.some((ws) => ws.id === otherId), true);
  await plane.close();
});

test("project domains ignore Incus and still 404 unknown ids", async () => {
  const plane = await withPlane();
  const made = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Domains" }),
  });
  assert.equal(made.status, 200);
  const { id } = (await made.json()) as { id: string };
  (plane.driver as FakeDriver).versionError = new Error("incus down");
  const domains = await fetch(`${plane.base}/api/projects/${id}/domains`, { headers: plane.auth });
  assert.equal(domains.status, 200);
  assert.deepEqual(await domains.json(), { registrar: false, enabled: false, domains: [] });
  const missing = await fetch(`${plane.base}/api/projects/no-such-ws/domains`, { headers: plane.auth });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "not found" });
  await plane.close();
});