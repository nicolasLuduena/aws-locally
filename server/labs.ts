// Runs lab setup scripts and task checks. Used by the server (when the learner
// presses "Prepare lab" / "Check") and by scripts/verify-labs.ts.

import { execFile, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AwsAttempt, CheckContext, Lab, LabTask } from "../course/types.ts";
import { ACCOUNT, REGION } from "./config.ts";

export interface RunEnv {
  /** Full process env with AWS_* pointing at an emulator. */
  env: Record<string, string>;
  /** Lab working directory. */
  cwd: string;
}

export interface TaskResult {
  id: string;
  ok: boolean;
  message: string;
}

export function runAws(args: string[], re: RunEnv, timeoutMs = 60_000): Promise<AwsAttempt> {
  return new Promise((resolvePromise) => {
    execFile(
      "aws",
      [...args, "--output", "json"],
      { env: re.env, cwd: re.cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const text = (stderr || err.message).trim();
          const code = /An error occurred \(([^)]+)\)/.exec(text)?.[1] ?? "";
          resolvePromise({ ok: false, data: null, error: text, code });
          return;
        }
        let data: any = null;
        const out = stdout.trim();
        if (out) {
          try {
            data = JSON.parse(out);
          } catch {
            data = out;
          }
        }
        resolvePromise({ ok: true, data, error: "", code: "" });
      },
    );
  });
}

export class AwsCliError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export function runBash(
  script: string,
  re: RunEnv,
  timeoutMs = 300_000,
  onOutput?: (chunk: string) => void,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const p = spawn("bash", ["-c", script], { env: re.env, cwd: re.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (c: Buffer) => {
      stdout += c;
      onOutput?.(c.toString());
    });
    p.stderr.on("data", (c: Buffer) => {
      stderr += c;
      onOutput?.(c.toString());
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

export function checkContext(re: RunEnv): CheckContext {
  return {
    account: ACCOUNT,
    region: REGION,
    tryAws: (args) => runAws(args, re),
    aws: async (args) => {
      const r = await runAws(args, re);
      if (!r.ok) throw new AwsCliError(r.error, r.code);
      return r.data;
    },
    sh: (script) => runBash(script, re, 60_000),
    readFile: async (p) => {
      const full = resolve(re.cwd, p);
      return existsSync(full) ? readFileSync(full, "utf8") : null;
    },
  };
}

export async function runTask(task: LabTask, ctx: CheckContext): Promise<TaskResult> {
  try {
    const r = await task.check(ctx);
    return { id: task.id, ok: r === true, message: r === true ? "Looks good." : r };
  } catch (e: any) {
    // An AWS error inside a check usually means "the resource isn't there yet".
    const msg = e instanceof AwsCliError ? friendlyAwsError(e) : `Check crashed: ${e?.message ?? e}`;
    return { id: task.id, ok: false, message: msg };
  }
}

function friendlyAwsError(e: AwsCliError): string {
  const line = e.message.split("\n").find((l) => l.includes("An error occurred")) ?? e.message.split("\n")[0];
  return `Not yet: ${line.replace(/^aws: \[ERROR\]: /, "")}`;
}

export async function runChecks(lab: Lab, re: RunEnv): Promise<TaskResult[]> {
  const ctx = checkContext(re);
  const out: TaskResult[] = [];
  // Sequential: checks are cheap and order makes feedback easier to follow.
  for (const task of lab.tasks) out.push(await runTask(task, ctx));
  return out;
}

export function writeLabFiles(lab: Lab, dir: string, overwrite: boolean) {
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(lab.files ?? {})) {
    const full = join(dir, rel);
    if (!overwrite && existsSync(full)) continue;
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, { mode: rel.endsWith(".sh") ? 0o755 : 0o644 });
  }
}
