import type { ExecResult, IncusDriver } from "./incus.ts";

export class FakeDriver implements IncusDriver {
  versionError: Error | null = null;
  startError: Error | null = null;
  freeRamMb = 65536;
  freeDiskGb = 400;
  execs: { instance: string; command: string; timeoutSec: number }[] = [];
  inputs: unknown[] = [];
  screenshots: { screen: string; format: string; scale: number }[] = [];
  writes: { instance: string; path: string; mode: number; contents: Buffer }[] = [];
  created = 0;
  cloned = 0;
  deleted: string[] = [];
  started: string[] = [];
  stopped: string[] = [];
  resized: { instance: string; diskGb: number }[] = [];
  async version() {
    if (this.versionError) throw this.versionError;
    return "fake";
  }
  async free() {
    return { ramMb: this.freeRamMb, diskGb: this.freeDiskGb };
  }
  async create(input: { name: string }) {
    this.created += 1;
    return { instance: `inst-${input.name}` };
  }
  async start(instance: string) {
    if (this.startError) throw this.startError;
    this.started.push(instance);
  }
  async stop(instance: string) {
    this.stopped.push(instance);
  }
  async restart(instance: string) {
    this.stopped.push(instance);
    this.started.push(instance);
  }
  async delete(instance: string) {
    this.deleted.push(instance);
  }
  async clone(instance: string, name: string) {
    this.cloned += 1;
    return { instance: `${instance}-clone-${name}` };
  }
  async resizeDisk(instance: string, diskGb: number) {
    this.resized.push({ instance, diskGb });
  }
  async exec(instance: string, command: string, timeoutSec: number): Promise<ExecResult> {
    this.execs.push({ instance, command, timeoutSec });
    if (timeoutSec <= 1) return { exitCode: 124, stdout: "", stderr: "killed" };
    return { exitCode: 0, stdout: "ok\n", stderr: "" };
  }
  async screenshot(_instance: string, screen: string, format: "jpeg" | "png", scale: number) {
    this.screenshots.push({ screen, format, scale });
    return Buffer.from(`fake:${screen}:${format}:${scale}`);
  }
  async input(_instance: string, kind: "click" | "type" | "key", body: unknown, screen: string) {
    this.inputs.push({ kind, body, screen });
  }
  async writeFile(instance: string, path: string, contents: Buffer, mode: number) {
    this.writes.push({ instance, path, mode, contents });
  }
  async vncPort() {
    return 5900;
  }
  async sshPort() {
    return 2222;
  }
}
