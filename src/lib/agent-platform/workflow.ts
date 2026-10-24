import { z } from "zod";
import type { BugInput, QaInput } from "../code/agent/profiles";
import { bugInput } from "../code/agent/profiles";
import type { AgentId } from "./registry";

/**
 * Multi-agent workflows: a fixed sequence of task agents on one project, ending
 * with the user's decision. The order is set by the template, never by an
 * agent: agents can't start other agents, a step runs only after the one
 * before it ended, and nothing is pushed, merged or deployed by a workflow.
 * Each step starts an ordinary task (a coding-agent run or a code review)
 * with that agent's own limits, approvals and records.
 *
 * Pure: the server (workflow-server.ts) reads the child tasks and stores what
 * these functions decide, so every transition is testable.
 */

export const WORKFLOW_TEMPLATES = ["fix_and_verify"] as const;
export type WorkflowTemplate = (typeof WORKFLOW_TEMPLATES)[number];

export type StepKind = "code_run" | "review" | "approval";
export type StepStatus = "pending" | "running" | "waiting" | "done" | "failed" | "skipped";
export type WorkflowStatus = "running" | "waiting" | "needs_approval" | "completed" | "failed" | "cancelled";

export interface StepDef {
  key: "fix" | "test" | "review" | "approve";
  agent: AgentId | null;
  kind: StepKind;
  label: string;
  /** Can be skipped after it fails (the workflow then goes on without it). */
  optional: boolean;
}

export const TEMPLATE_INFO: Record<WorkflowTemplate, { name: string; description: string; steps: StepDef[] }> = {
  fix_and_verify: {
    name: "Fix and verify",
    description: "Bug Fixing reproduces and fixes the bug, QA Testing adds regression tests and runs them, Code Review checks the changes for bugs and security problems, then you decide.",
    steps: [
      { key: "fix", agent: "bug_fixer", kind: "code_run", label: "Reproduce and fix the bug", optional: false },
      { key: "test", agent: "qa_tester", kind: "code_run", label: "Add regression tests and run them", optional: true },
      { key: "review", agent: "code_review", kind: "review", label: "Security and code review of the changes", optional: true },
      { key: "approve", agent: null, kind: "approval", label: "Your decision", optional: false },
    ],
  },
};

export interface WorkflowStep {
  key: StepDef["key"];
  agent: AgentId | null;
  kind: StepKind;
  label: string;
  optional: boolean;
  status: StepStatus;
  taskId: string | null;
  attempts: number;
  startedAt: string | null;
  endedAt: string | null;
  /** One line about how it ended, from the task's records. */
  summary: string | null;
  error: string | null;
}

export interface WorkflowState {
  status: WorkflowStatus;
  current: number;
  steps: WorkflowStep[];
  log: { at: string; text: string }[];
  error: string | null;
}

/** Attempts per step (the first run and two retries). */
export const MAX_ATTEMPTS = 3;
/** A workflow not finished within this long is stopped when it's next advanced. */
export const WORKFLOW_TTL_MS = 24 * 60 * 60_000;
const LOG_MAX = 200;

export const workflowInput = z.object({
  template: z.enum(WORKFLOW_TEMPLATES),
  projectId: z.string().uuid(),
  bug: bugInput,
  options: z.object({ modelId: z.string().max(120).nullable().optional(), approvePlans: z.boolean().optional(), commands: z.enum(["safe", "ask"]).optional() }).optional(),
});
export type WorkflowInput = z.infer<typeof workflowInput>;

export function newSteps(template: WorkflowTemplate): WorkflowStep[] {
  return TEMPLATE_INFO[template].steps.map((d) => ({ ...d, status: "pending", taskId: null, attempts: 0, startedAt: null, endedAt: null, summary: null, error: null }));
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

/** Move to the step after `index`: the approval step waits for the user; anything else is started next. */
function moveOn(w: WorkflowState, index: number, at: string): WorkflowState {
  const next = index + 1;
  const step = w.steps[next];
  if (!step) return { ...w, current: index, status: "completed" };
  if (step.kind === "approval") {
    const steps = w.steps.map((s, i) => (i === next ? { ...s, status: "waiting" as const, startedAt: at } : s));
    return { ...w, steps, current: next, status: "needs_approval", log: addLog(w.log, "Ready for your decision.", at) };
  }
  return { ...w, current: next, status: "running" };
}

/** Apply what was observed about the current step's task. */
export function observe(w: WorkflowState, child: ChildState, at: string): WorkflowState {
  const i = w.current;
  const step = w.steps[i];
  if (!step || isTerminal(w.status) || step.status === "pending") return w;
  const set = (patch: Partial<WorkflowStep>) => w.steps.map((s, k) => (k === i ? { ...s, ...patch } : s));
  switch (child.state) {
    case "working":
      return step.status === "running" && w.status === "running" ? w : { ...w, status: "running", steps: set({ status: "running" }) };
    case "waiting":
      return step.status === "waiting" && w.status === "waiting"
        ? w
        : { ...w, status: "waiting", steps: set({ status: "waiting" }), log: addLog(w.log, `${step.label}: waiting for you (${child.reason}).`, at) };
    case "failed":
    case "cancelled": {
      const error = child.state === "failed" ? child.error : "The task was stopped.";
      return {
        ...w,
        status: "failed",
        error: `${step.label}: ${error}`,
        steps: set({ status: "failed", endedAt: at, error }),
        log: addLog(w.log, `${step.label}: ${child.state === "failed" ? "failed" : "stopped"}. ${error}`, at),
      };
    }
    case "done": {
      let next: WorkflowState = { ...w, error: null, steps: set({ status: "done", endedAt: at, summary: child.summary, error: null }), log: addLog(w.log, `${step.label}: ${child.summary}`, at) };
      // A fix that changed nothing leaves nothing to test or review.
      if (step.key === "fix" && child.changedFiles.length === 0) {
        next = {
          ...next,
          steps: next.steps.map((s) => (s.key === "test" || s.key === "review" ? { ...s, status: "skipped" as const, summary: "Skipped: the fix step changed no files." } : s)),
          log: addLog(next.log, "Regression tests and review skipped: the fix step changed no files.", at),
        };
        const approve = next.steps.findIndex((s) => s.kind === "approval");
        return moveOn(next, approve - 1, at);
      }
      return moveOn(next, i, at);
    }
  }
}

/** The step was started: its task exists. */
export function started(w: WorkflowState, taskId: string, at: string): WorkflowState {
  const i = w.current;
  const steps = w.steps.map((s, k) => (k === i ? { ...s, status: "running" as const, taskId, attempts: s.attempts + 1, startedAt: at, endedAt: null, error: null, summary: null } : s));
  return { ...w, steps, status: "running", error: null, log: addLog(w.log, `${w.steps[i]!.label}: started.`, at) };
}

/** Starting the step failed before any task existed (quota, a project busy with another task, …). */
export function startFailed(w: WorkflowState, error: string, at: string): WorkflowState {
  const i = w.current;
  const steps = w.steps.map((s, k) => (k === i ? { ...s, status: "failed" as const, attempts: s.attempts + 1, error, endedAt: at } : s));
  return { ...w, steps, status: "failed", error: `${w.steps[i]!.label}: ${error}`, log: addLog(w.log, `${w.steps[i]!.label}: couldn't start. ${error}`, at) };
}

export type Recovery = "retry" | "skip";

/** What the user may do with a failed workflow. */
export function recoveries(w: WorkflowState): Recovery[] {
  const step = w.steps[w.current];
  if (w.status !== "failed" || !step || step.status !== "failed") return [];
  const out: Recovery[] = [];
  if (step.attempts < MAX_ATTEMPTS) out.push("retry");
  if (step.optional) out.push("skip");
  return out;
}

export function recover(w: WorkflowState, action: Recovery, at: string): WorkflowState | null {
  if (!recoveries(w).includes(action)) return null;
  const i = w.current;
  const step = w.steps[i]!;
  if (action === "retry") {
    const steps = w.steps.map((s, k) => (k === i ? { ...s, status: "pending" as const, error: null } : s));
    return { ...w, steps, status: "running", error: null, log: addLog(w.log, `${step.label}: trying again (attempt ${step.attempts + 1} of ${MAX_ATTEMPTS}).`, at) };
  }
  const steps = w.steps.map((s, k) => (k === i ? { ...s, status: "skipped" as const, summary: "Skipped by you after it failed." } : s));
  return moveOn({ ...w, steps, error: null, log: addLog(w.log, `${step.label}: skipped by you.`, at) }, i, at);
}

export type Decision = "approve" | "reject";

export function decide(w: WorkflowState, action: Decision, at: string): WorkflowState | null {
  if (w.status !== "needs_approval") return null;
  const i = w.current;
  const steps = w.steps.map((s, k) => (k === i ? { ...s, status: "done" as const, endedAt: at, summary: action === "approve" ? "Approved" : "Rejected; the changes were undone" } : s));
  return { ...w, steps, status: "completed", log: addLog(w.log, action === "approve" ? "You approved the changes." : "You rejected the changes; they were undone.", at) };
}

export function cancel(w: WorkflowState, at: string): WorkflowState | null {
  if (isTerminal(w.status)) return null;
  const i = w.current;
  const steps = w.steps.map((s, k) => (k === i && !["done", "skipped"].includes(s.status) ? { ...s, status: "failed" as const, error: "Stopped by you.", endedAt: at } : s));
  return { ...w, steps, status: "cancelled", log: addLog(w.log, "You stopped the workflow.", at) };
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

/** The tasks whose changes the review step covers (the fix and, when it ran, the tests). */
export function reviewTaskIds(w: Pick<WorkflowState, "steps">): string[] {
  return w.steps.filter((s) => s.kind === "code_run" && s.status === "done" && s.taskId).map((s) => s.taskId!);
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
