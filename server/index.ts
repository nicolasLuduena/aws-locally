import http from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { course } from "../course/index.ts";
import { labDir, type LabLesson } from "../course/types.ts";
import { EMU_PORT, PROXY_PORT, ROOT, STATE, UI_PORT, WORKSPACE, awsEnv, emuFiles } from "./config.ts";
import { Emulator } from "./emulator.ts";
import { Inventory } from "./inventory.ts";
import { runBash, runChecks, writeLabFiles, type RunEnv } from "./labs.ts";
import { InspectorProxy } from "./proxy.ts";
import { Terminal } from "./terminal.ts";

const DEV = process.argv.includes("--dev");
const TOKEN = randomBytes(24).toString("hex");
const PROGRESS = join(STATE, "progress.json");
mkdirSync(STATE, { recursive: true });
mkdirSync(WORKSPACE, { recursive: true });

// ---------------------------------------------------------------- services
const emulator = new Emulator();
const terminal = new Terminal();
const proxy = new InspectorProxy(PROXY_PORT, {
  port: EMU_PORT,
  caFile: () => {
    const ca = emuFiles().ca;
    if (emulator.getStatus().state !== "running" || !existsSync(ca)) throw new Error("not running");
    return ca;
  },
});
const direct = (cwd = WORKSPACE): RunEnv => ({ env: awsEnv(`https://127.0.0.1:${EMU_PORT}`), cwd });
const inventory = new Inventory(() => direct());

// ---------------------------------------------------------------- websocket fan-out
const clients = new Set<WebSocket>();
function broadcast(msg: unknown) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}

emulator.on("status", (status) => {
  broadcast({ type: "status", status });
  if (status.state === "running") refreshInventory();
  if (status.state !== "running") {
    inventory.clear();
    broadcast({ type: "inventory", inventory: inventory.snapshot() });
  }
});
terminal.on("data", (data) => broadcast({ type: "term", data }));
terminal.on("reset", () => broadcast({ type: "term-reset" }));
proxy.on("call", (call) => {
  broadcast({ type: "call", call });
  if (call.mutating && call.status < 400) scheduleRefresh(call.service);
});

let pending = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let refreshing: Promise<void> | null = null;
function scheduleRefresh(service: string) {
  pending.add(service);
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    const services = [...pending];
    pending = new Set();
    await refreshing;
    refreshing = inventory.refresh(services);
    await refreshing;
    broadcast({ type: "inventory", inventory: inventory.snapshot() });
  }, 700);
}
async function refreshInventory() {
  if (emulator.getStatus().state !== "running") return;
  await refreshing;
  refreshing = inventory.refresh();
  await refreshing;
  broadcast({ type: "inventory", inventory: inventory.snapshot() });
}

// ---------------------------------------------------------------- progress
type Progress = {
  lessons: Record<string, number>;
  tasks: Record<string, Record<string, boolean>>;
  quizzes: Record<string, { score: number; total: number; at: number }>;
};
function loadProgress(): Progress {
  try {
    return { lessons: {}, tasks: {}, quizzes: {}, ...JSON.parse(readFileSync(PROGRESS, "utf8")) };
  } catch {
    return { lessons: {}, tasks: {}, quizzes: {} };
  }
}
function saveProgress(p: Progress) {
  writeFileSync(PROGRESS, JSON.stringify(p, null, 2));
}

function findLab(moduleId: string, lessonId: string): LabLesson | null {
  const l = course.modules.find((m) => m.id === moduleId)?.lessons.find((x) => x.id === lessonId);
  return l && l.kind === "lab" ? l : null;
}

// ---------------------------------------------------------------- http
async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString();
  return s ? JSON.parse(s) : {};
}
function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

const allowedHost = (h = "") => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h);

async function api(req: http.IncomingMessage, res: http.ServerResponse, path: string) {
  if (req.headers["x-session-token"] !== TOKEN) return json(res, 403, { error: "bad session token — reload the page" });
  const m = req.method ?? "GET";

  if (m === "GET" && path === "/api/state") {
    return json(res, 200, {
      status: emulator.getStatus(),
      calls: proxy.calls.slice(-300),
      inventory: inventory.snapshot(),
      progress: loadProgress(),
      ports: { ui: UI_PORT, emulator: EMU_PORT, proxy: PROXY_PORT },
      workspace: WORKSPACE,
    });
  }
  if (m === "POST" && path === "/api/emulator/start") {
    await emulator.start();
    return json(res, 200, emulator.getStatus());
  }
  if (m === "POST" && path === "/api/emulator/stop") {
    await emulator.stop();
    return json(res, 200, emulator.getStatus());
  }
  if (m === "POST" && path === "/api/emulator/reset") {
    await emulator.restart();
    proxy.clear();
    broadcast({ type: "calls-cleared" });
    return json(res, 200, emulator.getStatus());
  }
  if (m === "GET" && path === "/api/emulator/logs") return json(res, 200, { logs: emulator.logs });
  if (m === "POST" && path === "/api/calls/clear") {
    proxy.clear();
    broadcast({ type: "calls-cleared" });
    return json(res, 200, {});
  }
  if (m === "POST" && path === "/api/inventory/refresh") {
    await refreshInventory();
    return json(res, 200, inventory.snapshot());
  }
  if (m === "POST" && path === "/api/terminal/run") {
    const { command } = await readJson(req);
    terminal.run(String(command ?? ""));
    return json(res, 200, {});
  }
  if (m === "POST" && path === "/api/terminal/restart") {
    terminal.restart();
    return json(res, 200, {});
  }
  if (m === "POST" && path === "/api/progress") {
    const body = await readJson(req);
    const p = loadProgress();
    if (body.lesson) {
      if (body.done) p.lessons[body.lesson] = Date.now();
      else delete p.lessons[body.lesson];
    }
    if (body.quiz) p.quizzes[body.quiz] = { score: body.score, total: body.total, at: Date.now() };
    if (body.reset) Object.assign(p, { lessons: {}, tasks: {}, quizzes: {} });
    saveProgress(p);
    return json(res, 200, p);
  }

  const lab = /^\/api\/labs\/([\w-]+)\/([\w-]+)\/(prepare|check)$/.exec(path);
  if (m === "POST" && lab) {
    const [, moduleId, lessonId, action] = lab;
    const lesson = findLab(moduleId, lessonId);
    if (!lesson) return json(res, 404, { error: "no such lab" });
    if (emulator.getStatus().state !== "running") return json(res, 409, { error: "Start the emulator first." });
    const dir = join(WORKSPACE, labDir(moduleId, lessonId));
    if (action === "prepare") {
      const { overwrite } = await readJson(req);
      writeLabFiles(lesson.lab, dir, !!overwrite);
      let out = { code: 0, stdout: "", stderr: "" };
      if (lesson.lab.setup) out = await runBash(lesson.lab.setup, direct(dir));
      terminal.run(`cd ${JSON.stringify(dir)} && ls`);
      return json(res, 200, { ok: out.code === 0, output: (out.stdout + out.stderr).trim(), dir });
    }
    mkdirSync(dir, { recursive: true });
    const results = await runChecks(lesson.lab, direct(dir));
    const p = loadProgress();
    const key = `${moduleId}/${lessonId}`;
    p.tasks[key] = Object.fromEntries(results.map((r) => [r.id, r.ok]));
    if (results.every((r) => r.ok)) p.lessons[key] = p.lessons[key] ?? Date.now();
    saveProgress(p);
    return json(res, 200, { results, progress: p });
  }
  return json(res, 404, { error: "not found" });
}

// Static files / Vite
let vite: any = null;
if (DEV) {
  const { createServer } = await import("vite");
  vite = await createServer({ root: ROOT, server: { middlewareMode: true, hmr: { port: UI_PORT + 1 } }, appType: "custom" });
}
const DIST = join(ROOT, "dist");
const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

async function indexHtml(url: string): Promise<string> {
  let html = readFileSync(DEV ? join(ROOT, "index.html") : join(DIST, "index.html"), "utf8");
  if (vite) html = await vite.transformIndexHtml(url, html);
  return html.replace("</head>", `<meta name="session-token" content="${TOKEN}"></head>`);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!allowedHost(req.headers.host)) {
      res.writeHead(421).end("Misdirected request");
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url.pathname);
    if (vite) {
      if (url.pathname === "/" || !extname(url.pathname)) {
        res.writeHead(200, { "content-type": "text/html" }).end(await indexHtml(url.pathname));
        return;
      }
      return vite.middlewares(req, res);
    }
    const file = normalize(join(DIST, url.pathname));
    if (file.startsWith(DIST) && existsSync(file) && statSync(file).isFile() && url.pathname !== "/index.html") {
      res.writeHead(200, {
        "content-type": MIME[extname(file)] ?? "application/octet-stream",
        "cache-control": url.pathname.startsWith("/assets/") ? "max-age=31536000, immutable" : "no-cache",
      });
      createReadStream(file).pipe(res);
      return;
    }
    if (!existsSync(join(DIST, "index.html"))) {
      res.writeHead(500).end("Run `npm run build` (or `npm start`) first, or use `npm run dev`.");
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(await indexHtml(url.pathname));
  } catch (e: any) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e?.message ?? e) });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = req.headers.origin ?? "";
  const originOk = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
  if (url.pathname !== "/ws" || url.searchParams.get("token") !== TOKEN || !originOk || !allowedHost(req.headers.host)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: "term-history", data: terminal.history() }));
    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "term-in") terminal.write(String(msg.data));
      if (msg.type === "resize") terminal.resize(Number(msg.rows), Number(msg.cols));
    });
    ws.on("close", () => clients.delete(ws));
  });
});

// ---------------------------------------------------------------- boot
await proxy.listen().catch((e) => {
  console.error(`Cannot listen on proxy port ${PROXY_PORT}: ${e.message}. Set PROXY_PORT to another port.`);
  process.exit(1);
});
server.listen(UI_PORT, "127.0.0.1", () => {
  console.log(`\n  aws-locally  →  http://127.0.0.1:${UI_PORT}\n`);
  console.log(`  emulator       https://127.0.0.1:${EMU_PORT}  (state in memory; reset = restart)`);
  console.log(`  inspector      http://127.0.0.1:${PROXY_PORT}  (the course terminal's AWS_ENDPOINT_URL)\n`);
});
terminal.start();
emulator.start();

const shutdown = async () => {
  await emulator.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
