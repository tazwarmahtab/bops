import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "../..");
const LIB_SERVER = join(ROOT, "lib/server");
const ROUTES_MD = join(ROOT, "host/routes.md");

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const CLASSES = new Set(["implement", "404 no code", "404 DEPLOYS_DISABLED", "501 not_on_this_plane"]);

function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    if (source.startsWith("//", i)) {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (source.startsWith("/*", i)) {
      i += 2;
      while (i < source.length && !source.startsWith("*/", i)) i++;
      i += 2;
      continue;
    }
    out += source[i++];
  }
  return out;
}

type Lit = { value: string; quote: "'" | '"' | "`" };

function readStringLiteral(source: string, start: number, quote: "'" | '"' | "`"): { text: string; end: number } | null {
  let i = start + 1;
  let text = "";
  while (i < source.length) {
    const ch = source[i];
    if (quote === "`" && ch === "$" && source[i + 1] === "{") {
      if (source.startsWith("${base()}", i)) {
        i += "${base()}".length;
        continue;
      }
      let depth = 1;
      let j = i + 2;
      while (j < source.length && depth > 0) {
        if (source[j] === "{") depth++;
        else if (source[j] === "}") depth--;
        j++;
      }
      text += "{id}";
      i = j;
      continue;
    }
    if (ch === "\\") {
      text += ch;
      if (i + 1 < source.length) text += source[++i];
      i++;
      continue;
    }
    if (ch === quote) return { text, end: i + 1 };
    text += ch;
    i++;
  }
  return null;
}

function literalsIn(source: string, from: number, to: number): Lit[] {
  const slice = source.slice(from, to);
  const out: Lit[] = [];
  let i = 0;
  while (i < slice.length) {
    const ch = slice[i];
    if (ch === "'" || ch === '"' || ch === "`") {
      const read = readStringLiteral(slice, i, ch);
      if (!read) break;
      out.push({ value: read.text, quote: ch });
      i = read.end;
      continue;
    }
    i++;
  }
  return out;
}

function closeParenIndex(source: string, openParen: number): number | null {
  let depth = 0;
  let i = openParen;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  while (i < source.length) {
    const ch = source[i];
    const prev = source[i - 1];
    if (!inDouble && !inTemplate && ch === "'" && prev !== "\\") inSingle = !inSingle;
    else if (!inSingle && !inTemplate && ch === '"' && prev !== "\\") inDouble = !inDouble;
    else if (!inSingle && !inDouble && ch === "`" && prev !== "\\") inTemplate = !inTemplate;
    else if (!inSingle && !inDouble && !inTemplate) {
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) return i;
      }
    }
    i++;
  }
  return null;
}

function isCallSite(source: string, index: number, name: string): boolean {
  const before = source.slice(Math.max(0, index - 40), index);
  if (/\b(?:async\s+)?function\s*$/.test(before)) return false;
  if (/\b(?:const|let|var)\s+$/.test(before)) return false;
  if (name === "call" && /\.\s*$/.test(before)) return false;
  return true;
}

function callStarts(source: string, name: string): { openParen: number; closeParen: number }[] {
  const out: { openParen: number; closeParen: number }[] = [];
  const re = new RegExp(`\\b${name}\\b`, "g");
  for (const m of source.matchAll(re)) {
    if (!isCallSite(source, m.index!, name)) continue;
    let i = m.index! + name.length;
    while (i < source.length && /\s/.test(source[i]!)) i++;
    if (source[i] === "<") {
      let depth = 1;
      i++;
      while (i < source.length && depth > 0) {
        if (source[i] === "<") depth++;
        else if (source[i] === ">") depth--;
        i++;
      }
    }
    while (i < source.length && /\s/.test(source[i]!)) i++;
    if (source[i] !== "(") continue;
    const closeParen = closeParenIndex(source, i);
    if (closeParen === null) continue;
    out.push({ openParen: i, closeParen });
  }
  return out;
}

function methodInOptions(args: string): string {
  const m = args.match(/\bmethod\s*:\s*"(GET|POST|PUT|PATCH|DELETE)"/);
  return m?.[1] ?? "GET";
}

function normalizePath(raw: string, fromOrgoCall: boolean): string {
  let path = raw.replace(/\$\{[^}]*\}/g, "{id}");
  const q = path.indexOf("?");
  if (q >= 0) path = path.slice(0, q);
  if (fromOrgoCall && !path.startsWith("/api")) path = `/api${path.startsWith("/") ? "" : "/"}${path}`;
  return path;
}

function isPathLiteral(value: string): boolean {
  if (!value.includes("/")) return false;
  if (/^(application|text|image)\//.test(value)) return false;
  return true;
}

function pathArgsLiteral(all: Lit[]): Lit | undefined {
  return all.filter((l) => isPathLiteral(l.value))[0];
}

function scanCallSite(args: string, kind: "call" | "hostingCall" | "callOrgo" | "postOrgo"): { method: string; path: string }[] {
  const all = literalsIn(args, 0, args.length);
  const pathLit = pathArgsLiteral(all);
  if (!pathLit) return [];

  if (kind === "postOrgo") {
    return [{ method: "POST", path: normalizePath(pathLit.value, false) }];
  }

  if (kind === "hostingCall") {
    const methodLit = all.find((l) => METHODS.has(l.value));
    if (!methodLit) return [];
    return [{ method: methodLit.value, path: normalizePath(pathLit.value, true) }];
  }

  if (kind === "callOrgo") {
    return [{ method: methodInOptions(args), path: normalizePath(pathLit.value, false) }];
  }

  // call( — Orgo client when first literal is an HTTP verb
  const methodLit = all.find((l) => METHODS.has(l.value));
  if (methodLit) {
    return [{ method: methodLit.value, path: normalizePath(pathLit.value, true) }];
  }
  const method = methodInOptions(args);
  if (!pathLit.value.startsWith("/api") && !pathLit.value.startsWith("/")) return [];
  return [{ method, path: normalizePath(pathLit.value, !pathLit.value.startsWith("/api")) }];
}

function screenshotPaths(source: string): { method: string; path: string }[] {
  const out: { method: string; path: string }[] = [];
  for (const line of source.split("\n")) {
    if (!line.includes("base()") || !line.includes("/screenshot")) continue;
    for (const lit of literalsIn(line, 0, line.length)) {
      if (lit.quote !== "`" || !lit.value.includes("/screenshot")) continue;
      let path = lit.value.replace(/\$\{base\(\)\}/g, "");
      path = path.replace(/\$\{[^}]*\}/g, "{id}");
      const q = path.indexOf("?");
      if (q >= 0) path = path.slice(0, q);
      if (!path.startsWith("/api")) path = `/api${path.startsWith("/") ? "" : "/"}${path}`;
      out.push({ method: "GET", path });
    }
  }
  return out;
}

async function allTsFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const ent of names) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) files.push(...(await allTsFiles(p)));
    else if (ent.name.endsWith(".ts")) files.push(p);
  }
  return files;
}

function scanFile(source: string): { method: string; path: string }[] {
  const stripped = stripComments(source);
  const hits: { method: string; path: string }[] = [];
  for (const kind of ["call", "hostingCall", "callOrgo", "postOrgo"] as const) {
    for (const site of callStarts(stripped, kind)) {
      const args = stripped.slice(site.openParen + 1, site.closeParen);
      hits.push(...scanCallSite(args, kind));
    }
  }
  hits.push(...screenshotPaths(stripped));
  return hits;
}

type Row = { method: string; path: string; class: string; raw: string };

function parseRoutes(md: string): Row[] {
  const rows: Row[] = [];
  for (const line of md.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) continue;
    const klass = parts.slice(2).join(" ");
    rows.push({ method: parts[0]!, path: parts[1]!, class: klass, raw: trimmed });
  }
  return rows;
}

function rowMatches(row: Row, method: string, path: string): boolean {
  if (row.method !== "*" && row.method !== method) return false;
  const pattern = row.path;
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return row.method === "*" ? path === pattern : `${method} ${path}` === `${row.method} ${pattern}`;
}

function findRow(rows: Row[], method: string, path: string): Row | undefined {
  const exact = rows.find((r) => r.method === method && r.path === path);
  if (exact) return exact;
  return rows.find((r) => rowMatches(r, method, path));
}

async function scannedPaths(): Promise<Map<string, { method: string; path: string }>> {
  const files = await allTsFiles(LIB_SERVER);
  const map = new Map<string, { method: string; path: string }>();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    for (const hit of scanFile(source)) {
      const key = `${hit.method} ${hit.path}`;
      map.set(key, hit);
    }
  }
  return map;
}

test("every Orgo call path is listed in host/routes.md", async () => {
  const scanned = await scannedPaths();
  console.log(`scanned path count: ${scanned.size}`);

  let md: string;
  try {
    md = await readFile(ROUTES_MD, "utf8");
  } catch (e) {
    assert.fail(`host/routes.md is missing: ${(e as Error).message}`);
  }

  const rows = parseRoutes(md);
  const missing: string[] = [];
  const badClass: string[] = [];

  for (const row of rows) {
    if (!CLASSES.has(row.class)) badClass.push(row.raw);
  }

  for (const [key, hit] of scanned) {
    if (!findRow(rows, hit.method, hit.path)) missing.push(key);
  }
  assert.deepEqual(
    badClass,
    [],
    `invalid CLASS in host/routes.md:\n${badClass.join("\n")}`,
  );
  assert.deepEqual(
    missing,
    [],
    `paths missing from host/routes.md:\n${missing.join("\n")}`,
  );
});