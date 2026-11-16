import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeDriver } from "../incus-fake.ts";
import { withPlane } from "./helpers.ts";

async function makeRunningComputer(plane: Awaited<ReturnType<typeof withPlane>>) {
  const ws = await fetch(`${plane.base}/api/workspaces`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ name: "Uploads" }),
  });
  const workspaceId = (await ws.json()).id as string;
  const made = await fetch(`${plane.base}/api/computers`, {
    method: "POST",
    headers: { ...plane.auth, "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: workspaceId, name: "Up", template_ref: "bops-base" }),
  });
  const id = (await made.json()).id as string;
  return id;
}

test("https file uploads into a running guest", async () => {
  const priorOrigin = process.env.BOPS_UPLOAD_ORIGIN;
  const plane = await withPlane({ driver: new FakeDriver() });
  try {
    delete process.env.BOPS_UPLOAD_ORIGIN;
    const needsHttps = await fetch(`${plane.base}/api/files/uploads`, {
      method: "POST",
      headers: { ...plane.auth, "content-type": "application/json" },
      body: JSON.stringify({ desktopId: "x", filename: "a.txt", size_bytes: 1, destPath: "/tmp/a.txt" }),
    });
    assert.equal(needsHttps.status, 409);
    assert.deepEqual(await needsHttps.json(), { code: "upload_needs_https", error: "upload needs https" });

    process.env.BOPS_UPLOAD_ORIGIN = "https://uploads.example";
    const desktopId = await makeRunningComputer(plane);

    const start = await fetch(`${plane.base}/api/files/uploads`, {
      method: "POST",
      headers: { ...plane.auth, "content-type": "application/json" },
      body: JSON.stringify({
        desktopId,
        filename: "a.txt",
        size_bytes: 4,
        destPath: "/tmp/a.txt",
      }),
    });
    assert.equal(start.status, 200);
    const started = (await start.json()) as { upload_url: string; upload_token: string };
    assert.ok(started.upload_url.startsWith("https://uploads.example/api/files/uploads/"));
    assert.ok(started.upload_token.length > 0);

    const incomplete = await fetch(`${plane.base}/api/files/uploads/complete`, {
      method: "POST",
      headers: { ...plane.auth, "content-type": "application/json" },
      body: JSON.stringify({ desktopId, upload_token: started.upload_token }),
    });
    assert.equal(incomplete.status, 409);
    assert.deepEqual(await incomplete.json(), { error: "incomplete upload" });

    const putPath = new URL(started.upload_url).pathname;
    const mismatch = await fetch(`${plane.base}${putPath}`, {
      method: "PUT",
      body: "abc",
    });
    assert.equal(mismatch.status, 400);
    assert.deepEqual(await mismatch.json(), { error: "size mismatch" });

    const put = await fetch(`${plane.base}${putPath}`, {
      method: "PUT",
      body: "abcd",
    });
    assert.equal(put.status, 200);

    const unknown = await fetch(`${plane.base}/api/files/uploads/no-such-token`, {
      method: "PUT",
      body: "abcd",
    });
    assert.equal(unknown.status, 404);

    const complete = await fetch(`${plane.base}/api/files/uploads/complete`, {
      method: "POST",
      headers: { ...plane.auth, "content-type": "application/json" },
      body: JSON.stringify({ desktopId, upload_token: started.upload_token }),
    });
    assert.equal(complete.status, 200);
    assert.ok(plane.driver.writes.some((w) => w.path === "/tmp/a.txt"));
  } finally {
    if (priorOrigin === undefined) delete process.env.BOPS_UPLOAD_ORIGIN;
    else process.env.BOPS_UPLOAD_ORIGIN = priorOrigin;
    await plane.close();
  }
});