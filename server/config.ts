import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
export const TOOLS = join(ROOT, ".tools");
export const STATE = join(ROOT, ".state");
export const WORKSPACE = join(ROOT, "workspace");

/** Where the emulator writes its credentials, config and CA (it uses $HOME). */
export const EMU_HOME = join(STATE, "emulator-home");

export const UI_PORT = Number(process.env.UI_PORT ?? 4380);
export const EMU_PORT = Number(process.env.EMU_PORT ?? 9297);
/** The inspector proxy that the terminal talks to. Forwards to the emulator. */
export const PROXY_PORT = Number(process.env.PROXY_PORT ?? 9298);
export const REGION = "us-east-1";
export const ACCOUNT = "000000000000";

/** Locate the emulator binary: project-local install first, then $PATH. */
export function emulatorBinary(): string {
  const local = join(TOOLS, "emu", "opt", "aws-emulator", "bin", "aws-emulator");
  if (existsSync(local)) return local;
  if (existsSync("/opt/aws-emulator/bin/aws-emulator")) return "/opt/aws-emulator/bin/aws-emulator";
  return "aws-emulator";
}

/**
 * How to launch the emulator. Natively when a binary is installed (Linux),
 * otherwise in the `aws-emulator` Docker image that `npm run setup` builds
 * (macOS/Windows). In Docker the container uses the same $HOME path as the
 * host, mounted, so the credential/CA file paths it writes are valid here too.
 */
export function emulatorCommand(port: number, home: string): { cmd: string; args: string[] } {
  const bin = emulatorBinary();
  const useDocker = process.env.EMULATOR_MODE === "docker" || (bin === "aws-emulator" && !onPath("aws-emulator"));
  const opts = ["--telemetry", "off", "-p", String(port)];
  if (!useDocker) return { cmd: bin, args: opts };
  const dir = join(home, ".aws", "emulator");
  const user = process.platform === "linux" && process.getuid ? ["--user", `${process.getuid()}:${process.getgid!()}`] : [];
  return {
    cmd: "docker",
    args: ["run", "--rm", "-i", "--memory=2g", "--memory-swap=2g", "-p", `127.0.0.1:${port}:${port}`, ...user,
      "-e", `HOME=${home}`, "-v", `${dir}:${dir}`, "aws-emulator", ...opts],
  };
}

function onPath(cmd: string): boolean {
  return (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, cmd)));
}

/** PATH with the project-local tools (aws CLI, terraform) first. */
export function toolPath(): string {
  return [join(TOOLS, "bin"), process.env.PATH ?? ""].join(":");
}

export function emuFiles(port = EMU_PORT, home = EMU_HOME) {
  const dir = join(home, ".aws", "emulator", String(port));
  return {
    dir,
    credentials: join(dir, "emulator_credentials"),
    config: join(dir, "config"),
    ca: join(dir, "ca.pem"),
  };
}

/**
 * Environment for any process that should talk to the emulator.
 * `endpoint` is the proxy for the learner's terminal (so calls show up in the
 * inspector) and the emulator itself for internal checks.
 */
export function awsEnv(endpoint: string, port = EMU_PORT, home = EMU_HOME): Record<string, string> {
  const f = emuFiles(port, home);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (/^AWS_/.test(k)) continue; // never leak real AWS credentials or profiles
    env[k] = v;
  }
  return {
    ...env,
    PATH: toolPath(),
    AWS_ENDPOINT_URL: endpoint,
    AWS_SHARED_CREDENTIALS_FILE: f.credentials,
    AWS_CONFIG_FILE: f.config,
    AWS_CA_BUNDLE: f.ca,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_DISABLE_HOST_PREFIX_INJECTION: "true",
    AWS_REGION: REGION,
    AWS_DEFAULT_REGION: REGION,
    AWS_PAGER: "",
    AWS_CLI_AUTO_PROMPT: "off",
    TF_PLUGIN_CACHE_DIR: join(TOOLS, "tf-cache"),
    TF_IN_AUTOMATION: "",
  };
}
