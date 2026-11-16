import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { execArgv, parseIncusFree } from "../incus-cli.ts";

const hostRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("execArgv passes the command as one argv element", () => {
  const argv = execArgv("incus", "inst", "echo hi", 5);
  assert.deepEqual(argv, ["incus", "exec", "inst", "--", "timeout", "5", "bash", "-lc", "echo hi"]);
  assert.equal(argv[argv.length - 1], "echo hi");
});

test("incus-cli spawns without a host shell", () => {
  const source = readFileSync(join(hostRoot, "incus-cli.ts"), "utf8");
  assert.doesNotMatch(source, /shell:\s*true/);
});

test("parseIncusFree reads resources memory and storage pools", () => {
  const fixture = {
    memory: { total: 8 * 1024 * 1024 * 1024, used: 1 * 1024 * 1024 * 1024 },
    storage: { pools: { default: { space: { total: 100 * 1e9, used: 20 * 1e9 } } } },
  };
  assert.deepEqual(parseIncusFree(fixture), { ramMb: 7168, diskGb: 80 });
});

test("parseIncusFree ignores the old resources wrapper shape", () => {
  const wrong = {
    resources: { memory: { nodes: [{ total: 1, used: 0 }] } },
    disk: { total: 1, used: 0 },
  };
  const got = parseIncusFree(wrong);
  assert.notEqual(got.ramMb, 65536);
  assert.notEqual(got.diskGb, 400);
  assert.deepEqual(got, { ramMb: 0, diskGb: 0 });
});

test("incus-cli screenshot command does not use ImageMagick", () => {
  const source = readFileSync(join(hostRoot, "incus-cli.ts"), "utf8");
  assert.doesNotMatch(source, /\bconvert\b/);
});