import type { Course, Module } from "./types.ts";
import { foundations } from "./modules/00-foundations.ts";
import { iam } from "./modules/01-iam.ts";
import { security } from "./modules/09-security.ts";
import { vpc } from "./modules/02-vpc.ts";
import { compute } from "./modules/03-compute.ts";
import { storage } from "./modules/04-storage.ts";
import { databases } from "./modules/05-databases.ts";
import { messaging } from "./modules/06-messaging.ts";
import { serverless } from "./modules/07-serverless.ts";
import { containers } from "./modules/08-containers.ts";
import { observability } from "./modules/10-observability.ts";
import { cloudformation } from "./modules/11-cloudformation.ts";
import { terraform } from "./modules/12-terraform.ts";
import { cicd } from "./modules/13-cicd.ts";
import { capstone } from "./modules/14-capstone.ts";

// Content is authored in String.raw template literals so bash line
// continuations survive. Inside them, a backtick must be written \` and a
// literal ${ must be written \${ — String.raw keeps those backslashes, so we
// strip them here once.
const unescape = (s: string) => s.replace(/\\`/g, "`").replace(/\\\$\{/g, "${");

export function normalize(m: Module): Module {
  return {
    ...m,
    lessons: m.lessons.map((l) => {
      const base = { ...l, body: unescape(l.body).trim() };
      if (l.kind !== "lab") return base;
      return {
        ...base,
        kind: "lab" as const,
        lab: {
          ...l.lab,
          setup: l.lab.setup && unescape(l.lab.setup),
          solution: unescape(l.lab.solution),
          files: l.lab.files && Object.fromEntries(Object.entries(l.lab.files).map(([k, v]) => [k, unescape(v).replace(/^\n/, "")])),
          tasks: l.lab.tasks.map((t) => ({
            ...t,
            description: unescape(t.description),
            hints: t.hints?.map(unescape),
          })),
        },
      };
    }),
    quiz: m.quiz?.map((q) => ({ ...q, q: unescape(q.q), explain: unescape(q.explain), options: q.options.map(unescape) })),
  };
}

export const course: Course = {
  title: "AWS for DevOps, locally",
  modules: [foundations, iam, security, vpc, compute, storage, databases, messaging, serverless, containers, observability, cloudformation, terraform, cicd, capstone].sort((a, b) => a.number.localeCompare(b.number)).map(normalize),
};
