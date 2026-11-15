// Verifies course content against a real emulator.
//
//   npm run verify                 # every lab
//   npm run verify -- iam          # one module
//   npm run verify -- iam/roles    # one lab
//   npm run verify -- -j 6 vpc s3  # parallelism + several filters
//   npm run verify -- --file course/modules/03-compute.ts   # an unregistered module file
//
// For each lab: start a fresh emulator on its own port, write the lab files,
// run `setup`, confirm the checks do NOT all pass yet, run `solution`, then
// confirm every check passes. Also validates the course structure.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { course as registered, normalize } from "../course/index.ts";
import type { Course, LabLesson, Module } from "../course/types.ts";
import { awsEnv } from "../server/config.ts";
import { Emulator } from "../server/emulator.ts";
import { runBash, runChecks, writeLabFiles } from "../server/labs.ts";

const args = process.argv.slice(2);
let jobs = 4;
const filters: string[] = [];
let verbose = false;
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-j") jobs = Number(args[++i]);
  else if (args[i] === "--file") files.push(args[++i]);
  else if (args[i] === "-v") verbose = true;
  else filters.push(args[i]);
}

let course: Course = registered;
if (files.length) {
  const mods: Module[] = [];
  for (const f of files) {
    const mod = await import(pathToFileURL(resolve(f)).href);
    const found = Object.values(mod).filter((v: any) => v && typeof v === "object" && Array.isArray(v.lessons)) as Module[];
    if (!found.length) throw new Error(`${f} exports no Module`);
    mods.push(...found.map(normalize));
  }
  course = { ...registered, modules: mods };
}

// ------------------------------------------------------------ structure
const problems: string[] = [];
const moduleIds = new Set<string>();
for (const m of course.modules) {
  if (moduleIds.has(m.id)) problems.push(`duplicate module id ${m.id}`);
  moduleIds.add(m.id);
  const ids = new Set<string>();
  for (const l of m.lessons) {
    if (ids.has(l.id)) problems.push(`${m.id}: duplicate lesson id ${l.id}`);
    ids.add(l.id);
    if (!/^[a-z0-9-]+$/.test(l.id)) problems.push(`${m.id}/${l.id}: lesson id must be [a-z0-9-]`);
    if (!l.body.trim()) problems.push(`${m.id}/${l.id}: empty body`);
    if (l.kind === "lab") {
      const t = new Set<string>();
      for (const task of l.lab.tasks) {
        if (t.has(task.id)) problems.push(`${m.id}/${l.id}: duplicate task id ${task.id}`);
        t.add(task.id);
      }
      if (!l.lab.tasks.length) problems.push(`${m.id}/${l.id}: lab has no tasks`);
    }
  }
  for (const [i, q] of (m.quiz ?? []).entries()) {
    if (q.answer < 0 || q.answer >= q.options.length) problems.push(`${m.id}: quiz #${i + 1} answer index out of range`);
  }
}
if (problems.length) {
  console.error("Structure problems:\n  " + problems.join("\n  "));
  process.exit(1);
}

// ------------------------------------------------------------ labs
const labs: { m: Module; l: LabLesson }[] = [];
for (const m of course.modules)
  for (const l of m.lessons)
    if (l.kind === "lab" && (!filters.length || filters.some((f) => f === m.id || f === `${m.id}/${l.id}`))) labs.push({ m, l });

console.log(`Verifying ${labs.length} lab(s) with ${jobs} parallel emulator(s)…\n`);

let nextPort = 21000 + Math.floor(Math.random() * 20000);
const failures: string[] = [];

// Labs that run Terraform share the provider plugin cache, and two concurrent
// `terraform init`s race on it ("text file busy"), so they take turns.
let tfLock: Promise<void> = Promise.resolve();
const usesTerraform = (l: LabLesson) => /\bterraform\s/.test(`${l.lab.setup ?? ""}\n${l.lab.solution}`);

async function verify(item: { m: Module; l: LabLesson }) {
  if (!usesTerraform(item.l)) return verifyOne(item);
  const prev = tfLock;
  let release!: () => void;
  tfLock = new Promise((r) => (release = r));
  await prev;
  try {
    await verifyOne(item);
  } finally {
    release();
  }
}

async function verifyOne({ m, l }: { m: Module; l: LabLesson }) {
  const name = `${m.id}/${l.id}`;
  const port = nextPort++;
  const home = mkdtempSync(join(tmpdir(), "awsl-home-"));
  const dir = mkdtempSync(join(tmpdir(), "awsl-lab-"));
  const emu = new Emulator({ port, home });
  const lines: string[] = [];
  const started = Date.now();
  try {
    await emu.start();
    if (emu.getStatus().state !== "running") throw new Error(`emulator failed: ${emu.getStatus().message}`);
    const re = { env: awsEnv(`https://127.0.0.1:${port}`, port, home), cwd: dir };
    writeLabFiles(l.lab, dir, true);
    if (l.lab.setup) {
      const s = await runBash(`set -eo pipefail\n${l.lab.setup}`, re);
      if (s.code !== 0) throw new Error(`setup exited ${s.code}\n${tail(s.stdout + s.stderr)}`);
    }
    const before = await runChecks(l.lab, re);
    if (before.every((r) => r.ok)) lines.push(`  ⚠ every check already passes before the solution runs (vacuous checks?)`);
    const sol = await runBash(`set -eo pipefail\n${l.lab.solution}`, re);
    if (sol.code !== 0) throw new Error(`solution exited ${sol.code}\n${tail(sol.stdout + sol.stderr)}`);
    if (verbose) lines.push(indent(tail(sol.stdout + sol.stderr, 40)));
    const after = await runChecks(l.lab, re);
    for (const r of after) lines.push(`  ${r.ok ? "✓" : "✗"} ${r.id}${r.ok ? "" : ` — ${r.message}`}`);
    const ok = after.every((r) => r.ok);
    if (!ok) failures.push(name);
    console.log(`${ok ? "PASS" : "FAIL"} ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)\n${lines.join("\n")}`);
  } catch (e: any) {
    failures.push(name);
    console.log(`FAIL ${name}\n${lines.join("\n")}\n${indent(String(e.message ?? e))}`);
  } finally {
    await emu.stop();
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

const tail = (s: string, n = 25) => s.trim().split("\n").slice(-n).join("\n");
const indent = (s: string) =>
  s
    .split("\n")
    .map((x) => "    " + x)
    .join("\n");

let i = 0;
await Promise.all(
  Array.from({ length: Math.min(jobs, labs.length) }, async () => {
    while (i < labs.length) await verify(labs[i++]);
  }),
);

console.log(`\n${labs.length - failures.length}/${labs.length} labs passed.`);
if (failures.length) {
  console.log("Failed: " + failures.join(", "));
  process.exit(1);
}
