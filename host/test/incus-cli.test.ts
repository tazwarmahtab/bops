import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { execArgv } from "../incus-cli.ts";

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