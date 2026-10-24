import { classifyFailure, shouldRetry, type FailureInfo } from "./failures";
import { z } from "zod";
import type { BugInput, QaInput } from "../code/agent/profiles";
import { bugInput } from "../code/agent/profiles";
import type { AgentId } from "./registry";

/**
 * Multi-agent workflows: task agents working on one project as a small
 * dependency graph, ending with the user's decision. The graph is set by the
 * template, never by an agent: agents can't start other agents, a step starts
 * only when every step it depends on has completed, and steps that would edit
 * the same project never run at the same time (steps that only read run
 * alongside them). Nothing is pushed, merged or deployed by a workflow. Each
 * step starts an ordinary task (a coding-agent run or a code review) with that
 * agent's own limits, approvals and records.
 *
 * Step states follow the platform's task protocol: pending (waiting for a
 * dependency), ready, running, waiting (for the user), done, failed, skipped,
 * cancelled.
 *
 * Pure: the server (workflow-server.ts) reads the child tasks and stores what
 * these functions decide, so every transition is testable.
 */

export const WORKFLOW_TEMPLATES = ["fix_and_verify"] as const;
export type WorkflowTemplate = (typeof WORKFLOW_TEMPLATES)[number];

export type StepKind = "code_run" | "review" | "approval";
export type StepKey = "fix" | "test" | "review" | "approve";
export type StepStatus = "pending" | "ready" | "running" | "waiting" | "done" | "failed" | "skipped" | "cancelled";
export type WorkflowStatus = "running" | "waiting" | "needs_approval" | "completed" | "failed" | "cancelled";

/** What a step changes: "project" for a step that edits the project's files; null for one that only reads. */
export type StepResource = "project" | null;

export interface StepDef {
  key: StepKey;
  agent: AgentId | null;
  kind: StepKind;
  label: string;
  /** Can be skipped after it fails (the workflow then goes on without it). */
  optional: boolean;
  /** Steps that must have completed (or been skipped) before this one starts. */
  dependsOn: StepKey[];
  /** What it edits; two steps that edit the same resource never run at once. */
  writes: StepResource;
  /** Skipped when the steps it depends on changed no files (nothing to test or review). */
  needsChanges: boolean;
}

export const TEMPLATE_INFO: Record<WorkflowTemplate, { name: string; description: string; steps: StepDef[] }> = {
  fix_and_verify: {
    name: "Fix and verify",
    description:
      "Bug Fixing reproduces and fixes the bug. Then, at the same time, QA Testing adds regression tests and runs them while Code Review checks the fix for bugs and security problems. Then you decide.",
    steps: [
      { key: "fix", agent: "bug_fixer", kind: "code_run", label: "Reproduce and fix the bug", optional: false, dependsOn: [], writes: "project", needsChanges: false },
      { key: "test", agent: "qa_tester", kind: "code_run", label: "Add regression tests and run them", optional: true, dependsOn: ["fix"], writes: "project", needsChanges: true },
      { key: "review", agent: "code_review", kind: "review", label: "Security and code review of the fix", optional: true, dependsOn: ["fix"], writes: null, needsChanges: true },
      { key: "approve", agent: null, kind: "approval", label: "Your decision", optional: false, dependsOn: ["test", "review"], writes: null, needsChanges: false },
    ],
  },
};

export interface WorkflowStep {
  key: StepKey;
  agent: AgentId | null;
  kind: StepKind;
  label: string;
  optional: boolean;
  dependsOn: StepKey[];
  writes: StepResource;
  needsChanges: boolean;
  status: StepStatus;
  taskId: string | null;
  /** Tasks from earlier attempts: their changes stay in the project, so rejecting undoes them too. */
  earlierTaskIds?: string[];
  attempts: number;
  startedAt: string | null;
  endedAt: string | null;
  /** When the server last moved this step's task on (it takes turns between running steps). */
  drivenAt: string | null;
  /** Files the step's task changed (for the steps that depend on it). */
  changedFiles: string[];
  /** One line about how it ended, from the task's records. */
  summary: string | null;
  error: string | null;
  /** Each attempt's error, oldest first (the last 5): an identical failure isn't retried again unchanged. */
  errors?: string[];
}

export interface WorkflowState {
  status: WorkflowStatus;
  /** The first step still in progress (for display; steps can run side by side). */
  current: number;
  steps: WorkflowStep[];
  log: { at: string; text: string }[];
  error: string | null;
}

/** Attempts per step (the first run and two retries). */
export const MAX_ATTEMPTS = 3;
/** A workflow not finished within this long is stopped when it's next advanced. */
export const WORKFLOW_TTL_MS = 24 * 60 * 60_000;
/** Most steps started in one advance. */
export const MAX_STARTS_PER_ADVANCE = 2;
const LOG_MAX = 200;

export const workflowInput = z.object({
  template: z.enum(WORKFLOW_TEMPLATES),
  projectId: z.string().uuid(),
  bug: bugInput,
  options: z.object({ modelId: z.string().max(120).nullable().optional(), approvePlans: z.boolean().optional(), commands: z.enum(["safe", "ask"]).optional() }).optional(),
});
export type WorkflowInput = z.infer<typeof workflowInput>;

/**
 * A template's graph is valid: unique keys, dependencies that exist and come earlier (so there's no cycle),
 * exactly one approval step, depending (directly or not) on every other step. Checked by the tests.
 */
export function templateProblems(steps: StepDef[]): string[] {
  const out: string[] = [];
  const keys = steps.map((s) => s.key);
  if (new Set(keys).size !== keys.length) out.push("duplicate step keys");
  steps.forEach((s, i) => {
    for (const d of s.dependsOn) if (!keys.slice(0, i).includes(d)) out.push(`${s.key} depends on ${d}, which isn't an earlier step`);
    if (s.kind === "approval" && s.writes) out.push(`${s.key}: an approval can't edit anything`);
    if (s.kind !== "approval" && !s.agent) out.push(`${s.key}: a task step needs an agent`);
  });
  const approvals = steps.filter((s) => s.kind === "approval");
  if (approvals.length !== 1) out.push("a workflow needs exactly one approval step");
  else {
    const reach = new Set<StepKey>();
    const visit = (k: StepKey) => steps.find((s) => s.key === k)?.dependsOn.forEach((d) => (reach.has(d) ? null : (reach.add(d), visit(d))));
    visit(approvals[0]!.key);
    for (const s of steps) if (s.kind !== "approval" && !reach.has(s.key)) out.push(`${s.key} isn't before the approval`);
  }
  return out;
}

export function newSteps(template: WorkflowTemplate): WorkflowStep[] {
  return settle(
    TEMPLATE_INFO[template].steps.map((d) => ({
      ...d,
      status: "pending",
      taskId: null,
      earlierTaskIds: [],
      attempts: 0,
      startedAt: null,
      endedAt: null,
      drivenAt: null,
      changedFiles: [],
      summary: null,
      error: null,
    })),
  );
}

export function addLog(log: WorkflowState["log"], text: string, at: string): WorkflowState["log"] {
  return [...log, { at, text: text.slice(0, 500) }].slice(-LOG_MAX);
}

/** How a step's task stands, as the server read it from that task's records. */
export type ChildState =
  | { state: "working" }
  | { state: "waiting"; reason: string }
  | { state: "done"; summary: string; changedFiles: string[] }
  | { state: "failed"; error: string }
  | { state: "cancelled" };

const TERMINAL: WorkflowStatus[] = ["completed", "failed", "cancelled"];
export const isTerminal = (s: WorkflowStatus) => TERMINAL.includes(s);
const ENDED: StepStatus[] = ["done", "skipped", "failed", "cancelled"];
const CLEARED: StepStatus[] = ["done", "skipped"];
const ACTIVE: StepStatus[] = ["running", "waiting"];

/**
 * Pending steps whose dependencies have all cleared become ready (or are skipped when there's nothing for
 * them to work on); the approval step becomes "waiting" for the user. Repeats until nothing changes.
 */
function settle(steps: WorkflowStep[]): WorkflowStep[] {
  let out = steps;
  for (let changed = true; changed; ) {
    changed = false;
    out = out.map((s) => {
      if (s.status !== "pending") return s;
      const deps = s.dependsOn.map((k) => out.find((d) => d.key === k)!);
      if (!deps.every((d) => CLEARED.includes(d.status))) return s;
      changed = true;
      if (s.kind === "approval") return { ...s, status: "waiting" };
      if (s.needsChanges && deps.every((d) => d.changedFiles.length === 0)) return { ...s, status: "skipped", summary: "Skipped: the steps before it changed no files." };
      return { ...s, status: "ready" };
    });
  }
  return out;
}

/** The workflow's status, from its steps: one view of many steps that may run side by side. */
function derive(w: WorkflowState): WorkflowState {
  if (w.status === "cancelled" || w.status === "completed") return w;
  const steps = w.steps;
  const firstOpen = steps.findIndex((s) => !ENDED.includes(s.status));
  const current = firstOpen === -1 ? steps.length - 1 : firstOpen;
  const failed = steps.find((s) => s.status === "failed");
  const active = steps.some((s) => s.kind !== "approval" && ACTIVE.includes(s.status));
  const waitingUser = steps.some((s) => s.kind !== "approval" && s.status === "waiting");
  const approval = steps.find((s) => s.kind === "approval");
  let status: WorkflowStatus;
  // A failed step stops new steps from starting; steps already running finish first.
  if (failed && !active) status = "failed";
  else if (waitingUser) status = "waiting";
  else if (approval?.status === "waiting") status = "needs_approval";
  else status = "running";
  const error = failed ? `${failed.label}: ${failed.error ?? "it failed"}` : null;
  return { ...w, steps, current, status, error };
}

const patch = (w: WorkflowState, key: StepKey, p: Partial<WorkflowStep>): WorkflowState => ({ ...w, steps: w.steps.map((s) => (s.key === key ? { ...s, ...p } : s)) });

/**
 * Steps that can start now: ready, not the approval, and not editing a resource another step is editing
 * (or that another step chosen in the same pass will edit). None start once a step has failed.
 */
export function runnable(w: WorkflowState, limit = MAX_STARTS_PER_ADVANCE): WorkflowStep[] {
  if (isTerminal(w.status) || w.steps.some((s) => s.status === "failed")) return [];
  const busy = new Set(w.steps.filter((s) => ACTIVE.includes(s.status) && s.writes).map((s) => s.writes!));
  const out: WorkflowStep[] = [];
  for (const s of w.steps) {
    if (out.length >= limit) break;
    if (s.status !== "ready" || s.kind === "approval") continue;
    if (s.writes && busy.has(s.writes)) continue;
    if (s.writes) busy.add(s.writes);
    out.push(s);
  }
  return out;
}

/** The running or waiting step whose task was moved on longest ago (steps take turns). */
export function nextToDrive(w: WorkflowState): WorkflowStep | null {
  const active = w.steps.filter((s) => s.kind !== "approval" && ACTIVE.includes(s.status) && s.taskId);
  return active.sort((a, b) => (a.drivenAt ?? "").localeCompare(b.drivenAt ?? ""))[0] ?? null;
}

/** Apply what was observed about one step's task. */
export function observe(w: WorkflowState, key: StepKey, child: ChildState, at: string): WorkflowState {
  const step = w.steps.find((s) => s.key === key);
  if (!step || isTerminal(w.status) || !ACTIVE.includes(step.status)) return w;
  let next: WorkflowState;
  switch (child.state) {
    case "working":
      if (step.status === "running") return patch(w, key, { drivenAt: at });
      next = patch(w, key, { status: "running", drivenAt: at });
      break;
    case "waiting":
      if (step.status === "waiting") return patch(w, key, { drivenAt: at });
      next = { ...patch(w, key, { status: "waiting", drivenAt: at }), log: addLog(w.log, `${step.label}: waiting for you (${child.reason}).`, at) };
      break;
    case "failed":
    case "cancelled": {
      const error = child.state === "failed" ? child.error : "The task was stopped.";
      next = {
        ...patch(w, key, { status: "failed", endedAt: at, error, errors: [...(step.errors ?? []), error].slice(-5), drivenAt: at }),
        log: addLog(w.log, `${step.label}: ${child.state === "failed" ? "failed" : "stopped"}. ${error}`, at),
      };
      break;
    }
    case "done": {
      next = {
        ...patch(w, key, { status: "done", endedAt: at, summary: child.summary, error: null, changedFiles: child.changedFiles.slice(0, 200), drivenAt: at }),
        log: addLog(w.log, `${step.label}: ${child.summary}`, at),
      };
      const before = next.steps;
      const steps = settle(before);
      const skipped = steps.filter((s, i) => s.status === "skipped" && before[i]!.status !== "skipped");
      let log = next.log;
      for (const s of skipped) log = addLog(log, `${s.label}: skipped, nothing changed to work on.`, at);
      if (steps.some((s, i) => s.kind === "approval" && s.status === "waiting" && before[i]!.status !== "waiting")) log = addLog(log, "Ready for your decision.", at);
      next = { ...next, steps, log };
      break;
    }
  }
  return derive(next);
}

/** A step was started: its task exists. */
export function started(w: WorkflowState, key: StepKey, taskId: string, at: string): WorkflowState {
  const step = w.steps.find((s) => s.key === key)!;
  const earlierTaskIds = step.taskId ? [...(step.earlierTaskIds ?? []), step.taskId] : (step.earlierTaskIds ?? []);
  const next = patch(w, key, { status: "running", taskId, earlierTaskIds, attempts: step.attempts + 1, startedAt: at, endedAt: null, drivenAt: at, error: null, summary: null });
  return derive({ ...next, log: addLog(w.log, `${step.label}: started.`, at) });
}

/** Starting a step failed before any task existed (quota, a project busy with another task, …). */
export function startFailed(w: WorkflowState, key: StepKey, error: string, at: string): WorkflowState {
  const step = w.steps.find((s) => s.key === key)!;
  const next = patch(w, key, { status: "failed", attempts: step.attempts + 1, error, errors: [...(step.errors ?? []), error].slice(-5), endedAt: at });
  return derive({ ...next, log: addLog(w.log, `${step.label}: couldn't start. ${error}`, at) });
}

export type Recovery = "retry" | "skip";

/** What the user may do about a failed step (once no other step is still running). */
export function recoveries(w: WorkflowState, key?: StepKey): Recovery[] {
  if (w.status !== "failed") return [];
  const step = key ? w.steps.find((s) => s.key === key) : w.steps.find((s) => s.status === "failed");
  if (!step || step.status !== "failed") return [];
  const out: Recovery[] = [];
  if (retryAdvice(step).retry) out.push("retry");
  if (step.optional) out.push("skip");
  return out;
}

/**
 * Whether trying a failed step again makes sense, and why (shown to the user): only within the attempt limit,
 * for a failure that another try can fix, and not after the same failure twice in a row.
 */
export function retryAdvice(step: Pick<WorkflowStep, "attempts" | "error" | "errors">): { retry: boolean; reason: string; failure: FailureInfo } {
  const errors = step.errors?.length ? step.errors : step.error ? [step.error] : [];
  const r = shouldRetry(errors, step.attempts, MAX_ATTEMPTS);
  return { ...r, failure: classifyFailure(errors[errors.length - 1] ?? null) };
}

/** The failed step the user is asked about (the first one). */
export const failedStep = (w: WorkflowState) => w.steps.find((s) => s.status === "failed") ?? null;

export function recover(w: WorkflowState, action: Recovery, at: string, key?: StepKey): WorkflowState | null {
  const step = key ? w.steps.find((s) => s.key === key) : failedStep(w);
  if (!step || !recoveries(w, step.key).includes(action)) return null;
  if (action === "retry") {
    const next = patch(w, step.key, { status: "ready", error: null });
    return derive({ ...next, status: "running", log: addLog(w.log, `${step.label}: trying again (attempt ${step.attempts + 1} of ${MAX_ATTEMPTS}).`, at) });
  }
  const next = patch(w, step.key, { status: "skipped", summary: "Skipped by you after it failed." });
  return derive({ ...next, status: "running", steps: settle(next.steps), log: addLog(w.log, `${step.label}: skipped by you.`, at) });
}

export type Decision = "approve" | "reject";

export function decide(w: WorkflowState, action: Decision, at: string): WorkflowState | null {
  if (w.status !== "needs_approval") return null;
  const approval = w.steps.find((s) => s.kind === "approval")!;
  const next = patch(w, approval.key, { status: "done", endedAt: at, summary: action === "approve" ? "Approved" : "Rejected; the changes were undone" });
  return { ...next, status: "completed", current: w.steps.length - 1, log: addLog(w.log, action === "approve" ? "You approved the changes." : "You rejected the changes; they were undone.", at) };
}

/** Every step that hasn't ended is cancelled; the server stops the tasks of those that were running. */
export function cancel(w: WorkflowState, at: string): WorkflowState | null {
  if (isTerminal(w.status)) return null;
  const steps = w.steps.map((s) =>
    ENDED.includes(s.status) ? s : { ...s, status: "cancelled" as const, endedAt: ACTIVE.includes(s.status) ? at : s.endedAt, error: ACTIVE.includes(s.status) ? "Stopped by you." : null },
  );
  return { ...w, steps, status: "cancelled", log: addLog(w.log, "You stopped the workflow.", at) };
}

/** Stopped for running too long: like cancelling, with the reason. */
export function timeOut(w: WorkflowState, at: string): WorkflowState | null {
  const c = cancel(w, at);
  if (!c) return null;
  return { ...c, status: "failed", error: "The workflow ran for more than 24 hours and was stopped.", log: addLog(w.log, "Stopped: it ran for more than 24 hours.", at) };
}

export function expired(createdAt: string, now: number): boolean {
  return now - Date.parse(createdAt) > WORKFLOW_TTL_MS;
}

/** QA's task in the workflow: regression tests for what the fix changed. */
export function regressionTests(bug: BugInput, changed: string[]): QaInput {
  const files = changed.slice(0, 20).join(", ");
  return {
    scope: `Regression tests for the fix of: ${bug.summary}. The fix changed: ${files}. The tests must fail on the old behaviour and pass now; also run the whole test suite.`.slice(0, 2000),
    kinds: ["unit"],
    notes: bug.expected ? `Expected behaviour: ${bug.expected}`.slice(0, 2000) : "",
  };
}

/** The tasks whose changes a step reviews: the coding tasks it depends on that completed. */
export function reviewTaskIds(w: Pick<WorkflowState, "steps">, key: StepKey = "review"): string[] {
  const step = w.steps.find((s) => s.key === key);
  const deps = step ? step.dependsOn : [];
  return w.steps.filter((s) => deps.includes(s.key) && s.kind === "code_run" && s.status === "done" && s.taskId).flatMap((s) => [...(s.earlierTaskIds ?? []), s.taskId!]);
}

/** Every coding task the workflow started, newest first (later steps, then each step's latest attempt first): what rejecting undoes. */
export function tasksToUndo(steps: WorkflowStep[]): { label: string; taskId: string }[] {
  return steps
    .filter((s) => s.kind === "code_run")
    .reverse()
    .flatMap((s) => [s.taskId, ...[...(s.earlierTaskIds ?? [])].reverse()].filter((id): id is string => !!id).map((taskId) => ({ label: s.label, taskId })));
}

/** Files changed by the steps a step depends on. */
export function changedBefore(w: Pick<WorkflowState, "steps">, key: StepKey): string[] {
  const deps = w.steps.find((s) => s.key === key)?.dependsOn ?? [];
  return [...new Set(w.steps.filter((s) => deps.includes(s.key)).flatMap((s) => s.changedFiles))];
}

const WAITING_REASON: Record<string, string> = {
  plan: "approve the plan",
  command: "approve a command",
  edits: "review the edits",
  question: "answer a question",
  computer: "start the project's computer",
  limit: "a limit was reached; decide whether to go on",
};

/** A coding-agent task's state, from its record (status, what it waits for, and its report). */
export function childFromRun(run: {
  status: string;
  pending: { kind: string } | null;
  error: string | null;
  report: { state?: string; verification?: string; files: { path: string }[] } | null;
}): ChildState {
  if (run.status === "planning" || run.status === "running") return { state: "working" };
  if (run.status === "awaiting_approval" || run.status === "needs_input") return { state: "waiting", reason: WAITING_REASON[run.pending?.kind ?? ""] ?? "it needs your input" };
  if (run.status === "cancelled") return { state: "cancelled" };
  if (run.status === "failed") return { state: "failed", error: run.error ?? "The task failed." };
  const files = run.report?.files.map((f) => f.path) ?? [];
  const tests =
    run.report?.verification === "passed"
      ? "tests passed after the last change"
      : run.report?.verification === "failed"
        ? "tests failed"
        : run.report?.verification === "stale"
          ? "files changed after the last test run"
          : "no tests ran";
  return { state: "done", summary: `${files.length} file${files.length === 1 ? "" : "s"} changed; ${tests}.`, changedFiles: files };
}

/** A code review's state, from its record. */
export function childFromReview(r: { status: string; error: string | null; findings: { severity: string; status: string }[] }): ChildState {
  if (r.status === "running") return { state: "working" };
  if (r.status === "cancelled") return { state: "cancelled" };
  if (r.status === "failed") return { state: "failed", error: r.error ?? "The review failed." };
  const open = r.findings.filter((f) => f.status === "open");
  const by = (s: string) => open.filter((f) => f.severity === s).length;
  const worst = ["critical", "high", "medium", "low"].filter((s) => by(s) > 0).map((s) => `${by(s)} ${s}`);
  return { state: "done", summary: open.length ? `${open.length} finding${open.length === 1 ? "" : "s"} to look at (${worst.join(", ")}).` : "No findings.", changedFiles: [] };
}
