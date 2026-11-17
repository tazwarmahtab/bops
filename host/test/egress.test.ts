import assert from "node:assert/strict";
import { test } from "node:test";
import { withPlane } from "./helpers.ts";

async function workspace(plane: Awaited<ReturnType<typeof withPlane>>) {
  const res = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Bops" }),
  });
  return (await res.json()).id as string;
}

async function computer(plane: Awaited<ReturnType<typeof withPlane>>, workspaceId: string) {
  const res = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Sam", template_ref: "bops-base" }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).id as string;
}

test("egress devices and computer upstream", async () => {
  const plane = await withPlane();
  const headscaleUrl = process.env.BOPS_HEADSCALE_URL;
  delete process.env.BOPS_HEADSCALE_URL;
  try {
    const paired = await fetch(`${plane.base}/api/egress-devices`, {
      method: "POST",
      headers: { ...plane.auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "Mac" }),
    });
    assert.equal(paired.status, 200);
    const pairBody = await paired.json();
    assert.equal(typeof pairBody.id, "string");
    assert.equal(pairBody.name, "Mac");
    assert.equal(pairBody.pairing_code.length, 8);
    assert.match(pairBody.pairing_code, /^[A-Za-z0-9]{8}$/);

    const listedUnset = await fetch(`${plane.base}/api/egress-devices`, { headers: plane.auth });
    assert.equal(listedUnset.status, 200);
    const listUnset = await listedUnset.json();
    assert.deepEqual(listUnset.devices, [{ id: pairBody.id, name: "Mac", online: null }]);
    assert.equal(listUnset.rendezvous, null);

    process.env.BOPS_HEADSCALE_URL = "https://headscale.test";
    const listedSet = await fetch(`${plane.base}/api/egress-devices`, { headers: plane.auth });
    const listSet = await listedSet.json();
    assert.equal(listSet.rendezvous, "https://headscale.test");

    const workspaceId = await workspace(plane);
    const computerId = await computer(plane, workspaceId);

    const before = await fetch(`${plane.base}/api/computers/${computerId}/egress/upstream`, { headers: plane.auth });
    assert.equal(before.status, 200);
    assert.deepEqual(await before.json(), { mode: "residential", device_id: null, proxy_on: false });

    const residential = await fetch(`${plane.base}/api/computers/${computerId}/egress/upstream`, {
      method: "POST",
      headers: { ...plane.auth, "content-type": "application/json" },
      body: JSON.stringify({ mode: "residential" }),
    });
    assert.equal(residential.status, 200);
    const afterResidential = await fetch(`${plane.base}/api/computers/${computerId}/egress/upstream`, { headers: plane.auth });
    assert.deepEqual(await afterResidential.json(), { mode: "residential", device_id: null, proxy_on: false });

    const deviceMode = await fetch(`${plane.base}/api/computers/${computerId}/egress/upstream`, {
      method: "POST",
      headers: { ...plane.auth, "content-type": "application/json" },
      body: JSON.stringify({ mode: "device", device_id: pairBody.id }),
    });
    assert.equal(deviceMode.status, 200);
    const afterDevice = await fetch(`${plane.base}/api/computers/${computerId}/egress/upstream`, { headers: plane.auth });
    assert.deepEqual(await afterDevice.json(), { mode: "device", device_id: pairBody.id, proxy_on: false });

    const proxyOff = await fetch(`${plane.base}/api/computers/${computerId}/residential-proxy`, {
      method: "POST",
      headers: { ...plane.auth, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(proxyOff.status, 200);

    const proxyOn = await fetch(`${plane.base}/api/computers/${computerId}/residential-proxy`, {
      method: "POST",
      headers: { ...plane.auth, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(proxyOn.status, 409);
    assert.deepEqual(await proxyOn.json(), { code: "residential_unavailable", error: "residential unavailable" });
  } finally {
    if (headscaleUrl === undefined) delete process.env.BOPS_HEADSCALE_URL;
    else process.env.BOPS_HEADSCALE_URL = headscaleUrl;
    await plane.close();
  }
});