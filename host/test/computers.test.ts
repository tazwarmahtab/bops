import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDriver } from "../incus-fake.ts";
import { openStore } from "../state.ts";
import { withPlane } from "./helpers.ts";

async function workspace(plane: Awaited<ReturnType<typeof withPlane>>) {
  const res = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  return (await res.json()).id as string;
}

test("creates and deletes a computer", async () => {
  const driver = new FakeDriver();
  const plane = await withPlane({ driver });
  const workspaceId = await workspace(plane);
  const made = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  assert.equal(made.status, 200);
  const body = await made.json();
  assert.equal(body.status, "running");
  assert.equal(driver.created, 1);
  const got = await fetch(`${plane.base}/api/computers/${body.id}`, { headers: plane.auth });
  const computer = await got.json();
  assert.equal(computer.vnc_password.length > 0, true);
  assert.equal(computer.workspace_id, workspaceId);
  assert.equal(computer.project_id, workspaceId);
  assert.deepEqual(computer.instance_details, { webrtc: false });
  assert.equal(computer.cpu, 4);
  assert.equal(computer.ram, 16);
  const dup = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  assert.equal(dup.status, 409);
  const del = await fetch(`${plane.base}/api/computers/${body.id}`, { method: "DELETE", headers: plane.auth });
  assert.equal(del.status, 200);
  assert.equal(driver.deleted.length, 1);
  await plane.close();
});

test("a full host does not create", async () => {
  const driver = new FakeDriver();
  driver.freeRamMb = 1000;
  const plane = await withPlane({ driver });
  const workspaceId = await workspace(plane);
  const res = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "host_full");
  assert.equal(body.free_ram_mb, 1000);
  assert.equal(driver.created, 0);
  await plane.close();
});

test("create rolls back when start fails", async () => {
  const driver = new FakeDriver();
  driver.startError = new Error("start failed");
  const plane = await withPlane({ driver });
  const workspaceId = await workspace(plane);
  const res = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { code: "incus_down", error: "incus down" });
  assert.equal(driver.deleted.length, 1);
  assert.equal(driver.created, 1);
  const store = openStore(plane.statePath);
  const file = await store.read();
  if (!("error" in file)) assert.equal(Object.keys(file.computers).length, 0);
  await plane.close();
});

test("an unknown template is 400", async () => {
  const plane = await withPlane();
  const workspaceId = await workspace(plane);
  const res = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "other" }),
  });
  assert.equal(res.status, 400);
  await plane.close();
});