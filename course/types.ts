// Course content schema. Shared by the browser UI (renders it) and the Node
// server (runs lab setup scripts and checks). Keep this file free of Node or
// DOM imports so both sides can load it.

export interface Course {
  title: string;
  modules: Module[];
}

export interface Module {
  /** Stable slug, e.g. "iam". Used in URLs and progress records. */
  id: string;
  /** Display number, e.g. "03". */
  number: string;
  title: string;
  /** One sentence: what the learner can do after this module. */
  summary: string;
  /** AWS services this module touches, e.g. ["IAM", "STS"]. */
  services: string[];
  lessons: Lesson[];
  quiz?: QuizQuestion[];
}

export type Lesson = ReadingLesson | LabLesson;

interface LessonBase {
  /** Unique within the module, e.g. "policies". */
  id: string;
  title: string;
  /** Estimated minutes. */
  minutes: number;
  /**
   * Markdown. Raw HTML (including inline SVG diagrams) is allowed.
   * Fenced ```bash / ```sh blocks get "Run" and "Copy" buttons that send the
   * command to the built-in terminal. Use ```text or ```json for blocks that
   * should not be runnable.
   */
  body: string;
}

export interface ReadingLesson extends LessonBase {
  kind: "reading";
}

export interface LabLesson extends LessonBase {
  kind: "lab";
  lab: Lab;
}

export interface Lab {
  /**
   * Files written into workspace/<module>-<lesson>/ when the learner presses
   * "Prepare lab". The terminal cd's there. Paths are relative.
   */
  files?: Record<string, string>;
  /**
   * Bash run (in the lab directory, with the emulator env) when the learner
   * presses "Prepare lab": creates prerequisite resources the lab assumes.
   * Must be idempotent enough to run on an empty emulator.
   */
  setup?: string;
  tasks: LabTask[];
  /**
   * The reference solution as a bash script, run after `setup` in the lab
   * directory. `npm run verify` runs setup + solution on a fresh emulator and
   * asserts every task check passes, so keep it complete and deterministic.
   */
  solution: string;
}

export interface LabTask {
  id: string;
  title: string;
  /** Markdown: what to achieve. Describe the goal, not the exact command. */
  description: string;
  /** Progressive hints, shown one at a time. */
  hints?: string[];
  check: (ctx: CheckContext) => Promise<CheckResult>;
}

/** `true` = pass. A string = fail, with that string shown as feedback. */
export type CheckResult = true | string;

export interface CheckContext {
  /**
   * Run an AWS CLI command against the emulator and return the parsed JSON
   * output (or `null` when the command prints nothing). Pass arguments as an
   * array, without the leading "aws". `--output json` is added for you.
   * Throws AwsCliError on a non-zero exit.
   *   await aws(["s3api", "get-bucket-versioning", "--bucket", "x"])
   */
  aws: (args: string[]) => Promise<any>;
  /** Like `aws`, but never throws: returns { ok, data, error, code }. */
  tryAws: (args: string[]) => Promise<AwsAttempt>;
  /** Run a bash snippet with the emulator env in the lab dir. Never throws. */
  sh: (script: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Read a file from the lab directory (relative path); null if missing. */
  readFile: (path: string) => Promise<string | null>;
  /** The emulator's account id (always 000000000000). */
  account: string;
  region: string;
}

export interface AwsAttempt {
  ok: boolean;
  data: any;
  /** stderr text on failure. */
  error: string;
  /** AWS error code parsed from stderr, e.g. "NoSuchBucket", or "". */
  code: string;
}

export interface QuizQuestion {
  q: string;
  options: string[];
  /** Index into options. */
  answer: number;
  /** Why the answer is right (and the others wrong). Markdown. */
  explain: string;
}

/** Progress key for a lesson. */
export const lessonKey = (moduleId: string, lessonId: string) => `${moduleId}/${lessonId}`;

/** Workspace directory name for a lab. */
export const labDir = (moduleId: string, lessonId: string) => `${moduleId}-${lessonId}`;
