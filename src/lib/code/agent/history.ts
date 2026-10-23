import { ENDED_STATUSES, type RunStatus, type RunView, type TaskState } from "./types";
import { taskState } from "./verdict";

/**
 * Task history: the user's coding-agent tasks across their projects, as the
 * History page lists them. Pure (no server imports): the server builds the
 * list with these rules and the page words it the same way.
 */

export const TASK_FILTERS = ["all", "active", "waiting", "succeeded", "warnings", "unverified", "failed", "cancelled"] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];

export const TASK_FILTER_LABEL: Record<TaskFilter, string> = {
  all: "All",
  active: "Working",
  waiting: "Waiting for you",
  succeeded: "Succeeded",
  warnings: "With warnings",
  unverified: "Not verified",
  failed: "Failed",
  cancelled: "Stopped",
};

export const TASK_SORTS = ["activity", "newest", "oldest"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

export const TASK_SORT_LABEL: Record<TaskSort, string> = { activity: "Last activity", newest: "Newest first", oldest: "Oldest first" };

/**
 * Which rows a filter keeps: by the run's status, and for finished runs by the
 * state recorded in its report (verified, checked, warnings, unverified).
 */
export function filterQuery(f: TaskFilter): { statuses?: RunStatus[]; states?: TaskState[] } {
  switch (f) {
    case "active":
      return { statuses: ["planning", "running"] };
    case "waiting":
      return { statuses: ["awaiting_approval", "needs_input"] };
    case "succeeded":
      return { statuses: ["completed"], states: ["verified", "checked"] };
    case "warnings":
      return { statuses: ["completed"], states: ["warnings"] };
    case "unverified":
      return { statuses: ["completed"], states: ["unverified"] };
    case "failed":
      return { statuses: ["failed"] };
    case "cancelled":
      return { statuses: ["cancelled"] };
    default:
      return {};
  }
}

/**
 * A search term made safe for a PostgREST ilike filter inside or(): characters
 * that carry meaning there (wildcards, commas, parentheses, quotes, backslashes)
 * become spaces. Null when nothing searchable is left.
 */
export function searchPattern(q: string | null | undefined): string | null {
  const s = (q ?? "")
    .replace(/[%_,()*\\"'.:]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return s ? `%${s}%` : null;
}

/** A readable title from the request: its first line (the optional details block is left out), shortened. */
export function taskTitle(request: string): string {
  const main = request.split(/\n\s*Details:\s*\n/)[0] ?? request;
  const line =
    main
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "Untitled task";
  return line.length > 120 ? `${line.slice(0, 117).trimEnd()}…` : line;
}

export type Continuation = { kind: "resume"; label: string; explain: string } | { kind: "follow_up"; label: string; explain: string };

/**
 * How a task can be picked up again. An open task (working or waiting) is
 * resumed where it stopped; a finished one can't be reopened, so continuing
 * starts a new task in the same project that's given this one's record.
 */
export function continuation(status: RunStatus): Continuation {
  if (!ENDED_STATUSES.includes(status)) {
    return {
      kind: "resume",
      label: "Resume",
      explain: "Picks up where it stopped. If a step was interrupted, the agent is told which actions may or may not have run and checks before doing anything again; nothing is replayed.",
    };
  }
  return {
    kind: "follow_up",
    label: "Continue",
    explain:
      "A finished task can't be reopened: the agent's working memory for it is closed. Continue starts a new task in the same project with this task's request, summary, changed files and check results. The project's files are as they are now; earlier commands aren't run again.",
  };
}

export interface TaskSummary {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  /** The agent's own summary (its words), shortened. */
  summary: string | null;
  status: RunStatus;
  state: TaskState;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  models: string[];
  steps: number;
  costUsd: number | null;
  filesChanged: number;
  continuation: Continuation;
}

export function toTaskSummary(run: RunView, projectName: string, filesChanged: number): TaskSummary {
  const clip = (s: string | null, n: number) => (s && s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
  return {
    id: run.id,
    projectId: run.projectId,
    projectName,
    title: taskTitle(run.request),
    summary: clip(run.summary, 400),
    status: run.status,
    state: taskState(run),
    error: clip(run.error, 300),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    models: run.report?.usage.models ?? run.usage.models ?? [],
    steps: run.steps,
    costUsd: run.report?.usage.costUsd ?? run.usage.costUsd ?? null,
    filesChanged,
    continuation: continuation(run.status),
  };
}
