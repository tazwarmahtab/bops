import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const hostRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = join(hostRoot, "image", "build.mjs");

test("image --print lists the base recipe", () => {
  const result = spawnSync(process.execPath, [buildScript, "--print"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  for (const needle of ["bops-base", "gimp", "0.160.0", "2.1.292", "bops-screen-layout"]) {
    assert.match(out, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("image build script does not call orgo", () => {
  const source = readFileSync(buildScript, "utf8");
  assert.doesNotMatch(source, /www\.orgo\.ai/);
});