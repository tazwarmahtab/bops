import { accessSync, constants, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const basePath = join(repoRoot, "orgo/bops-base.mjs");

function parseRecipe(source) {
  const codex = source.match(/const CODEX_VERSION = "([^"]+)"/)?.[1] ?? "";
  const claude = source.match(/const CLAUDE_CODE_VERSION = "([^"]+)"/)?.[1] ?? "";
  const name = source.match(/name: "([^"]+)"/)?.[1] ?? "bops-base";
  const aptBlock = source.match(/apt:\s*\[([\s\S]*?)\],\s*\n\s*run:/);
  const apt = aptBlock ? [...aptBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  const files = [...source.matchAll(/\{\s*to:\s*"([^"]+)"/g)].map((m) => m[1]);
  return { name, codex, claude, apt, files };
}

function printRecipe(recipe) {
  process.stdout.write(`${recipe.name}\n`);
  for (const pkg of recipe.apt) process.stdout.write(`${pkg}\n`);
  process.stdout.write(`${recipe.codex}\n`);
  process.stdout.write(`${recipe.claude}\n`);
  for (const dest of recipe.files) process.stdout.write(`${dest}\n`);
}

function incusOnPath() {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, "incus"), constants.X_OK);
      return true;
    } catch {
      // keep scanning PATH
    }
  }
  return false;
}

const recipe = parseRecipe(readFileSync(basePath, "utf8"));

if (process.argv.includes("--print")) {
  printRecipe(recipe);
  process.exit(0);
}

printRecipe(recipe);

if (!incusOnPath()) {
  process.stderr.write("incus is not on PATH\n");
  process.exit(2);
}

if (process.platform === "linux") {
  const built = spawnSync("incus", ["image", "build", recipe.name], { cwd: here, stdio: "inherit" });
  process.exit(built.status === null ? 1 : built.status);
}

process.exit(0);