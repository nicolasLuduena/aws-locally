import { useEffect, useRef, useState } from "react";
import { course } from "../course/index.ts";
import { lessonKey, type Lesson, type Module } from "../course/types.ts";
import { setLessonDone, useApp, useConnection } from "./api.ts";
import { Header, Sidebar } from "./components/Chrome.tsx";
import { LabPanel } from "./components/LabPanel.tsx";
import { Markdown } from "./components/Markdown.tsx";
import { Quiz } from "./components/Quiz.tsx";
import { Workbench } from "./components/Workbench.tsx";
import { href, useRoute, type Route } from "./route.ts";

const PHASES: { title: string; blurb: string; ids: string[] }[] = [
  { title: "Foundations", blurb: "How the platform is wired, and who is allowed to do what.", ids: ["foundations", "iam"] },
  { title: "Core infrastructure", blurb: "Networks, machines, storage and databases: the substrate.", ids: ["vpc", "compute", "storage", "databases"] },
  { title: "Application platforms", blurb: "Decoupled, serverless and containerised workloads.", ids: ["messaging", "serverless", "containers"] },
  { title: "Operate securely", blurb: "Encryption, secrets, and seeing what your systems are doing.", ids: ["security", "observability"] },
  { title: "Automate everything", blurb: "Infrastructure as code, pipelines and safe deployments.", ids: ["cloudformation", "terraform", "cicd"] },
  { title: "Prove it", blurb: "Build, ship and operate a production-style platform end to end.", ids: ["capstone"] },
];

export function App() {
  useConnection();
  const route = useRoute();
  const [navOpen, setNavOpen] = useState(false);
  const [split, setSplit] = useState(() => Number(localStorage.getItem("awsl.split")) || 46);
  const main = useRef<HTMLElement>(null);

  useEffect(() => {
    setNavOpen(false);
    main.current?.scrollTo({ top: 0 });
  }, [route]);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const pct = ((window.innerWidth - ev.clientX) / window.innerWidth) * 100;
      const v = Math.min(70, Math.max(25, pct));
      setSplit(v);
      localStorage.setItem("awsl.split", String(v));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("dragging");
    };
    document.body.classList.add("dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="app" style={{ ["--split" as any]: `${split}%` }}>
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
        <defs>
          <marker id="awsl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" fill="context-stroke" />
          </marker>
        </defs>
      </svg>
      <Header course={course} onToggleNav={() => setNavOpen(!navOpen)} />
      <div className="body">
        <Sidebar course={course} route={route} open={navOpen} />
        <main className="main" ref={main}>
          <Content route={route} />
        </main>
        <div className="splitter" onPointerDown={startDrag} role="separator" aria-orientation="vertical" aria-label="Resize workbench" />
        <aside className="bench">
          <Workbench />
        </aside>
      </div>
    </div>
  );
}

function Content({ route }: { route: Route }) {
  if (route.view === "home") return <Home />;
  const m = course.modules.find((x) => x.id === route.moduleId);
  if (!m) return <NotFound />;
  if (route.view === "module") return <ModuleOverview module={m} />;
  if (route.view === "quiz")
    return (
      <article className="page">
        <Crumbs module={m} title="Quiz" />
        <h1>{m.title}: quiz</h1>
        <Quiz module={m} />
        <Pager module={m} index={m.lessons.length} />
      </article>
    );
  const i = m.lessons.findIndex((l) => l.id === route.lessonId);
  if (i < 0) return <NotFound />;
  return <LessonView module={m} lesson={m.lessons[i]} index={i} />;
}

function Crumbs({ module, title }: { module: Module; title: string }) {
  return (
    <div className="crumbs">
      <a href={href({ view: "module", moduleId: module.id })}>
        {module.number} · {module.title}
      </a>
      <span aria-hidden>/</span>
      <span>{title}</span>
    </div>
  );
}

function LessonView({ module, lesson, index }: { module: Module; lesson: Lesson; index: number }) {
  const key = lessonKey(module.id, lesson.id);
  const done = useApp((s) => !!s.progress.lessons[key]);
  return (
    <article className="page">
      <Crumbs module={module} title={lesson.kind === "lab" ? "Lab" : `Lesson ${index + 1}`} />
      <h1>{lesson.title}</h1>
      <div className="lesson-meta">
        <span className={`kind ${lesson.kind}`}>{lesson.kind === "lab" ? "Hands-on lab" : "Reading"}</span>
        <span>{lesson.minutes} min</span>
        {done && <span className="done-tag">✓ completed</span>}
      </div>
      <Markdown source={lesson.body} />
      {lesson.kind === "lab" && <LabPanel moduleId={module.id} lesson={lesson} />}
      {lesson.kind === "reading" && (
        <div className="mark-done">
          <button className={`btn${done ? "" : " primary"}`} onClick={() => setLessonDone(key, !done)}>
            {done ? "✓ Marked complete (undo)" : "Mark as complete"}
          </button>
        </div>
      )}
      <Pager module={module} index={index} />
    </article>
  );
}

function Pager({ module, index }: { module: Module; index: number }) {
  const mi = course.modules.indexOf(module);
  const items: { route: Route; label: string }[] = [
    ...module.lessons.map((l) => ({ route: { view: "lesson", moduleId: module.id, lessonId: l.id } as Route, label: l.title })),
    ...(module.quiz?.length ? [{ route: { view: "quiz", moduleId: module.id } as Route, label: "Quiz" }] : []),
  ];
  const prev = items[index - 1];
  let next = items[index + 1];
  const nextModule = course.modules[mi + 1];
  if (!next && nextModule) next = { route: { view: "module", moduleId: nextModule.id }, label: `Next module: ${nextModule.title}` };
  return (
    <nav className="pager">
      {prev ? (
        <a className="pager-link" href={href(prev.route)}>
          <span className="muted xs">← Previous</span>
          <span>{prev.label}</span>
        </a>
      ) : (
        <span />
      )}
      {next && (
        <a className="pager-link next" href={href(next.route)}>
          <span className="muted xs">Next →</span>
          <span>{next.label}</span>
        </a>
      )}
    </nav>
  );
}

function ModuleOverview({ module }: { module: Module }) {
  const lessons = useApp((s) => s.progress.lessons);
  const quiz = useApp((s) => s.progress.quizzes[module.id]);
  const minutes = module.lessons.reduce((n, l) => n + l.minutes, 0);
  const first = module.lessons.find((l) => !lessons[lessonKey(module.id, l.id)]) ?? module.lessons[0];
  return (
    <article className="page">
      <div className="eyebrow">Module {module.number}</div>
      <h1>{module.title}</h1>
      <p className="lede">{module.summary}</p>
      <div className="svc-row">
        {module.services.map((s) => (
          <span className="svc" key={s}>
            {s}
          </span>
        ))}
        <span className="muted sm">≈ {Math.round(minutes / 5) * 5} min</span>
      </div>
      <ol className="outline">
        {module.lessons.map((l, i) => {
          const d = !!lessons[lessonKey(module.id, l.id)];
          return (
            <li key={l.id} className={d ? "done" : ""}>
              <a href={href({ view: "lesson", moduleId: module.id, lessonId: l.id })}>
                <span className="o-n">{d ? "✓" : i + 1}</span>
                <span className="o-title">{l.title}</span>
                <span className={`kind ${l.kind}`}>{l.kind === "lab" ? "lab" : "reading"}</span>
                <span className="muted sm">{l.minutes} min</span>
              </a>
            </li>
          );
        })}
        {module.quiz?.length ? (
          <li className={quiz ? "done" : ""}>
            <a href={href({ view: "quiz", moduleId: module.id })}>
              <span className="o-n">?</span>
              <span className="o-title">Quiz: {module.quiz.length} questions</span>
              <span className="kind quiz">quiz</span>
              <span className="muted sm">{quiz ? `best ${quiz.score}/${quiz.total}` : ""}</span>
            </a>
          </li>
        ) : null}
      </ol>
      {first && (
        <a className="btn primary" href={href({ view: "lesson", moduleId: module.id, lessonId: first.id })}>
          {module.lessons.some((l) => lessons[lessonKey(module.id, l.id)]) ? "Continue" : "Start module"} →
        </a>
      )}
    </article>
  );
}

function Home() {
  const lessons = useApp((s) => s.progress.lessons);
  const status = useApp((s) => s.status);
  const byId = new Map(course.modules.map((m) => [m.id, m]));
  const placed = new Set(PHASES.flatMap((p) => p.ids));
  const extra = course.modules.filter((m) => !placed.has(m.id));
  const phases = extra.length ? [...PHASES, { title: "More", blurb: "", ids: extra.map((m) => m.id) }] : PHASES;
  const labs = course.modules.reduce((n, m) => n + m.lessons.filter((l) => l.kind === "lab").length, 0);
  const total = course.modules.reduce((n, m) => n + m.lessons.length, 0);
  const next = course.modules.flatMap((m) => m.lessons.map((l) => ({ m, l }))).find(({ m, l }) => !lessons[lessonKey(m.id, l.id)]);

  return (
    <article className="page home">
      <div className="eyebrow">A hands-on course</div>
      <h1 className="hero">
        Run AWS like a DevOps engineer,
        <br />
        on your own machine.
      </h1>
      <p className="lede">
        {course.modules.length} modules, {total} lessons and {labs} auto-graded labs. Everything runs against <b>AWS Emulator</b>, AWS's local emulator of its own APIs, so you work with the real CLI, real error codes, real IaC tools and a real terminal, with no account and no bill.
      </p>
      {status.state === "missing" && (
        <div className="notice warn">
          The emulator isn't installed yet. In the repo, run <code>npm run setup</code> (it downloads AWS Emulator, the AWS CLI and Terraform into <code>.tools/</code>), then restart the server.
        </div>
      )}
      <div className="how">
        <div className="how-step">
          <span className="how-n">1</span>
          <b>Read</b>
          <span>Concepts with diagrams: how it works, why, and what goes wrong in production.</span>
        </div>
        <div className="how-step">
          <span className="how-n">2</span>
          <b>Run</b>
          <span>Every snippet has a ▶ button that types it into the terminal on the right.</span>
        </div>
        <div className="how-step">
          <span className="how-n">3</span>
          <b>Watch</b>
          <span>The API tab shows each signed HTTP call. Resources shows what now exists.</span>
        </div>
        <div className="how-step">
          <span className="how-n">4</span>
          <b>Prove</b>
          <span>Labs are checked against the emulator's actual state, not your typing.</span>
        </div>
      </div>
      {next && (
        <a className="continue" href={href({ view: "lesson", moduleId: next.m.id, lessonId: next.l.id })}>
          <span className="muted xs">{Object.keys(lessons).length ? "Continue where you left off" : "Start here"}</span>
          <span>
            {next.m.number} · {next.l.title}
          </span>
          <span aria-hidden>→</span>
        </a>
      )}
      <div className="phases">
        {phases.map((p, pi) => {
          const mods = p.ids.map((id) => byId.get(id)).filter(Boolean) as Module[];
          if (!mods.length) return null;
          return (
            <section className="phase" key={p.title}>
              <div className="phase-head">
                <span className="phase-n">{String(pi + 1).padStart(2, "0")}</span>
                <div>
                  <h2>{p.title}</h2>
                  {p.blurb && <p className="muted sm">{p.blurb}</p>}
                </div>
              </div>
              <div className="mod-grid">
                {mods.map((m) => {
                  const done = m.lessons.filter((l) => lessons[lessonKey(m.id, l.id)]).length;
                  const labsN = m.lessons.filter((l) => l.kind === "lab").length;
                  return (
                    <a key={m.id} className="mod-card" href={href({ view: "module", moduleId: m.id })}>
                      <div className="mod-card-top">
                        <span className="mod-card-num">{m.number}</span>
                        <span className="muted xs">
                          {m.lessons.length - labsN} readings · {labsN} lab{labsN === 1 ? "" : "s"}
                        </span>
                      </div>
                      <h3>{m.title}</h3>
                      <p>{m.summary}</p>
                      <div className="svc-row">
                        {m.services.slice(0, 5).map((s) => (
                          <span className="svc" key={s}>
                            {s}
                          </span>
                        ))}
                      </div>
                      <div className="meter thin">
                        <div className="meter-fill" style={{ width: `${(done / m.lessons.length) * 100}%` }} />
                      </div>
                    </a>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </article>
  );
}

function NotFound() {
  return (
    <article className="page">
      <h1>Not found</h1>
      <p>
        <a href="#/">Back to the course overview</a>
      </p>
    </article>
  );
}
