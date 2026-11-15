import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCOUNT, EMU_PORT, PROXY_PORT, REGION, STATE, WORKSPACE, awsEnv } from "./config.ts";

const RC = `
# aws-locally shell. Your real ~/.bashrc is not loaded, so nothing here can
# reach a real AWS account: every AWS_* variable points at the local emulator.
export PS1='\\[\\e[38;5;214m\\]aws-locally\\[\\e[0m\\]:\\[\\e[38;5;75m\\]\\W\\[\\e[0m\\]\\$ '
export ACCOUNT=${ACCOUNT}
export TERM=xterm-256color
alias ll='ls -la'
alias awsj='aws --output json'
complete -C aws_completer aws 2>/dev/null

# Call an API Gateway API by id: apicall <api-id> [path] [curl args...]
# The emulator routes on the Host header, exactly like the real execute-api domain.
apicall() {
  local id="$1"; local path="\${2:-/}"; shift; shift 2>/dev/null
  curl -sS -H "Host: $id.execute-api.${REGION}.amazonaws.com" "$AWS_ENDPOINT_URL$path" "$@"; echo
}

# Show what the emulator endpoint / credentials are.
whereami() {
  echo "endpoint (inspector proxy): $AWS_ENDPOINT_URL"
  echo "emulator (direct, HTTPS):   https://127.0.0.1:${EMU_PORT}"
  aws sts get-caller-identity --output table
}
cd "${WORKSPACE}"
echo -e "\\e[2mConnected to AWS Emulator through the inspector proxy on :${PROXY_PORT}. Try: aws sts get-caller-identity\\e[0m"
`;

/** One persistent shell shared by every browser tab. */
export class Terminal extends EventEmitter {
  private proc: ChildProcess | null = null;
  private scrollback = "";

  start() {
    if (this.proc) return;
    mkdirSync(WORKSPACE, { recursive: true });
    mkdirSync(STATE, { recursive: true });
    const rc = join(STATE, "bashrc");
    writeFileSync(rc, RC);
    const env = awsEnv(`http://127.0.0.1:${PROXY_PORT}`);
    const p = spawn(
      "python3",
      ["-I", join(import.meta.dirname, "pty_bridge.py"), WORKSPACE, "bash", "--rcfile", rc, "-i"],
      { env: { ...env, TERM: "xterm-256color", HOME: process.env.HOME ?? WORKSPACE }, stdio: ["pipe", "pipe", "pipe", "pipe"] },
    );
    this.proc = p;
    p.stdout!.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      this.scrollback = (this.scrollback + s).slice(-200_000);
      this.emit("data", s);
    });
    p.stderr!.on("data", (d: Buffer) => this.emit("data", d.toString("utf8")));
    p.on("exit", () => {
      if (this.proc !== p) return;
      this.proc = null;
      this.emit("data", "\r\n\x1b[2m[shell exited — press any key to start a new one]\x1b[0m\r\n");
      this.emit("exit");
    });
  }

  history(): string {
    return this.scrollback;
  }

  write(data: string) {
    if (!this.proc) {
      this.scrollback = "";
      this.start();
      return;
    }
    this.proc.stdin!.write(data);
  }

  resize(rows: number, cols: number) {
    const ctl = this.proc?.stdio[3] as NodeJS.WritableStream | undefined;
    if (ctl && rows > 0 && cols > 0) ctl.write(`${Math.floor(rows)} ${Math.floor(cols)}\n`);
  }

  /** Type a command into the shell as if the learner pasted it, then run it. */
  run(command: string) {
    if (!this.proc) this.start();
    // Bracketed paste keeps multi-line commands intact in bash's line editor.
    this.proc!.stdin!.write(`\x1b[200~${command.replace(/\n+$/, "")}\x1b[201~\r`);
  }

  restart() {
    const p = this.proc;
    this.proc = null;
    p?.kill("SIGKILL");
    this.scrollback = "";
    this.start();
    this.emit("reset");
  }
}
