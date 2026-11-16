import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { FakeDriver } from "../incus-fake.ts";
import { openStore } from "../state.ts";
import { ACCOUNT, withPlane } from "./helpers.ts";

async function boot(driver = new FakeDriver()) {
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
  return { plane, driver, workspaceId, id };
}

test("the computer key is written to the guest and not returned", async () => {
  const { plane, driver, id } = await boot();
  const put = await fetch(`${plane.base}/api/computers/${id}/orgo-key`, { method: "PUT", headers: plane.auth });
  const body = await put.json();
  assert.equal(typeof body.keyId, "string");
  assert.equal("key" in body, false);
  assert.equal(driver.writes[0].path, "/root/.orgo-secrets.env");
  assert.equal(driver.writes[0].mode, 0o600);
  const text = driver.writes[0].contents.toString();
  assert.match(text, /export ORGO_API_KEY='/);
  assert.equal(text.includes(ACCOUNT), false);
  const got = await fetch(`${plane.base}/api/computers/${id}/orgo-key`, { headers: plane.auth });
  const key = await got.json();
  assert.match(key.prefix, /^[A-Za-z0-9_]{8}$/);
  assert.equal(key.expiresAt, null);
  assert.equal(key.name, "Computer key for Sam");
  const del = await fetch(`${plane.base}/api/computers/${id}/orgo-key`, { method: "DELETE", headers: plane.auth });
  assert.equal(del.status, 200);
  const missing = await fetch(`${plane.base}/api/computers/${id}/orgo-key`, { headers: plane.auth });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "key_not_found");
  await plane.close();
});

test("fork is unavailable and clone checks free space", async () => {
  const { plane, driver, workspaceId, id } = await boot();
  const fork = await fetch(`${plane.base}/api/computers/${id}/fork`, { method: "POST", headers: plane.auth });
  assert.equal(fork.status, 409);
  assert.equal((await fork.json()).code, "live_fork_unavailable");
  const cloned = await fetch(`${plane.base}/api/computers/${id}/clone`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
  assert.equal(cloned.status, 200);
  assert.equal(driver.cloned, 1);
  driver.freeRamMb = 1000;
  const full = await fetch(`${plane.base}/api/computers/${id}/clone`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId }),
  });
  assert.equal(full.status, 409);
  assert.equal((await full.json()).code, "host_full");
  assert.equal(driver.cloned, 1);
  await plane.close();
});

test("fork returns 409 even when Incus is down", async () => {
  const { plane, driver, id } = await boot();
  driver.versionError = new Error("incus down");
  const fork = await fetch(`${plane.base}/api/computers/${id}/fork`, { method: "POST", headers: plane.auth });
  assert.equal(fork.status, 409);
  assert.equal((await fork.json()).code, "live_fork_unavailable");
  const missing = await fetch(`${plane.base}/api/computers/no-such-id/fork`, { method: "POST", headers: plane.auth });
  assert.equal(missing.status, 404);
  await plane.close();
});

test("computer size stays account-only", async () => {
  const { plane, id } = await boot();
  const secret = `cmp_${randomBytes(16).toString("hex")}`;
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.keys.k1 = {
      keyId: "k1",
      computerId: id,
      hash: createHash("sha256").update(secret).digest("hex"),
      prefix: "cmp_abcd",
      name: "Computer key for Sam",
      createdAt: new Date(0).toISOString(),
      lastUsed: null,
      expiresAt: null,
    };
  });
  const denied = await fetch(`${plane.base}/api/bops/computer/size`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ size: "pro" }),
  });
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: "unauthorized" });
  const ok = await fetch(`${plane.base}/api/bops/computer/size`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ size: "pro" }),
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { size: "pro", changed: false, restarted: false });
  await plane.close();
});

test("resize, webrtc, size, and ssh follow the contract", async () => {
  const driver = new FakeDriver();
  const { plane, id } = await boot(driver);
  const resize = await fetch(`${plane.base}/api/computers/${id}/resize`, { headers: plane.auth });
  const disk = await resize.json();
  assert.equal(disk.current_disk_gb, 80);
  assert.equal(disk.max_disk_gb, 80 + driver.freeDiskGb);
  const tooBig = await fetch(`${plane.base}/api/computers/${id}/resize`, {
    method: "PATCH",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ disk_size_gb: 99999 }),
  });
  assert.equal(tooBig.status, 409);
  assert.equal((await tooBig.json()).code, "disk_full");
  const rtc = await fetch(`${plane.base}/api/computers/${id}/webrtc`, { method: "POST", headers: plane.auth });
  assert.deepEqual(await rtc.json(), { webrtc: false });
  const size = await fetch(`${plane.base}/api/bops/computer/size`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ size: "pro" }),
  });
  assert.deepEqual(await size.json(), { size: "pro", changed: false, restarted: false });
  const off = await fetch(`${plane.base}/api/computers/${id}/ssh`, { headers: plane.auth });
  assert.deepEqual(await off.json(), {
    enabled: false,
    authorized_key_set: false,
    ipv4_host: null,
    ipv4_port: null,
    ssh_user: null,
    ssh_command: null,
  });
  const on = await fetch(`${plane.base}/api/computers/${id}/ssh`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ public_key: "ssh-ed25519 AAAA" }),
  });
  assert.deepEqual(await on.json(), { enabled: true, pending: true });
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers[id].status = "suspended";
  });
  await fetch(`${plane.base}/api/computers/${id}/resume`, { method: "POST", headers: plane.auth });
  const ready = await fetch(`${plane.base}/api/computers/${id}/ssh`, { headers: plane.auth });
  assert.deepEqual(await ready.json(), {
    enabled: true,
    authorized_key_set: true,
    ipv4_host: "127.0.0.1",
    ipv4_port: 2222,
    ssh_user: "root",
    ssh_command: "ssh root@127.0.0.1 -p 2222",
  });
  await plane.close();
});

test("ssh POST on a running computer writes the key without resume", async () => {
  const driver = new FakeDriver();
  const { plane, id } = await boot(driver);
  const writesBefore = driver.writes.length;
  const on = await fetch(`${plane.base}/api/computers/${id}/ssh`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ public_key: "ssh-ed25519 BBBB" }),
  });
  assert.deepEqual(await on.json(), { enabled: true, pending: true });
  assert.equal(driver.writes.length, writesBefore + 1);
  const wrote = driver.writes[driver.writes.length - 1];
  assert.equal(wrote.path, "/root/.ssh/authorized_keys");
  assert.equal(wrote.mode, 0o600);
  assert.match(wrote.contents.toString(), /ssh-ed25519 BBBB/);
  await plane.close();
});