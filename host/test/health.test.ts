import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDriver } from "../incus-fake.ts";
import { withPlane } from "./helpers.ts";

test("health is 200 when the fake answers version", async () => {
  const plane = await withPlane();
  const res = await fetch(`${plane.base}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  await plane.close();
});

test("health is 503 incus_down when version rejects", async () => {
  const driver = new FakeDriver();
  driver.versionError = new Error("down");
  const plane = await withPlane({ driver });
  const res = await fetch(`${plane.base}/health`);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, code: "incus_down" });
  await plane.close();
});

test("a missing bearer on a private route is 401", async () => {
  const plane = await withPlane();
  const res = await fetch(`${plane.base}/api/workspaces`);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
  await plane.close();
});
