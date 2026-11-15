import { useState } from "react";
import { api, runInTerminal, setState, useApp, type Progress } from "../api.ts";
import type { LabLesson } from "../../course/types.ts";
import { labDir } from "../../course/types.ts";
import { Markdown } from "./Markdown.tsx";

interface TaskResult {
  id: string;
  ok: boolean;
  message: string;
}

export function LabPanel({ moduleId, lesson }: { moduleId: string; lesson: LabLesson }) {
  const key = `${moduleId}/${lesson.id}`;
  const running = useApp((s) => s.status.state === "running");
  const saved = useApp((s) => s.progress.tasks[key]);
  const workspace = useApp((s) => s.workspace);
  const [results, setResults] = useState<Record<string, TaskResult>>({});
  const [checking, setChecking] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepOut, setPrepOut] = useState<{ ok: boolean; output: string } | null>(null);
  const [hints, setHints] = useState<Record<string, number>>({});
  const [showSolution, setShowSolution] = useState(false);
  const [error, setError] = useState("");

  const prepare = async (overwrite = false) => {
    setPreparing(true);
    setError("");
    try {
      const r = await api<{ ok: boolean; output: string }>(`/api/labs/${moduleId}/${lesson.id}/prepare`, { overwrite });
      setPrepOut(r);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPreparing(false);
    }
  };
  const check = async () => {
    setChecking(true);
    setError("");
    try {
      const r = await api<{ results: TaskResult[]; progress: Progress }>(`/api/labs/${moduleId}/${lesson.id}/check`, {});
      setResults(Object.fromEntries(r.results.map((x) => [x.id, x])));
      setState({ progress: r.progress });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setChecking(false);
    }
  };

  const passed = lesson.lab.tasks.filter((t) => results[t.id]?.ok ?? saved?.[t.id]).length;
  const total = lesson.lab.tasks.length;
  const files = Object.keys(lesson.lab.files ?? {});
  const dir = `${workspace ? workspace + "/" : "workspace/"}${labDir(moduleId, lesson.id)}`;

  return (
    <section className="lab-panel" aria-label="Lab">
      <div className="lab-head">
        <div>
          <div className="eyebrow">Hands-on lab</div>
          <div className="lab-progress">
            <div className="meter">
              <div className="meter-fill" style={{ width: `${(passed / total) * 100}%` }} />
            </div>
            <span>
              {passed}/{total} tasks
            </span>
          </div>
        </div>
        <div className="lab-actions">
          <button className="btn" onClick={() => prepare(false)} disabled={!running || preparing} title="Write starter files, create prerequisites, and cd the terminal into the lab folder">
            {preparing ? "Preparing…" : "Prepare lab"}
          </button>
          <button className="btn primary" onClick={check} disabled={!running || checking}>
            {checking ? "Checking…" : "Check my work"}
          </button>
        </div>
      </div>
      {!running && <div className="notice warn">Start the emulator (top bar) to work on this lab.</div>}
      {error && <div className="notice err">{error}</div>}
      <div className="lab-meta muted sm">
        Lab folder: <code>{dir}</code>
        {files.length > 0 && (
          <>
            {" "}· starter files: {files.map((f) => <code key={f}>{f}</code>).reduce((a: any[], b, i) => (i ? [...a, ", ", b] : [b]), [])}
            {" "}
            <button className="link" onClick={() => confirm("Overwrite starter files with fresh copies?") && prepare(true)}>
              reset files
            </button>
          </>
        )}
        {lesson.lab.setup && <> · <i>Prepare lab</i> also creates the resources this lab assumes.</>}
      </div>
      {prepOut && (
        <details className={`prep-out${prepOut.ok ? "" : " bad"}`} open={!prepOut.ok}>
          <summary>{prepOut.ok ? "✓ Lab prepared: the terminal is now in the lab folder" : "✗ Setup failed"}</summary>
          {prepOut.output && <pre>{prepOut.output}</pre>}
        </details>
      )}

      <ol className="tasks">
        {lesson.lab.tasks.map((t, i) => {
          const r = results[t.id];
          const ok = r?.ok ?? saved?.[t.id] ?? false;
          const shownHints = hints[t.id] ?? 0;
          return (
            <li key={t.id} className={`task${ok ? " ok" : r && !r.ok ? " fail" : ""}`}>
              <div className="task-head">
                <span className="task-num" aria-hidden>
                  {ok ? "✓" : i + 1}
                </span>
                <span className="task-title">{t.title}</span>
              </div>
              <Markdown source={t.description} className="prose task-desc" />
              {r && !r.ok && <Markdown source={r.message} className="prose task-feedback" />}
              {t.hints && t.hints.length > 0 && (
                <div className="hints">
                  {t.hints.slice(0, shownHints).map((h, j) => (
                    <div className="hint" key={j}>
                      <span className="hint-n">Hint {j + 1}</span>
                      <Markdown source={h} className="prose" />
                    </div>
                  ))}
                  {shownHints < t.hints.length && (
                    <button className="link" onClick={() => setHints({ ...hints, [t.id]: shownHints + 1 })}>
                      {shownHints === 0 ? "Show a hint" : "Another hint"} ({t.hints.length - shownHints} left)
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {passed === total && total > 0 && <div className="notice ok">Lab complete. Every task checks out against the emulator.</div>}

      <details className="solution" open={showSolution} onToggle={(e) => setShowSolution((e.target as HTMLDetailsElement).open)}>
        <summary>Reference solution (try it yourself first)</summary>
        {showSolution && (
          <>
            <Markdown source={"```bash\n" + lesson.lab.solution.trim() + "\n```"} />
            <button className="btn sm" onClick={() => runInTerminal(`cd ${JSON.stringify(dir)}\n` + lesson.lab.solution.trim())}>
              Run the whole solution in the terminal
            </button>
          </>
        )}
      </details>
    </section>
  );
}
