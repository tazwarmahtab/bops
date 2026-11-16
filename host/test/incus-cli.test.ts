import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createInstanceArgv, execArgv, incusInstanceName, parseIncusFree } from "../incus-cli.ts";

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

test("createInstanceArgv uses init, not launch", () => {
  const argv = createInstanceArgv("incus", { image: "bops-base", name: "Oscar 2", cpu: 4, ramMb: 16384, diskGb: 80 });
  assert.equal(argv[0], "incus");
  assert.equal(argv[1], "init");
  assert.notEqual(argv[1], "launch");
  assert.match(argv[3], /^[A-Za-z][A-Za-z0-9-]{0,62}$/);
});

test("cliDriver create passes createInstanceArgv without the binary prefix", () => {
  const source = readFileSync(join(hostRoot, "incus-cli.ts"), "utf8");
  assert.match(source, /run\(createInstanceArgv\(binary,\s*input\)\.slice\(1\)\)/);
});

test("incusInstanceName sanitizes display names", () => {
  assert.match(incusInstanceName("Oscar 2"), /^[A-Za-z][A-Za-z0-9-]{0,62}$/);
  assert.equal(incusInstanceName("Oscar 2"), "Oscar-2");
  assert.match(incusInstanceName("Sam 2"), /^[A-Za-z][A-Za-z0-9-]{0,62}$/);
});