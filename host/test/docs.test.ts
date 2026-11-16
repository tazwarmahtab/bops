import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("the self-host profile names the Linux plane", () => {
  const env = readFileSync(".env.example", "utf8");
  assert.match(env, /BOPS_ORGO_ORIGIN=/);
  assert.match(env, /Linux host/);
  assert.match(env, /BOPS_UPLOAD_ORIGIN=/);
  assert.match(env, /BOPS_WEBRTC=0/);
  assert.match(env, /BOPS_HEADSCALE_URL=/);
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /Run it yourself/);
  assert.match(readme, /Incus/);
  assert.match(readme, /Headscale/);
  assert.match(readme, /Keys and Your Apps are closed on this plane/);
  assert.match(readme, /non-loopback bind is unsupported/);
  assert.match(readme, /systemd/);
  assert.match(readme, /auth: key/);
});