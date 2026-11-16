import assert from "node:assert/strict";
import { test } from "node:test";
import { withPlane } from "./helpers.ts";

const secrets = ["GET /api/secrets", "POST /api/secrets", "POST /api/secrets/reveal", "POST /api/secrets/call", "DELETE /api/secrets/demo"];

test("secrets are 501 and not 404", async () => {
  const plane = await withPlane();
  for (const row of secrets) {
    const [method, path] = row.split(" ");
    const res = await fetch(`${plane.base}${path}`, { method, headers: plane.auth });
    assert.equal(res.status, 501, row);
    const body = await res.json();
    assert.equal(body.code, "not_on_this_plane");
    assert.equal(body.error, "not on this plane");
  }
  await plane.close();
});

test("crm and skills are 404 with no code", async () => {
  const plane = await withPlane();
  for (const path of ["/api/projects/p/crm", "/api/projects/p/skills"]) {
    const res = await fetch(`${plane.base}${path}`, { headers: plane.auth });
    assert.equal(res.status, 404, path);
    const body = await res.json();
    assert.equal(body.error, "not found");
    assert.equal("code" in body, false);
  }
  await plane.close();
});

test("deploy is 404 DEPLOYS_DISABLED", async () => {
  const plane = await withPlane();
  const res = await fetch(`${plane.base}/api/computers/c1/deploy-projects`, { headers: plane.auth });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { code: "DEPLOYS_DISABLED", error: "deploys disabled" });
  await plane.close();
});

test("settings default to mac and accept cloud", async () => {
  const plane = await withPlane();
  const first = await fetch(`${plane.base}/api/bops/settings`, { headers: plane.auth });
  assert.deepEqual(await first.json(), { runsOn: "mac" });
  const put = await fetch(`${plane.base}/api/bops/settings`, {
    method: "PUT",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ runsOn: "cloud" }),
  });
  assert.equal(put.status, 200);
  const again = await fetch(`${plane.base}/api/bops/settings`, { headers: plane.auth });
  assert.deepEqual(await again.json(), { runsOn: "cloud" });
  await plane.close();
});