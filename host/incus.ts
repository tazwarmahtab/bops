export type IncusFailure = "incus_down" | "host_full" | "disk_full";

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

export type IncusDriver = {
  version(): Promise<string>;
  free(): Promise<{ ramMb: number; diskGb: number }>;
  create(input: { name: string; image: string; cpu: number; ramMb: number; diskGb: number }): Promise<{ instance: string }>;
  start(instance: string): Promise<void>;
  stop(instance: string): Promise<void>;
  restart(instance: string): Promise<void>;
  delete(instance: string): Promise<void>;
  clone(instance: string, name: string): Promise<{ instance: string }>;
  resizeDisk(instance: string, diskGb: number): Promise<void>;
  exec(instance: string, command: string, timeoutSec: number): Promise<ExecResult>;
  screenshot(instance: string, screen: string, format: "jpeg" | "png", scale: number): Promise<Buffer>;
  input(instance: string, kind: "click" | "type" | "key", body: unknown, screen: string): Promise<void>;
  writeFile(instance: string, path: string, contents: Buffer, mode: number): Promise<void>;
  vncPort(instance: string, screenId: string): Promise<number>;
  sshPort(instance: string): Promise<number | null>;
};
