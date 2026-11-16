import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDriver } from "../incus-fake.ts";
import { openStore } from "../state.ts";
import { withPlane } from "./helpers.ts";

const MIN = 60_000;

async function computerSecret(plane: Awaited<ReturnType<typeof withPlane>>) {
  const driver = plane.driver as FakeDriver;
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
  const id = (await made.json()).id as string;
  await fetch(`${plane.base}/api/computers/${id}/orgo-key`, { method: "PUT", headers: plane.auth });
  const secret = /ORGO_API_KEY='([^']+)'/.exec(driver.writes[0].contents.toString())?.[1];
  if (!secret) throw new Error("key was not written");
  return { id, workspaceId, secret };
}

test("a due task routine starts a suspended computer", async () => {
  const driver = new FakeDriver();
  let now = 1_000_000;
  const plane = await withPlane({ driver, now: () => now });
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
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers[id].status = "suspended";
  });
  const put = await fetch(`${plane.base}/api/projects/${workspaceId}/routines`, {
    method: "PUT",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify([{ id: "r1", nextRunAt: now, onMac: false, run: "task" }]),
  });
  assert.equal(put.status, 200);
  const before = driver.started.length;
  await plane.tick(now);
  assert.equal(driver.started.length, before + 1);
  const file = await store.read();
  if (!("error" in file)) assert.equal(file.computers[id].status, "running");
  await plane.close();
});

test("no activity POST does not idle-suspend", async () => {
  const driver = new FakeDriver();
  let now = 1_000_000;
  const plane = await withPlane({ driver, now: () => now });
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
  await plane.tick(now + 60 * MIN);
  const store = openStore(plane.statePath);
  const file = await store.read();
  if (!("error" in file)) assert.equal(file.computers[id].status, "running");
  assert.equal(driver.stopped.length, 0);
  await plane.close();
});

test("runner idle is 5 minutes and any other POST is 15", async () => {
  const driver = new FakeDriver();
  let now = 1_000_000;
  const plane = await withPlane({ driver, now: () => now });
  const { secret } = await computerSecret(plane);
  await fetch(`${plane.base}/api/bops/computer/active`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ via: "runner" }),
  });
  await plane.tick(now + 4 * MIN);
  assert.equal(driver.stopped.length, 0);
  await plane.tick(now + 5 * MIN);
  assert.equal(driver.stopped.length, 1);
  await plane.close();
});

test("resume after idle suspend stays running on the next tick", async () => {
  const driver = new FakeDriver();
  let now = 1_000_000;
  const plane = await withPlane({ driver, now: () => now });
  const { id } = await computerSecret(plane);
  await fetch(`${plane.base}/api/bops/computer/active`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  await plane.tick(now + 15 * MIN);
  const store = openStore(plane.statePath);
  let file = await store.read();
  if (!("error" in file)) {
    assert.equal(file.computers[id].status, "suspended");
    assert.equal(file.activity[id], undefined);
  }
  const stoppedAfterIdle = driver.stopped.length;
  await fetch(`${plane.base}/api/computers/${id}/resume`, { method: "POST", headers: plane.auth });
  now += 1000;
  await plane.tick(now);
  file = await store.read();
  if (!("error" in file)) assert.equal(file.computers[id].status, "running");
  assert.equal(driver.stopped.length, stoppedAfterIdle);
  await plane.close();
});

test("an account POST idles at 15 minutes", async () => {
  const driver = new FakeDriver();
  let now = 1_000_000;
  const plane = await withPlane({ driver, now: () => now });
  const { id } = await computerSecret(plane);
  await fetch(`${plane.base}/api/bops/computer/active`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  await plane.tick(now + 14 * MIN);
  assert.equal(driver.stopped.length, 0);
  await plane.tick(now + 15 * MIN);
  const store = openStore(plane.statePath);
  const file = await store.read();
  if (!("error" in file)) assert.equal(file.computers[id].status, "suspended");
  await plane.close();
});

test("a routine due within 5 minutes blocks runner idle", async () => {
  const driver = new FakeDriver();
  let now = 1_000_000;
  const plane = await withPlane({ driver, now: () => now });
  const { id, workspaceId, secret } = await computerSecret(plane);
  await fetch(`${plane.base}/api/projects/${workspaceId}/routines`, {
    method: "PUT",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify([{ id: "r1", nextRunAt: now + 4 * MIN, onMac: false, run: "task" }]),
  });
  await fetch(`${plane.base}/api/bops/computer/active`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ via: "runner" }),
  });
  await plane.tick(now + 5 * MIN);
  const store = openStore(plane.statePath);
  const file = await store.read();
  if (!("error" in file)) assert.equal(file.computers[id].status, "running");
  await plane.close();
});

test("an empty routine list does not start, and the bops map is not a clock", async () => {
  const driver = new FakeDriver();
  let now = 1_000_000;
  const plane = await withPlane({ driver, now: () => now });
  const { id, workspaceId } = await computerSecret(plane);
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers[id].status = "suspended";
  });
  const started = driver.started.length;
  await fetch(`${plane.base}/api/projects/${workspaceId}/routines`, {
    method: "PUT",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify([]),
  });
  await fetch(`${plane.base}/api/projects/${workspaceId}/bops`, {
    method: "PUT",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ nextRunAt: now }),
  });
  const map = await fetch(`${plane.base}/api/projects/${workspaceId}/bops`, { headers: plane.auth });
  assert.deepEqual(await map.json(), { nextRunAt: now });
  await plane.tick(now);
  assert.equal(driver.started.length, started);
  await plane.close();
});