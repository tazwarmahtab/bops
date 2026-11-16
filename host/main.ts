import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cliDriver } from "./incus-cli.ts";
import { start } from "./server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const stateDir = join(here, "state");
mkdirSync(stateDir, { recursive: true });
const statePath = join(stateDir, "plane.json");

function parseHostAddr(raw: string | undefined) {
  const value = raw?.trim() || "127.0.0.1:8788";
  const lastColon = value.lastIndexOf(":");
  if (lastColon <= 0) return { host: value, port: 8788 };
  const host = value.slice(0, lastColon);
  const port = Number(value.slice(lastColon + 1));
  return { host, port: Number.isFinite(port) && port > 0 ? port : 8788 };
}

function isLoopback(host: string) {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  return host.startsWith("127.");
}

const { host, port } = parseHostAddr(process.env.BOPS_HOST_ADDR);
if (!isLoopback(host)) {
  console.error("non-loopback bind is unsupported");
  process.exit(1);
}

const plane = start({
  driver: cliDriver(),
  statePath,
  now: Date.now,
  host,
  port,
  accountKey: process.env.ORGO_API_KEY ?? "",
});

const bound = await plane.listen();
console.log(`bops plane listening on http://${host}:${bound}`);