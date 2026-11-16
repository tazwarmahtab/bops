import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncusDriver } from "../incus.ts";
import { FakeDriver } from "../incus-fake.ts";
import { start } from "../server.ts";

export const ACCOUNT = "test-account-key";

export async function withPlane(opts: { driver?: IncusDriver; now?: () => number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "bops-plane-"));
  const statePath = join(dir, "plane.json");
  const driver = opts.driver ?? new FakeDriver();
  const now = opts.now ?? (() => 1_700_000_000_000);
  const plane = start({ driver, statePath, now, host: "127.0.0.1", port: 0, accountKey: ACCOUNT });
  const port = await plane.listen();
  return {
    base: `http://127.0.0.1:${port}`,
    driver,
    statePath,
    auth: { authorization: `Bearer ${ACCOUNT}` },
    tick: plane.tick,
    close: async () => {
      await plane.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
