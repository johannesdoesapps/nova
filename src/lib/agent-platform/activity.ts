import { taskTitle } from "../code/agent/history";
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

export type ActivityKind = "code_run" | "review" | "research";

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
}

export interface CodeRunRow {
  id: string;
  project_id: string;
  request: string;
  status: string;
  options: { agent?: "bug_fixer" | "qa_tester"; web?: boolean; readOnly?: boolean } | null;
  pending: { kind: string } | null;
  error: string | null;
  report: { state?: string; verification?: string; files?: unknown[] } | null;
  created_at: string;
  updated_at: string;
  project?: { name: string } | null;
}

const WAITING: Record<string, string> = {
  plan: "Approve the plan",
  command: "Approve a command",
  edits: "Review the edits",
  question: "Answer a question",
  computer: "Start the project's computer",
  limit: "A limit was reached",
};

export function fromCodeRun(r: CodeRunRow): ActivityItem {
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

export function fromReview(r: ReviewRowLite): ActivityItem {
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
  };
}

export interface ResearchRowLite {
  id: string;
  question: string;
  status: string;
  phase: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const PHASE: Record<string, string> = { planning: "Planning the questions", researching: "Searching the web", writing: "Writing the report", done: "Report ready" };

export function fromResearch(r: ResearchRowLite): ActivityItem {
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
