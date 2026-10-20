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
}

export const DEFAULT_OPTIONS: RunOptions = { modelId: null, approvePlans: true, reviewEdits: false, commands: "safe" };

export interface AgentPlan {
  summary: string;
  steps: string[];
  approved: boolean;
}

export type Pending =
  | { kind: "plan" }
  | { kind: "command"; command: string; reason: string }
  | { kind: "edits"; changes: FileChange[] }
  | { kind: "question"; question: string; options: string[] }
  | { kind: "computer"; command: string }
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
}

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
  usage: RunUsage & { steps: number; activeMs: number };
  checkpoints: number;
  createdAt: string;
}

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
  report: RunReport | null;
  createdAt: string;
  updatedAt: string;
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
