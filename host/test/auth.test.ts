import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { openStore } from "../state.ts";
import { ACCOUNT, withPlane } from "./helpers.ts";

test("the account bearer gets the local profile", async () => {
  const plane = await withPlane();
  const res = await fetch(`${plane.base}/api/user/profile`, { headers: plane.auth });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "local", full_name: "Local", api_key: { scope: "account" } });
  await plane.close();
});

// Value: protects=a bearer that is neither the account key nor a computer key is rejected; fails_when=any non-empty bearer is treated as the account; why_new=only a missing Authorization header was tested; seam=none; no_claim=does not cover computer-key expiry or lastUsed
test("an unknown bearer is 401 on profile and workspace create", async () => {
  const plane = await withPlane();
  const headers = { authorization: "Bearer not-the-account-key", "content-type": "application/json" };
  const profile = await fetch(`${plane.base}/api/user/profile`, { headers });
  assert.equal(profile.status, 401);
  assert.deepEqual(await profile.json(), { error: "unauthorized" });
  const created = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Should not exist" }),
  });
  assert.equal(created.status, 401);
  assert.deepEqual(await created.json(), { error: "unauthorized" });
  const listed = await fetch(`${plane.base}/api/workspaces`, { headers: plane.auth });
  assert.deepEqual(await listed.json(), { workspaces: [] });
  await plane.close();
});

test("a computer bearer gets computer scope", async () => {
  const plane = await withPlane();
  const secret = `cmp_${randomBytes(16).toString("hex")}`;
  const store = openStore(plane.statePath);
  await store.update((file) => {
    file.computers.c1 = {
      id: "c1",
      name: "One",
      workspaceId: "w1",
      instance: "inst-One",
      status: "running",
      vncPassword: "pw",
      cpu: 4,
      ramMb: 16384,
      diskGb: 80,
      screens: ["default"],
    };
    file.keys.k1 = {
      keyId: "k1",
      computerId: "c1",
      hash: createHash("sha256").update(secret).digest("hex"),
      prefix: "cmp_abcd",
      name: "Computer key for One",
      createdAt: new Date(0).toISOString(),
      lastUsed: null,
      expiresAt: null,
    };
  });
  const res = await fetch(`${plane.base}/api/user/profile`, { headers: { authorization: `Bearer ${secret}` } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: "local", api_key: { scope: "computer", computer_id: "c1" } });
  const denied = await fetch(`${plane.base}/api/projects/w1/delete`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { code: "owner_only", error: "owner only" });
  await plane.close();
});

void ACCOUNT;