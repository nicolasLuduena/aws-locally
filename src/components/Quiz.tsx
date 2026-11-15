import { useState } from "react";
import type { Module } from "../../course/types.ts";
import { saveQuiz, useApp } from "../api.ts";
import { Markdown } from "./Markdown.tsx";

export function Quiz({ module }: { module: Module }) {
  const questions = module.quiz ?? [];
  const best = useApp((s) => s.progress.quizzes[module.id]);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const score = questions.filter((q, i) => answers[i] === q.answer).length;
  const all = Object.keys(answers).length === questions.length;

  const submit = () => {
    setSubmitted(true);
    saveQuiz(module.id, score, questions.length);
  };
  const retry = () => {
    setAnswers({});
    setSubmitted(false);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="quiz">
      <p className="lede">
        {questions.length} scenario questions. They test judgement, not trivia. Read each explanation, including the ones you got right.
        {best && (
          <span className="muted">
            {" "}
            Last attempt: {best.score}/{best.total}.
          </span>
        )}
      </p>
      {questions.map((q, i) => {
        const picked = answers[i];
        return (
          <fieldset key={i} className={`q${submitted ? (picked === q.answer ? " right" : " wrong") : ""}`}>
            <legend>
              <span className="q-n">{i + 1}</span>
              <Markdown source={q.q} className="prose q-text" />
            </legend>
            <div className="opts">
              {q.options.map((o, j) => {
                const cls = submitted ? (j === q.answer ? " correct" : j === picked ? " picked-wrong" : "") : picked === j ? " picked" : "";
                return (
                  <label key={j} className={`opt${cls}`}>
                    <input type="radio" name={`q${i}`} checked={picked === j} disabled={submitted} onChange={() => setAnswers({ ...answers, [i]: j })} />
                    <Markdown source={o} className="prose opt-text" />
                  </label>
                );
              })}
            </div>
            {submitted && (
              <div className="explain">
                <b>{picked === q.answer ? "Correct." : "Not quite."}</b> <Markdown source={q.explain} className="prose" />
              </div>
            )}
          </fieldset>
        );
      })}
      <div className="quiz-foot">
        {!submitted ? (
          <button className="btn primary" disabled={!all} onClick={submit}>
            {all ? "Submit answers" : `Answer all ${questions.length} questions`}
          </button>
        ) : (
          <>
            <div className={`score ${score === questions.length ? "full" : ""}`}>
              {score}/{questions.length}
            </div>
            <button className="btn" onClick={retry}>
              Try again
            </button>
          </>
        )}
      </div>
    </div>
  );
}
