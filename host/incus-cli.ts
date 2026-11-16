import { spawn } from "node:child_process";
import type { ExecResult, IncusDriver } from "./incus.ts";

export function execArgv(binary: string, instance: string, command: string, timeoutSec: number): string[] {
  return [binary, "exec", instance, "--", "timeout", String(timeoutSec), "bash", "-lc", command];
}

function displayNum(screen: string): number {
  if (screen === "default") return 99;
  const m = /^screen-(\d+)$/.exec(screen);
  return m ? Number(m[1]) : 99;
}

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function cliDriver(binary = "incus"): IncusDriver {
  async function run(args: string[]): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { shell: false });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    });
  }

  async function pullFile(instance: string, path: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, ["file", "pull", `${instance}${path}`, "-"], { shell: false });
      const chunks: Buffer[] = [];
      let stderr = "";
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout?.on("data", (chunk) => {
        chunks.push(chunk as Buffer);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(stderr || `pull failed with ${code}`));
        else resolve(Buffer.concat(chunks));
      });
    });
  }

  const driver: IncusDriver = {
    async version() {
      const result = await run(["version"]);
      if (result.exitCode !== 0) throw new Error(result.stderr || "incus down");
      return result.stdout.trim().split("\n")[0] ?? "";
    },

    async free() {
      let ramMb = 0;
      let diskGb = 0;
      const resources = await run(["info", "--resources", "--format", "json"]);
      if (resources.exitCode === 0) {
        try {
          const parsed = JSON.parse(resources.stdout) as {
            resources?: { memory?: { nodes?: { total?: number; used?: number }[] } };
          };
          const node = parsed.resources?.memory?.nodes?.[0];
          if (node?.total != null && node.used != null) {
            ramMb = Math.floor((node.total - node.used) / (1024 * 1024));
          }
        } catch {
          // keep defaults
        }
      }
      const storage = await run(["storage", "info", "default", "--format", "json"]);
      if (storage.exitCode === 0) {
        try {
          const parsed = JSON.parse(storage.stdout) as { disk?: { total?: number; used?: number } };
          if (parsed.disk?.total != null && parsed.disk.used != null) {
            diskGb = Math.floor((parsed.disk.total - parsed.disk.used) / 1e9);
          }
        } catch {
          // keep defaults
        }
      }
      return { ramMb: ramMb || 65536, diskGb: diskGb || 400 };
    },

    async create(input) {
      const result = await run([
        "launch",
        input.image,
        input.name,
        "-c",
        `limits.cpu=${input.cpu}`,
        "-c",
        `limits.memory=${input.ramMb}MiB`,
        "-d",
        `root,size=${input.diskGb}GiB`,
      ]);
      if (result.exitCode !== 0) throw new Error(result.stderr || "create failed");
      return { instance: input.name };
    },

    async start(instance) {
      const result = await run(["start", instance]);
      if (result.exitCode !== 0) throw new Error(result.stderr || "start failed");
    },

    async stop(instance) {
      const result = await run(["stop", instance, "--force"]);
      if (result.exitCode !== 0) throw new Error(result.stderr || "stop failed");
    },

    async restart(instance) {
      const result = await run(["restart", instance, "--force"]);
      if (result.exitCode !== 0) throw new Error(result.stderr || "restart failed");
    },

    async delete(instance) {
      const result = await run(["delete", instance, "--force"]);
      if (result.exitCode !== 0) throw new Error(result.stderr || "delete failed");
    },

    async clone(instance, name) {
      const result = await run(["copy", instance, name]);
      if (result.exitCode !== 0) throw new Error(result.stderr || "clone failed");
      return { instance: name };
    },

    async resizeDisk(instance, diskGb) {
      const result = await run(["config", "device", "set", instance, "root", "size", `${diskGb}GiB`]);
      if (result.exitCode !== 0) throw new Error(result.stderr || "resize failed");
    },

    async exec(instance, command, timeoutSec): Promise<ExecResult> {
      const argv = execArgv(binary, instance, command, timeoutSec);
      const [cmd, ...args] = argv;
      return new Promise((resolve) => {
        const child = spawn(cmd, args, { shell: false });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (result: ExecResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr?.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", (err) => finish({ exitCode: 1, stdout, stderr: `${stderr}${err.message}` }));
        child.on("close", (code) => finish({ exitCode: code ?? 1, stdout, stderr }));
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish({ exitCode: 124, stdout, stderr });
        }, timeoutSec * 1000);
      });
    },

    async screenshot(instance, screen, format, scale) {
      const display = displayNum(screen);
      const ext = format === "png" ? "png" : "jpg";
      const remote = `/tmp/bops-shot.${ext}`;
      const scalePct = Math.round(scale * 100);
      const cmd =
        format === "png"
          ? `DISPLAY=:${display} scrot -o ${remote} && convert ${remote} -resize ${scalePct}% ${remote}.tmp && mv ${remote}.tmp ${remote}`
          : `DISPLAY=:${display} scrot -o /tmp/bops-shot.png && convert /tmp/bops-shot.png -resize ${scalePct}% -quality 85 ${remote} && rm -f /tmp/bops-shot.png`;
      const shot = await driver.exec(instance, cmd, 20);
      if (shot.exitCode !== 0) throw new Error(shot.stderr || "screenshot failed");
      return pullFile(instance, remote);
    },

    async input(instance, kind, body, screen) {
      const display = displayNum(screen);
      let cmd = "";
      if (kind === "click") {
        const click = body as { x?: number; y?: number };
        const x = click.x ?? 0;
        const y = click.y ?? 0;
        cmd = `DISPLAY=:${display} xdotool mousemove ${x} ${y} click 1`;
      } else if (kind === "type") {
        const typed = body as { text?: string };
        cmd = `DISPLAY=:${display} xdotool type --delay 12 -- ${shellQuote(typed.text ?? "")}`;
      } else if (kind === "key") {
        const keyed = body as { keys?: string };
        cmd = `DISPLAY=:${display} xdotool key -- ${shellQuote(keyed.keys ?? "")}`;
      } else {
        const never: never = kind;
        throw new Error(`unknown input kind ${never}`);
      }
      const result = await driver.exec(instance, cmd, 20);
      if (result.exitCode !== 0) throw new Error(result.stderr || "input failed");
    },

    async writeFile(instance, path, contents, mode) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(binary, ["file", "push", "-", `${instance}${path}`], { shell: false });
        child.stdin?.write(contents);
        child.stdin?.end();
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`file push failed with ${code}`));
        });
      });
      const modeOct = mode.toString(8).padStart(4, "0");
      const chmod = await driver.exec(instance, `chmod ${modeOct} ${shellQuote(path)}`, 30);
      if (chmod.exitCode !== 0) throw new Error(chmod.stderr || "chmod failed");
    },

    async vncPort(instance, screenId) {
      const display = displayNum(screenId);
      const fromConfig = await run(["config", "get", instance, `user.bops.vnc.${display}`]);
      if (fromConfig.exitCode === 0 && fromConfig.stdout.trim()) {
        const port = Number(fromConfig.stdout.trim());
        if (Number.isFinite(port) && port > 0) return port;
      }
      const fallback: Record<string, number> = {
        default: 5900,
        "screen-100": 5901,
        "screen-101": 5902,
        "screen-102": 5903,
      };
      return fallback[screenId] ?? 5900;
    },

    async sshPort(instance) {
      const device = await run(["config", "device", "get", instance, "ssh", "listen"]);
      if (device.exitCode !== 0 || !device.stdout.trim()) return null;
      const listen = device.stdout.trim();
      const portPart = listen.includes(":") ? listen.slice(listen.lastIndexOf(":") + 1) : listen;
      const port = Number(portPart);
      return Number.isFinite(port) && port > 0 ? port : null;
    },
  };

  return driver;
}