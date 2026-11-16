import { syncSshToGuest } from "./routes/computers.ts";
import type { IncusDriver } from "./incus.ts";
import type { Store } from "./state.ts";

const RUNNER_IDLE = 5 * 60_000;
const OTHER_IDLE = 15 * 60_000;
const DUE_HOLD = 5 * 60_000;

let deps: { store: Store; driver: IncusDriver } | null = null;

export function bindWake(next: { store: Store; driver: IncusDriver }) {
  deps = next;
}

export async function tick(now: number) {
  if (!deps) return;
  const file = await deps.store.read();
  if ("error" in file) return;
  for (const routine of Object.values(file.routines)) {
    if (routine.onMac || routine.run !== "task" || routine.nextRunAt === null || routine.nextRunAt > now) continue;
    const computer = Object.values(file.computers).find((item) => item.workspaceId === routine.projectId);
    if (!computer || computer.status === "stopped" || computer.status === "error" || computer.status === "running") continue;
    try {
      await deps.driver.start(computer.instance);
      await deps.store.update((draft) => {
        if (draft.computers[computer.id]) draft.computers[computer.id].status = "running";
      });
      await syncSshToGuest(deps.store, deps.driver, computer.id, computer.instance);
    } catch {
      console.error(`wake ${computer.id} failed`);
    }
  }
  const again = await deps.store.read();
  if ("error" in again) return;
  for (const computer of Object.values(again.computers)) {
    if (computer.status !== "running") continue;
    const beat = again.activity[computer.id];
    if (!beat) continue;
    const held = Object.values(again.routines).some(
      (routine) =>
        routine.projectId === computer.workspaceId &&
        !routine.onMac &&
        routine.run === "task" &&
        routine.nextRunAt !== null &&
        routine.nextRunAt <= now + DUE_HOLD,
    );
    if (held) continue;
    const limit = beat.via === "runner" ? RUNNER_IDLE : OTHER_IDLE;
    if (now - beat.at < limit) continue;
    await deps.driver.stop(computer.instance);
    await deps.store.update((draft) => {
      if (draft.computers[computer.id]) {
        draft.computers[computer.id].status = "suspended";
        delete draft.activity[computer.id];
      }
    });
  }
}