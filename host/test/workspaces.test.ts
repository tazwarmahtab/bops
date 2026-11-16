import assert from "node:assert/strict";
import { test } from "node:test";
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