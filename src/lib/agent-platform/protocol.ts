import type { ActivityItem, ActivityStatus } from "./activity";
import { agentDef, type AgentId } from "./registry";
import type { StepStatus, WorkflowStep } from "./workflow";

/**
 * The task protocol: one shape for handing a task to an agent and one for what
 * comes back, whatever runtime does the work (the coding engine, code review,
 * research, a workflow step). Each runtime keeps its own records; these
 * functions describe them the same way, so the orchestrator, workflows, the
 * Activity list and the agent directory read every task alike.
 *
 * An assignment carries only what the task needs (its objective, the
 * project, the user's inputs): never the whole conversation. Everything in
 * `inputs` is the user's data, never instructions to the platform.
 */

/** The states every task is described in. */
export const TASK_STATES = ["pending", "ready", "running", "waiting_dependency", "waiting_user", "completed", "failed", "cancelled"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  pending: "Pending",
  ready: "Ready",
  running: "Running",
  waiting_dependency: "Waiting for an earlier step",
  waiting_user: "Waiting for you",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const ENDED_STATES: TaskState[] = ["completed", "failed", "cancelled"];

export interface TaskAssignment {
  /** Set once the task exists. */
  taskId: string | null;
  agent: AgentId;
  agentVersion: string;
  /** What the user wants, in their words (clipped). */
  objective: string;
  /** The agent's role: the boundary of what it will do. */
  scope: string;
  /** The project it works in, if any (only this one). */
  projectId: string | null;
  /** The user's inputs: data, not instructions. */
  inputs: Record<string, unknown>;
  /** What it must not do, and what needs the user's approval. */
  constraints: string[];
  /** Tasks that must finish first (workflow steps). */
  dependsOn: string[];
  expectedOutput: string;
  doneWhen: string;
  /** Limits enforced by the runtime. */
  limits: string;
}

export interface TaskResult {
  taskId: string;
  agent: AgentId;
  state: TaskState;
  /** One line from the task's own records. */
  summary: string;
  /** Where its results are. */
  artifacts: { label: string; href: string }[];
  /** What the result rests on (test results, findings, sources), from the records only. */
  evidence: string[];
  errors: string[];
  /** What's still open, e.g. what it waits for. */
  unresolved: string[];
  /** The obvious next step, if any. */
  next: string | null;
}

const LIMITS: Partial<Record<AgentId, string>> = {
  engineer: "Step, token and time limits per task; 2 minutes per command; the plan's computer minutes",
  bug_fixer: "Step, token and time limits per task (5 more steps than the Software Engineer); 2 minutes per command",
  qa_tester: "Step, token and time limits per task; edits limited to test files; 2 minutes per command",
  website_builder: "Step, token and time limits per task; 2 minutes per command",
  code_review: "Up to 400 files / 1.5 MB; one model call per part of up to 45 KB",
  deep_research: "The plan's web searches; quick 2, standard 4, deep 6 questions",
  security: "Rate limits per user and per website; scanners only on verified websites",
  data_analyst: "Up to 20,000 rows and 50 columns per file",
};

/** The assignment for one task, built from the agent's registry entry and the user's request. */
export function assignmentFor(agent: AgentId, a: { objective: string; projectId?: string | null; inputs?: Record<string, unknown>; dependsOn?: string[]; taskId?: string | null }): TaskAssignment {
  const def = agentDef(agent);
  if (!def) throw new Error(`Unknown agent ${agent}`);
  return {
    taskId: a.taskId ?? null,
    agent,
    agentVersion: def.version,
    objective: a.objective.trim().slice(0, 500),
    scope: def.role,
    projectId: a.projectId ?? null,
    inputs: a.inputs ?? {},
    constraints: [...def.approvals.map((x) => `Needs approval: ${x}`), ...def.outOfScope.map((o) => `Not in scope: ${o.what}`)],
    dependsOn: a.dependsOn ?? [],
    expectedOutput: def.output,
    doneWhen: def.doneWhen,
    limits: LIMITS[agent] ?? "The runtime's limits",
  };
}

const FROM_ACTIVITY: Record<ActivityStatus, TaskState> = {
  planning: "running",
  running: "running",
  awaiting_approval: "waiting_user",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
};

/** A task's result, from its Activity entry (which is read from the task's own records). */
export function resultFromActivity(item: ActivityItem): TaskResult {
  const state = FROM_ACTIVITY[item.status];
  const label = item.kind === "review" ? "Open the review" : item.kind === "research" ? "Open the report" : "Open the task";
  return {
    taskId: item.id,
    agent: item.agent,
    state,
    summary: item.detail ?? item.title,
    artifacts: [{ label, href: item.href }],
    evidence: state === "completed" && item.detail ? [item.detail] : [],
    errors: state === "failed" && item.detail ? [item.detail] : [],
    unresolved: state === "waiting_user" && item.detail ? [item.detail] : [],
    next: state === "waiting_user" ? (item.detail ?? "Open the task to answer") : state === "failed" ? "Open the task to retry or change the request" : null,
  };
}

const FROM_STEP: Record<StepStatus, TaskState> = {
  pending: "waiting_dependency",
  ready: "ready",
  running: "running",
  waiting: "waiting_user",
  done: "completed",
  failed: "failed",
  skipped: "cancelled",
  cancelled: "cancelled",
};

/** A workflow step in the protocol's states. */
export function stepState(step: Pick<WorkflowStep, "status">): TaskState {
  return FROM_STEP[step.status];
}
