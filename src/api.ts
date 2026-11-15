import { useEffect, useSyncExternalStore } from "react";

const TOKEN = document.querySelector<HTMLMetaElement>('meta[name="session-token"]')?.content ?? "";

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-session-token": TOKEN, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

// ------------------------------------------------------------------ types
export type EmuState = "stopped" | "starting" | "running" | "error" | "missing";
export interface EmuStatus {
  state: EmuState;
  version: string | null;
  port: number;
  startedAt: number | null;
  message: string;
}
export interface ApiCall {
  id: number;
  time: number;
  durationMs: number;
  method: string;
  path: string;
  host: string;
  service: string;
  operation: string;
  status: number;
  errorCode: string;
  protocol: string;
  mutating: boolean;
  reqHeaders: Record<string, string>;
  reqBody: string;
  resHeaders: Record<string, string>;
  resBody: string;
}
export interface InvItem {
  name: string;
  detail?: string;
  status?: string;
}
export interface InvSection {
  id: string;
  title: string;
  group: string;
  items: InvItem[];
  error?: string;
}
export interface Vpc {
  id: string;
  cidr: string;
  name: string;
  isDefault: boolean;
  igw: string | null;
  nats: string[];
  subnets: { id: string; cidr: string; az: string; name: string; public: boolean; instances: { id: string; state: string; ip: string; name: string }[] }[];
  securityGroups: { id: string; name: string; rules: string[] }[];
}
export interface Progress {
  lessons: Record<string, number>;
  tasks: Record<string, Record<string, boolean>>;
  quizzes: Record<string, { score: number; total: number; at: number }>;
}
export interface AppState {
  connected: boolean;
  status: EmuStatus;
  calls: ApiCall[];
  inventory: { sections: InvSection[]; network: Vpc[] };
  progress: Progress;
  ports: { ui: number; emulator: number; proxy: number };
  workspace: string;
  inventoryAt: number;
}

// ------------------------------------------------------------------ store
let state: AppState = {
  connected: false,
  status: { state: "stopped", version: null, port: 9297, startedAt: null, message: "Connecting…" },
  calls: [],
  inventory: { sections: [], network: [] },
  progress: { lessons: {}, tasks: {}, quizzes: {} },
  ports: { ui: 0, emulator: 9297, proxy: 9298 },
  workspace: "",
  inventoryAt: 0,
};
const listeners = new Set<() => void>();
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}
export const getState = () => state;

// Terminal output is high-volume: deliver it through its own channel.
type TermListener = (msg: { kind: "data" | "history" | "reset"; data: string }) => void;
const termListeners = new Set<TermListener>();
export function onTerminal(l: TermListener) {
  termListeners.add(l);
  return () => {
    termListeners.delete(l);
  };
}

let ws: WebSocket | null = null;
export function sendWs(msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/ws?token=${TOKEN}`);
  ws = sock;
  sock.onopen = async () => {
    try {
      const s = await api<any>("/api/state");
      setState({ ...s, connected: true, inventoryAt: Date.now() });
    } catch {
      setState({ connected: true });
    }
  };
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case "term":
        termListeners.forEach((l) => l({ kind: "data", data: msg.data }));
        break;
      case "term-history":
        termListeners.forEach((l) => l({ kind: "history", data: msg.data }));
        break;
      case "term-reset":
        termListeners.forEach((l) => l({ kind: "reset", data: "" }));
        break;
      case "status":
        setState({ status: msg.status });
        break;
      case "call":
        setState((s) => ({ calls: [...s.calls.slice(-999), msg.call] }));
        break;
      case "calls-cleared":
        setState({ calls: [] });
        break;
      case "inventory":
        setState({ inventory: msg.inventory, inventoryAt: Date.now() });
        break;
    }
  };
  sock.onclose = () => {
    setState({ connected: false });
    setTimeout(connect, 1500);
  };
}

export function useConnection() {
  useEffect(() => {
    if (!ws) connect();
  }, []);
}

// ------------------------------------------------------------------ actions
export const runInTerminal = (command: string) => {
  window.dispatchEvent(new CustomEvent("awsl:show-tab", { detail: "terminal" }));
  return api("/api/terminal/run", { command });
};
export const setLessonDone = async (lesson: string, done: boolean) =>
  setState({ progress: await api<Progress>("/api/progress", { lesson, done }) });
export const saveQuiz = async (quiz: string, score: number, total: number) =>
  setState({ progress: await api<Progress>("/api/progress", { quiz, score, total }) });
