import { useEffect, useState } from "react";
import type { Course } from "../../course/types.ts";
import { lessonKey } from "../../course/types.ts";
import { api, useApp } from "../api.ts";
import { href, type Route } from "../route.ts";

function uptime(since: number | null) {
  if (!since) return "";
  const s = Math.floor((Date.now() - since) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function Header({ course, onToggleNav }: { course: Course; onToggleNav: () => void }) {
  const status = useApp((s) => s.status);
  const connected = useApp((s) => s.connected);
  const lessons = useApp((s) => s.progress.lessons);
  const [busy, setBusy] = useState("");
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 10_000);
    return () => clearInterval(t);
  }, []);
  const total = course.modules.reduce((n, m) => n + m.lessons.length, 0);
  const done = course.modules.reduce((n, m) => n + m.lessons.filter((l) => lessons[lessonKey(m.id, l.id)]).length, 0);

  const act = async (what: "start" | "stop" | "reset") => {
    if (what === "reset" && !confirm("Reset the emulator? It restarts, and every emulated resource is discarded.")) return;
    setBusy(what);
    try {
      await api(`/api/emulator/${what}`, {});
    } finally {
      setBusy("");
    }
  };
  const state = connected ? status.state : "offline";
  const label: Record<string, string> = {
    running: "Emulator running",
    starting: "Starting…",
    stopped: "Emulator stopped",
    error: "Emulator error",
    missing: "Emulator not installed",
    offline: "Server offline",
  };

  return (
    <header className="topbar">
      <button className="btn ghost icon nav-toggle" onClick={onToggleNav} aria-label="Toggle course outline">
        ☰
      </button>
      <a className="brand" href="#/">
        <img className="brand-mark" src="/favicon.svg" width={22} height={22} alt="" />
        <span>
          aws<span className="brand-dim">-locally</span>
        </span>
      </a>
      <div className="course-progress" title={`${done} of ${total} lessons complete`}>
        <div className="meter">
          <div className="meter-fill" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
        <span className="sm muted">
          {done}/{total}
        </span>
      </div>
      <span className="grow" />
      <div className={`emu-pill st-${state}`} title={status.message}>
        <span className="pulse" aria-hidden />
        <span>{label[state]}</span>
        {status.version && <span className="muted mono xs">v{status.version}</span>}
        {status.state === "running" && <span className="muted mono xs">:{status.port} · up {uptime(status.startedAt)}</span>}
      </div>
      {status.state === "running" || status.state === "starting" ? (
        <>
          <button className="btn sm" onClick={() => act("reset")} disabled={!!busy} title="Restart the emulator with empty state">
            {busy === "reset" ? "Resetting…" : "Reset state"}
          </button>
          <button className="btn ghost sm" onClick={() => act("stop")} disabled={!!busy}>
            Stop
          </button>
        </>
      ) : (
        <button className="btn primary sm" onClick={() => act("start")} disabled={!!busy || status.state === "missing" || !connected}>
          {busy === "start" ? "Starting…" : "Start emulator"}
        </button>
      )}
    </header>
  );
}

export function Sidebar({ course, route, open }: { course: Course; route: Route; open: boolean }) {
  const lessons = useApp((s) => s.progress.lessons);
  const quizzes = useApp((s) => s.progress.quizzes);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const activeModule = route.view !== "home" ? route.moduleId : null;

  return (
    <nav className={`sidebar${open ? " open" : ""}`} aria-label="Course outline">
      <a className={`side-home${route.view === "home" ? " on" : ""}`} href="#/">
        Course overview
      </a>
      {course.modules.map((m) => {
        const isOpen = expanded[m.id] ?? m.id === activeModule;
        const done = m.lessons.filter((l) => lessons[lessonKey(m.id, l.id)]).length;
        const complete = done === m.lessons.length;
        return (
          <div key={m.id} className={`side-mod${m.id === activeModule ? " active" : ""}`}>
            <button className="side-mod-head" onClick={() => setExpanded({ ...expanded, [m.id]: !isOpen })} aria-expanded={isOpen}>
              <span className={`mod-num${complete ? " done" : ""}`}>{complete ? "✓" : m.number}</span>
              <span className="mod-title">{m.title}</span>
              <span className="mod-count">
                {done}/{m.lessons.length}
              </span>
            </button>
            {isOpen && (
              <ul>
                {m.lessons.map((l) => {
                  const on = route.view === "lesson" && route.moduleId === m.id && route.lessonId === l.id;
                  const isDone = !!lessons[lessonKey(m.id, l.id)];
                  return (
                    <li key={l.id}>
                      <a className={`side-lesson${on ? " on" : ""}${isDone ? " done" : ""}`} href={href({ view: "lesson", moduleId: m.id, lessonId: l.id })}>
                        <span className={`l-icon ${l.kind}`} aria-hidden>
                          {isDone ? "✓" : l.kind === "lab" ? "⌘" : "·"}
                        </span>
                        <span>{l.title}</span>
                      </a>
                    </li>
                  );
                })}
                {m.quiz && m.quiz.length > 0 && (
                  <li>
                    <a className={`side-lesson${route.view === "quiz" && route.moduleId === m.id ? " on" : ""}${quizzes[m.id] ? " done" : ""}`} href={href({ view: "quiz", moduleId: m.id })}>
                      <span className="l-icon quiz" aria-hidden>
                        ?
                      </span>
                      <span>
                        Quiz{quizzes[m.id] ? ` · ${quizzes[m.id].score}/${quizzes[m.id].total}` : ""}
                      </span>
                    </a>
                  </li>
                )}
              </ul>
            )}
          </div>
        );
      })}
    </nav>
  );
}
