import { taskTitle } from "../code/agent/history";
import { classifyFailure, type FailureInfo } from "./failures";
import { codeRunOutcome, researchOutcome, reviewOutcome, securityOutcome, workflowOutcome, type Outcome } from "./outcomes";
import type { AgentId } from "./registry";

/**
 * One list of the user's agent tasks, whatever ran them: coding-agent tasks
 * (Software Engineer, Bug Fixing, QA Testing, Website Builder), code reviews
 * and research runs. Each keeps its own records and page; this only puts
 * them side by side with one set of statuses, for the Activity page and for
 * the Orbis Agent to answer "what's still running?". Pure: the server reads
 * the rows and these functions describe them.
 */

export const ACTIVITY_STATUSES = ["planning", "running", "awaiting_approval", "completed", "failed", "cancelled"] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

export const ACTIVITY_STATUS_LABEL: Record<ActivityStatus, string> = {
  planning: "Planning",
  running: "Running",
  awaiting_approval: "Waiting for you",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const OPEN_STATUSES: ActivityStatus[] = ["planning", "running", "awaiting_approval"];

export type ActivityKind = "code_run" | "review" | "research" | "security" | "workflow";

/** An open task with no recorded activity for this long isn't moving: tasks advance while their page is open. */
export const STALL_MS = 10 * 60_000;

export interface ActivityItem {
  kind: ActivityKind;
  agent: AgentId;
  id: string;
  title: string;
  status: ActivityStatus;
  /** One line from the task's own records (its outcome, phase or what it waits for). */
  detail: string | null;
  href: string;
  projectName: string | null;
  createdAt: string;
  updatedAt: string;
  /** How it ended, from its records (null while open, and when cancelled). See outcomes.ts. */
  outcome: Outcome | null;
  outcomeNote: string | null;
  /** Why it failed and whether trying again can help (failed tasks only). */
  failure: FailureInfo | null;
  /** Measured progress from the task's records (coding tasks: steps taken of the step limit). Never an estimate. */
  progress: { done: number; limit: number; unit: "steps" } | null;
  /** Recorded model cost of the task in USD, when it was recorded. */
  costUsd: number | null;
  /** Where to POST to stop it, while it's open and can be stopped. */
  cancelUrl: string | null;
  /** Open, not waiting for the user, and nothing recorded for STALL_MS: it continues when its page is opened. */
  stalled: boolean;
}

/** The fields every task gets, from its status, records and the time now. */
function common(status: ActivityStatus, updatedAt: string, now: number, o: { outcome: Outcome | null; note: string | null }, error: string | null, failureKind?: string | null) {
  return {
    outcome: o.outcome,
    outcomeNote: o.note,
    failure: status === "failed" ? classifyFailure(error, failureKind) : null,
    stalled: (status === "running" || status === "planning") && now - Date.parse(updatedAt) > STALL_MS,
  };
}

export interface CodeRunRow {
  id: string;
  project_id: string;
  request: string;
  status: string;
  options: { agent?: "bug_fixer" | "qa_tester"; web?: boolean; readOnly?: boolean } | null;
  pending: { kind: string } | null;
  error: string | null;
  report: { state?: string; verification?: string; files?: unknown[]; failure?: string } | null;
  steps?: number | null;
  step_limit?: number | null;
  cost?: number | string | null;
  created_at: string;
  updated_at: string;
  project?: { name: string } | null;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

const WAITING: Record<string, string> = {
  plan: "Approve the plan",
  command: "Approve a command",
  edits: "Review the edits",
  question: "Answer a question",
  computer: "Start the project's computer",
  limit: "A limit was reached",
};

export function fromCodeRun(r: CodeRunRow, now = Date.now()): ActivityItem {
  const status: ActivityStatus =
    r.status === "planning" ? "planning" : r.status === "running" ? "running" : r.status === "awaiting_approval" || r.status === "needs_input" ? "awaiting_approval" : (r.status as ActivityStatus);
  const agent: AgentId = r.options?.agent ?? (r.options?.web ? "website_builder" : "engineer");
  let detail: string | null = null;
  if (status === "awaiting_approval") detail = WAITING[r.pending?.kind ?? ""] ?? "Needs your input";
  else if (status === "failed") detail = r.error ? r.error.slice(0, 200) : null;
  else if (status === "completed" && r.report) {
    const files = r.report.files?.length ?? 0;
    const tests = r.report.verification === "passed" ? "tests passed" : r.report.verification === "failed" ? "tests failed" : r.report.verification === "stale" ? "tests out of date" : "no tests ran";
    detail = `${files} file${files === 1 ? "" : "s"} changed · ${tests}`;
  }
  return {
    kind: "code_run",
    agent,
    id: r.id,
    title: taskTitle(r.request),
    status,
    detail,
    href: `/code/${r.project_id}?run=${r.id}`,
    projectName: r.project?.name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...common(status, r.updated_at, now, codeRunOutcome({ status: r.status, pendingKind: r.pending?.kind, state: r.report?.state, verification: r.report?.verification }), r.error, r.report?.failure),
    progress: r.steps !== null && r.steps !== undefined && r.step_limit ? { done: r.steps, limit: r.step_limit, unit: "steps" } : null,
    costUsd: num(r.cost),
    cancelUrl: OPEN_STATUSES.includes(status) ? `/api/code/agent/${r.id}/cancel` : null,
  };
}

export interface ReviewRowLite {
  id: string;
  title: string;
  status: string;
  error: string | null;
  findings: { severity: string; status: string }[] | null;
  created_at: string;
  updated_at: string;
}

export function fromReview(r: ReviewRowLite, now = Date.now()): ActivityItem {
  const open = (r.findings ?? []).filter((f) => f.status === "open").length;
  return {
    kind: "review",
    agent: "code_review",
    id: r.id,
    title: r.title,
    status: r.status as ActivityStatus,
    detail: r.status === "completed" ? `${open} open finding${open === 1 ? "" : "s"}` : r.status === "failed" ? (r.error?.slice(0, 200) ?? null) : null,
    href: `/review/${r.id}`,
    projectName: null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...common(r.status as ActivityStatus, r.updated_at, now, reviewOutcome(r), r.error),
    progress: null,
    costUsd: null,
    cancelUrl: r.status === "running" ? `/api/review/${r.id}/cancel` : null,
  };
}

export interface ResearchRowLite {
  id: string;
  question: string;
  status: string;
  phase: string;
  error: string | null;
  check?: { cited?: number[]; invalidRemoved?: number; uncitedParagraphs?: number; findingParagraphs?: number } | null;
  created_at: string;
  updated_at: string;
}

const PHASE: Record<string, string> = { planning: "Planning the questions", researching: "Searching the web", writing: "Writing the report", done: "Report ready" };

export function fromResearch(r: ResearchRowLite, now = Date.now()): ActivityItem {
  const status: ActivityStatus = r.status === "running" ? (r.phase === "planning" ? "planning" : "running") : (r.status as ActivityStatus);
  return {
    kind: "research",
    agent: "deep_research",
    id: r.id,
    title: r.question.length > 120 ? `${r.question.slice(0, 117).trimEnd()}…` : r.question,
    status,
    detail: r.status === "failed" ? (r.error?.slice(0, 200) ?? null) : (PHASE[r.phase] ?? null),
    href: `/research/${r.id}`,
    projectName: null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...common(status, r.updated_at, now, researchOutcome(r), r.error),
    progress: null,
    costUsd: null,
    cancelUrl: r.status === "running" ? `/api/research/${r.id}/cancel` : null,
  };
}

export interface SecurityRunRowLite {
  id: string;
  agent: string;
  action: string;
  status: string;
  asset: string | null;
  error: string | null;
  tools: { tool: string; status: string }[] | null;
  started_at: string;
  finished_at: string | null;
}

const SECURITY_AGENT: Record<string, string> = { sentinel: "Sentinel", threat_hunter: "Threat Hunter", code_guardian: "Code Guardian", coordinated: "Security Team" };

/** A Security Team scan (top-level runs only; a coordinated run's parts are on its own page). */
export function fromSecurityRun(r: SecurityRunRowLite, now = Date.now()): ActivityItem {
  const status = r.status as ActivityStatus;
  const failed = (r.tools ?? []).filter((t) => t.status === "failed").length;
  const updatedAt = r.finished_at ?? r.started_at;
  return {
    kind: "security",
    agent: "security",
    id: r.id,
    title: `${SECURITY_AGENT[r.agent] ?? "Security"}: ${r.action.replace(/_/g, " ")}${r.asset ? ` · ${r.asset}` : ""}`.slice(0, 160),
    status,
    detail: status === "failed" ? (r.error?.slice(0, 200) ?? null) : null,
    href: `/agents/security/runs/${r.id}`,
    projectName: null,
    createdAt: r.started_at,
    updatedAt,
    ...common(status, updatedAt, now, securityOutcome({ status: r.status, toolsFailed: failed }), r.error),
    progress: null,
    costUsd: null,
    // Scans run within one request; there's nothing to stop from here.
    cancelUrl: null,
  };
}

export interface WorkflowRowLite {
  id: string;
  title: string;
  status: string;
  error: string | null;
  decision: { action: string } | null;
  steps: { key: string; label: string; status: string }[];
  created_at: string;
  updated_at: string;
  project?: { name: string } | null;
}

/** A multi-agent workflow (Fix and verify). */
export function fromWorkflow(r: WorkflowRowLite, now = Date.now()): ActivityItem {
  const status: ActivityStatus = r.status === "needs_approval" || r.status === "waiting" ? "awaiting_approval" : (r.status as ActivityStatus);
  const waitingOn = r.steps.find((s) => s.status === "waiting" || s.status === "running");
  return {
    kind: "workflow",
    agent: "bug_fixer",
    id: r.id,
    title: r.title,
    status,
    detail:
      r.status === "needs_approval"
        ? "Your decision"
        : waitingOn
          ? `${waitingOn.label}: ${waitingOn.status === "waiting" ? "waiting for you" : "working"}`
          : r.status === "failed"
            ? (r.error?.slice(0, 200) ?? null)
            : null,
    href: `/agents/workflows/${r.id}`,
    projectName: r.project?.name ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...common(status, r.updated_at, now, workflowOutcome(r), r.error),
    progress: null,
    costUsd: null,
    cancelUrl: OPEN_STATUSES.includes(status) ? `/api/workflows/${r.id}/cancel` : null,
  };
}

/** Newest activity first. */
export function mergeActivity(...lists: ActivityItem[][]): ActivityItem[] {
  return lists.flat().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** A short, factual list of the user's open tasks, for the Orbis Agent's context (titles are the user's own text, so fenced as data). */
export function openTasksSummary(items: ActivityItem[], names: Record<string, string>): string {
  const open = items.filter((i) => OPEN_STATUSES.includes(i.status));
  const recent = items.filter((i) => !OPEN_STATUSES.includes(i.status)).slice(0, 5);
  const line = (i: ActivityItem) =>
    `- [${names[i.agent] ?? i.agent}] "${i.title.replace(/[<>]/g, "")}" — ${ACTIVITY_STATUS_LABEL[i.status]}${i.detail ? ` (${i.detail})` : ""}${i.projectName ? ` · project ${i.projectName}` : ""} · ${i.href}`;
  return [
    "<user_tasks>",
    open.length ? `Open tasks (${open.length}):\n${open.map(line).join("\n")}` : "No open tasks.",
    recent.length ? `Recently finished:\n${recent.map(line).join("\n")}` : "",
    "</user_tasks>",
  ]
    .filter(Boolean)
    .join("\n");
}
