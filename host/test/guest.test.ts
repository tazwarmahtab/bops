import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDriver } from "../incus-fake.ts";
import { openStore } from "../state.ts";
import { withPlane } from "./helpers.ts";

async function make(driver = new FakeDriver()) {
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
  const id = (await made.json()).id as string;
  return { plane, driver, id };
}

test("bash on a running computer returns the fake exit", async () => {
  const { plane, driver, id } = await make();
  const started = Date.now();
  const res = await fetch(`${plane.base}/api/computers/${id}/bash`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ command: "echo hi", timeout: 30 }),
  });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).exit_code, 0);
  assert.equal(driver.execs[0].command, "echo hi");
  console.log(`bash ${Date.now() - started}ms`);
  await plane.close();
});

test("bash timeout 1 returns a non-zero exit", async () => {
  const { plane, id } = await make();
  const started = Date.now();
  const res = await fetch(`${plane.base}/api/computers/${id}/bash`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ command: "sleep 9", timeout: 1 }),
  });
  const body = await res.json();
  assert.equal(body.exit_code, 124);
  console.log(`bash-timeout ${Date.now() - started}ms`);
  await plane.close();
});

test("a suspended click does not call input", async () => {
  const { plane, driver, id } = await make();
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers[id].status = "suspended";
  });
  const res = await fetch(`${plane.base}/api/computers/${id}/click?screen=screen-100`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ x: 1, y: 2 }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "resume_in_progress");
  assert.equal(res.headers.get("retry-after"), "2");
  assert.equal(driver.inputs.length, 0);
  assert.equal(driver.started.length, 2);
  const again = await fetch(`${plane.base}/api/computers/${id}/click?screen=screen-100`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ x: 1, y: 2 }),
  });
  assert.equal(again.status, 200);
  assert.equal(driver.inputs.length, 1);
  await plane.close();
});

test("a running screenshot returns the fake bytes", async () => {
  const { plane, id } = await make();
  const started = Date.now();
  const res = await fetch(`${plane.base}/api/computers/${id}/screenshot?screen=default&format=png&scale=1`, { headers: plane.auth });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "fake:default:png:1");
  console.log(`screenshot ${Date.now() - started}ms`);
  await plane.close();
});

test("a suspended screenshot does not call screenshot", async () => {
  const { plane, driver, id } = await make();
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers[id].status = "suspended";
  });
  const started = Date.now();
  const res = await fetch(`${plane.base}/api/computers/${id}/screenshot?screen=default&format=jpeg&scale=0.75`, { headers: plane.auth });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "computer_asleep");
  assert.equal(driver.screenshots.length, 0);
  console.log(`screenshot-asleep ${Date.now() - started}ms`);
  await plane.close();
});

test("resume returns 503 when start fails", async () => {
  const { plane, driver, id } = await make();
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers[id].status = "suspended";
  });
  driver.startError = new Error("start failed");
  const res = await fetch(`${plane.base}/api/computers/${id}/resume`, { method: "POST", headers: plane.auth });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { code: "incus_down", error: "incus down" });
  const file = await store.read();
  if (!("error" in file)) assert.equal(file.computers[id].status, "suspended");
  await plane.close();
});

test("stopped bash says not suspended", async () => {
  const { plane, driver, id } = await make();
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers[id].status = "stopped";
  });
  const res = await fetch(`${plane.base}/api/computers/${id}/bash`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ command: "true", timeout: 5 }),
  });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /not suspended/i);
  assert.equal(driver.execs.length, 0);
  await plane.close();
});