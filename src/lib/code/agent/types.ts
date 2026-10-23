import type { FileChange } from "../projects";
import type { TestResult } from "./test-results";

/**
 * The coding agent's shapes as the page sees them (no server imports).
 * A run is one request on one project; it works step by step and pauses
 * whenever it needs the user: to approve its plan, a command or edits, to
 * answer a question, or to start the project's computer.
 */

export const RUN_STATUSES = ["planning", "awaiting_approval", "running", "needs_input", "completed", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The agent takes its next step on its own in these; the others wait for the user or have ended. */
export const WORKING_STATUSES: RunStatus[] = ["planning", "running"];
export const ENDED_STATUSES: RunStatus[] = ["completed", "failed", "cancelled"];

export const STATUS_LABEL: Record<RunStatus, string> = {
  planning: "Planning",
  awaiting_approval: "Waiting for your approval",
  running: "Working",
  needs_input: "Waiting for you",
  completed: "Done",
  failed: "Stopped with an error",
  cancelled: "Stopped",
};

/** Which commands run without asking: the safe list (tests, builds, installs, reading), every command asks, or no commands. */
export type CommandMode = "safe" | "ask" | "off";

export interface RunOptions {
  /** A model id, or "auto:coding" (null means Auto). */
  modelId: string | null;
  /** Show the plan and wait for approval before changing anything. */
  approvePlans: boolean;
  /** Show each set of file edits and wait for approval before saving them. */
  reviewEdits: boolean;
  commands: CommandMode;
  /** Look and explain only: the server refuses every edit and command. */
  readOnly?: boolean;
  /** A website task: the agent gets the website guidance (set when the run starts). */
  web?: boolean;
  /** Files and images the user attached to the task (set when the run starts). */
  attachments?: { texts: number; images: number };
}

export const DEFAULT_OPTIONS: RunOptions = { modelId: null, approvePlans: true, reviewEdits: false, commands: "safe", readOnly: false };

export interface AgentPlan {
  summary: string;
  steps: string[];
  approved: boolean;
}

export type Pending =
  | { kind: "plan" }
  | { kind: "command"; command: string; reason: string; preview?: boolean }
  | { kind: "edits"; changes: FileChange[] }
  | { kind: "question"; question: string; options: string[] }
  | { kind: "computer"; command: string; preview?: boolean }
  /** A limit was reached (steps, tokens, working time, failed test runs, or repeated actions); the user decides whether to go on. */
  | { kind: "limit"; steps: number; reason?: LimitReason; detail?: string }
  /** A command is running right now (so Stop can end it). */
  | { kind: "job"; jobId: string; command: string };

export type LimitReason = "steps" | "tokens" | "time" | "tests" | "repeat";

/** Model usage for a run. Cost is null when a model used has no verified price. */
export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  modelCalls: number;
  models: string[];
  /** Some token counts were estimated (the provider didn't report them). */
  estimated?: boolean;
  /** Model calls that failed in a row (reset by a successful one). */
  modelFailuresInRow?: number;
  /** Model calls that failed over the whole run (each one retried or ended the run). */
  retries?: number;
}

/** Why a run failed, for the report and reliability figures. */
export const FAILURE_KINDS = ["no_model", "provider_rejected", "provider_not_configured", "provider_unavailable", "refused", "unreadable_replies", "internal"] as const;
export type FailureKind = (typeof FAILURE_KINDS)[number];

export const EMPTY_USAGE: RunUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0, modelCalls: 0, models: [] };

export interface RunTests {
  last: TestResult | null;
  /** Test runs that failed in a row (reset when one passes). */
  failuresInRow: number;
  /** Failed test runs in a row before the run pauses to ask. */
  attemptLimit: number;
  runs: number;
}

export const DEFAULT_TEST_ATTEMPTS = 3;

/** The preview server the agent last started, as it was found. */
export interface ServerCheck {
  command: string;
  state: "running" | "exited" | "timeout";
  http: number;
  at: string;
}

/** The latest browser check of the running site. */
export interface PreviewCheckRecord {
  path: string;
  verdict: "passed" | "problems" | "failed";
  problems: string[];
  warnings: string[];
  checkedAt: string;
}

/** The latest production build (a build script, type check or linter run as a command). */
export interface BuildCheck {
  command: string;
  exitCode: number | null;
  passed: boolean;
  ranAt: string;
}

/** A check Orbis runs itself once the agent says it has finished. */
export type VerifyStep = { check: "tests"; command: string } | { check: "browser"; path: string };

/** A check that applied but couldn't run, and why (shown in the report as "not run"). */
export interface SkippedCheck {
  check: "tests" | "browser";
  reason: string;
}

/**
 * The verification phase: the agent called finish, and Orbis is now running
 * the checks that apply (one per step) before the run may end. Kept with the
 * checks (not in `pending`, which a running command uses), so it survives
 * an interrupted step.
 */
export interface VerifyState {
  /** The agent's own summary and open points, held until the checks are done. */
  summary: string;
  unresolved: string[];
  queue: VerifyStep[];
  /** Tries at the check at the head of the queue (an interrupted step counts). */
  attempts: number;
  skipped: SkippedCheck[];
  startedAt: string;
  /** Started by the user's "Re-run checks" rather than by the agent finishing. */
  rerun?: boolean;
}

/** Website checks, each recorded from what actually ran. */
export interface RunChecks {
  server: ServerCheck | null;
  preview: PreviewCheckRecord | null;
  build: BuildCheck | null;
  /** Set while Orbis is verifying the agent's work (see VerifyState). */
  verify?: VerifyState | null;
}

export const EMPTY_CHECKS: RunChecks = { server: null, preview: null, build: null };

/** Whether a check ran after the run's last change to the files. */
export type Freshness = "current" | "stale";

/** How the work was verified, from the test runs that actually happened. */
export type Verification = "passed" | "failed" | "not_run" | "stale";

/** Built by the server from the run's records when it ends; never from the model's claims. */
export interface RunReport {
  outcome: RunStatus;
  /** The agent's own summary (its words). */
  summary: string | null;
  /** Problems the agent said it couldn't solve or verify. */
  unresolved: string[];
  files: { path: string; change: "created" | "modified" | "deleted"; added: number; removed: number }[];
  commands: { command: string; exitCode: number | null; result: string }[];
  tests: (Omit<TestResult, "outputTail"> & { afterLastEdit: boolean }) | null;
  verification: Verification;
  /** Website checks: the server, the browser check and the build, each marked current or stale. */
  checks?: { server: (ServerCheck & { freshness: Freshness }) | null; preview: (PreviewCheckRecord & { freshness: Freshness }) | null; build: (BuildCheck & { freshness: Freshness }) | null };
  usage: RunUsage & { steps: number; activeMs: number };
  checkpoints: number;
  createdAt: string;
  /** Every check that applies or ran, with its status and evidence (reports from before this field: see checklistOf). */
  checklist?: CheckItem[];
  /** The task's state when the report was written, from the checklist (see taskState). */
  state?: TaskState;
  /** The project's test command when the run ended, or null when it has no test setup. */
  testSetup?: string | null;
  /** A website task. */
  web?: boolean;
  /** Real timings from the run's records (ms): created → ended, created → first progress, and the verification phase. */
  timing?: { totalMs: number; firstProgressMs: number | null; verifyMs: number | null };
  /** Why the run failed (failed runs only). */
  failure?: FailureKind;
}

/** How a check ended. "not_run" is never shown as success; "stale" ran before the last change; "error" couldn't complete. */
export type CheckStatus = "passed" | "failed" | "stale" | "error" | "not_run";

/**
 * One line of the verification checklist. `kind` keeps a browser inspection
 * (did the page load and look right) apart from automated tests (does the
 * code do what its tests say) and from process checks (did the server start).
 */
export interface CheckItem {
  id: "tests" | "build" | "server" | "browser";
  label: string;
  kind: "automated" | "inspection" | "process";
  status: CheckStatus;
  /** It should have run for this task (a missing applicable check means the work isn't fully verified). */
  applicable: boolean;
  /** When it ran (ISO), or null. */
  at: string | null;
  command: string | null;
  /** One line: the result, or why it didn't run. */
  summary: string;
  /** Failing tests, problems found, warnings. */
  details: string[];
  /** The end of the output, for failures. */
  output: string | null;
}

/**
 * What people see a task as, worked out from its status and its evidence —
 * never from the agent's own words. See taskState for the exact rules.
 */
export const TASK_STATES = ["queued", "running", "waiting", "verifying", "verified", "warnings", "unverified", "failed", "cancelled"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface RunView {
  id: string;
  projectId: string;
  request: string;
  status: RunStatus;
  options: RunOptions;
  plan: AgentPlan | null;
  pending: Pending | null;
  summary: string | null;
  error: string | null;
  steps: number;
  stepLimit: number;
  /** A step is in progress on the server. */
  busy: boolean;
  usage: RunUsage;
  tokenBudget: number;
  activeMs: number;
  timeLimitMs: number;
  tests: RunTests | null;
  checks: RunChecks;
  report: RunReport | null;
  createdAt: string;
  updatedAt: string;
  /** Changes whenever the run is saved or a step takes or releases it; the page sends it back so an unchanged run isn't sent again. */
  version: string;
  /** When the step in progress started (from its lock), or null when none is. */
  stepStartedAt: string | null;
}

export const EVENT_KINDS = ["status", "note", "inspect", "plan", "edit", "command", "question", "answer", "approval", "error", "summary", "revert", "git"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface AgentEvent {
  id: string;
  seq: number;
  kind: EventKind;
  title: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface AgentChange {
  id: string;
  path: string;
  /** null: the run created the file. */
  before: string | null;
  /** null: the run deleted the file. */
  after: string | null;
  revertedAt: string | null;
  updatedAt: string;
}

/** The user's answer to what a run is waiting for. Its meaning depends on the pending kind. */
export const DECISIONS = ["approve", "reject", "answer", "continue", "stop"] as const;
export type Decision = (typeof DECISIONS)[number];

export const MAX_STEP_LIMIT = 100;
export const DEFAULT_TOKEN_BUDGET = 600_000;
export const MAX_TOKEN_BUDGET = 10_000_000;
export const DEFAULT_TIME_LIMIT_MS = 30 * 60_000;
export const MAX_TIME_LIMIT_MS = 4 * 60 * 60_000;
export const DEFAULT_STEP_LIMIT = 20;
/** Steps added when the user lets a run that reached its limit keep going. */
export const STEP_LIMIT_INCREMENT = 10;
