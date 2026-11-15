import { useEffect, useState } from "react";
import { api, useApp } from "../api.ts";
import { Inspector } from "./Inspector.tsx";
import { Resources } from "./Resources.tsx";
import { TerminalPane } from "./TerminalPane.tsx";

type Tab = "terminal" | "api" | "resources" | "logs";

export function Workbench() {
  const [tab, setTab] = useState<Tab>(() => (localStorageGet("awsl.tab") as Tab) || "terminal");
  const calls = useApp((s) => s.calls.length);
  const [seen, setSeen] = useState(calls);
  useEffect(() => {
    const h = (e: Event) => setTab((e as CustomEvent).detail);
    window.addEventListener("awsl:show-tab", h);
    return () => window.removeEventListener("awsl:show-tab", h);
  }, []);
  useEffect(() => {
    localStorageSet("awsl.tab", tab);
    if (tab === "api") setSeen(calls);
  }, [tab, calls]);
  const unseen = tab === "api" ? 0 : Math.max(0, calls - seen);

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "terminal", label: "Terminal" },
    { id: "api", label: "API", badge: unseen },
    { id: "resources", label: "Resources" },
    { id: "logs", label: "Emulator log" },
  ];
  return (
    <div className="workbench">
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? " on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
            {!!t.badge && <span className="badge">{t.badge > 99 ? "99+" : t.badge}</span>}
          </button>
        ))}
      </div>
      <div className="tab-panels">
        <div className="tab-panel" hidden={tab !== "terminal"}>
          <TerminalPane visible={tab === "terminal"} />
        </div>
        <div className="tab-panel" hidden={tab !== "api"}>
          <Inspector />
        </div>
        <div className="tab-panel" hidden={tab !== "resources"}>
          <Resources />
        </div>
        <div className="tab-panel" hidden={tab !== "logs"}>
          {tab === "logs" && <EmuLog />}
        </div>
      </div>
    </div>
  );
}

function EmuLog() {
  const [logs, setLogs] = useState<string[]>([]);
  const status = useApp((s) => s.status);
  useEffect(() => {
    let live = true;
    const load = () => api<{ logs: string[] }>("/api/emulator/logs").then((r) => live && setLogs(r.logs));
    load();
    const t = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [status.state]);
  return (
    <div className="emulog">
      <div className="pane-bar">
        <span className="muted sm">aws-emulator stdout/stderr (JSON lines)</span>
      </div>
      <pre className="emulog-body">
        {logs.length
          ? logs.map((l, i) => {
              let msg = l;
              try {
                const j = JSON.parse(l);
                const { message, ...rest } = j.fields ?? {};
                msg = `${j.timestamp?.slice(11, 19) ?? ""} ${j.level ?? ""} ${message ?? ""}${Object.keys(rest).length ? "  " + JSON.stringify(rest) : ""}`;
              } catch {}
              return <div key={i}>{msg}</div>;
            })
          : "No output yet."}
      </pre>
    </div>
  );
}

function localStorageGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function localStorageSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}
