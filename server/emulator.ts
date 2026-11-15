import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { EMU_HOME, EMU_PORT, emulatorCommand, emuFiles } from "./config.ts";

export type EmuState = "stopped" | "starting" | "running" | "error" | "missing";

export interface EmuStatus {
  state: EmuState;
  version: string | null;
  port: number;
  startedAt: number | null;
  message: string;
}

export interface EmulatorOptions {
  port?: number;
  home?: string;
  /** Lines of emulator output are passed here (e.g. to a log). */
  onLog?: (line: string) => void;
}

/** Starts, health-checks and stops one aws-emulator process. */
export class Emulator extends EventEmitter {
  readonly port: number;
  readonly home: string;
  private proc: ChildProcess | null = null;
  private status: EmuStatus;
  private onLog?: (line: string) => void;
  readonly logs: string[] = [];

  constructor(opts: EmulatorOptions = {}) {
    super();
    this.port = opts.port ?? EMU_PORT;
    this.home = opts.home ?? EMU_HOME;
    this.onLog = opts.onLog;
    this.status = { state: "stopped", version: readVersion(), port: this.port, startedAt: null, message: "" };
    if (!this.status.version) this.set({ state: "missing", message: "aws-emulator is not installed. Run `npm run setup`." });
  }

  getStatus(): EmuStatus {
    return { ...this.status };
  }

  private set(patch: Partial<EmuStatus>) {
    this.status = { ...this.status, ...patch };
    this.emit("status", this.getStatus());
  }

  private log(line: string) {
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    this.onLog?.(line);
  }

  async start(): Promise<void> {
    if (this.proc) return;
    if (!this.status.version) {
      this.status.version = readVersion();
      if (!this.status.version) {
        this.set({ state: "missing", message: "aws-emulator is not installed. Run `npm run setup`." });
        return;
      }
    }
    mkdirSync(join(this.home, ".aws", "emulator"), { recursive: true });
    this.set({ state: "starting", message: "Starting emulator…", startedAt: null });
    const { cmd, args } = emulatorCommand(this.port, this.home);
    const proc = spawn(cmd, args, {
      env: { ...process.env, HOME: this.home, EMULATOR_TELEMETRY: "off" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.proc = proc;
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this.log(line);
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code, signal) => {
      const wasRunning = this.proc === proc;
      this.proc = null;
      if (!wasRunning) return;
      const clean = code === 0 || signal === "SIGTERM" || signal === "SIGINT";
      this.set({
        state: clean ? "stopped" : "error",
        startedAt: null,
        message: clean ? "Emulator stopped." : `Emulator exited (code ${code}, signal ${signal}). Check the log.`,
      });
    });

    const ok = await this.waitHealthy(30_000);
    if (ok && this.proc === proc) {
      this.set({ state: "running", startedAt: Date.now(), message: "Emulator is running. All state is in memory." });
    } else if (this.proc === proc) {
      this.set({ state: "error", message: "Emulator did not become healthy within 30s. Is the port in use?" });
    }
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 5000);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      proc.kill("SIGTERM");
    });
    this.set({ state: "stopped", startedAt: null, message: "Emulator stopped. Resources were discarded." });
  }

  /** The only way to reset emulator state: restart it. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async health(): Promise<boolean> {
    const { ca } = emuFiles(this.port, this.home);
    if (!existsSync(ca)) return false;
    return new Promise((resolve) => {
      const req = https.get(
        { host: "127.0.0.1", port: this.port, path: "/__admin/health", ca: readFileSync(ca), timeout: 1000 },
        (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  private async waitHealthy(timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (!this.proc) return false;
      if (await this.health()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }
}

function readVersion(): string | null {
  try {
    const { cmd } = emulatorCommand(0, EMU_HOME);
    const vArgs = cmd === "docker" ? ["run", "--rm", "aws-emulator", "-v"] : ["-v"];
    const out = execFileSync(cmd, vArgs, { encoding: "utf8", timeout: 30000 });
    return /Version:\s*(\S+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}
