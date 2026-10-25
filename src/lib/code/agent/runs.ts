import "server-only";
import { projectAllowed } from "../../bastion/customer/policy";
import { workspacePolicy } from "../../bastion/server";
import { ApiError, requireUuid } from "@/lib/http";
import { getPlatformSettings } from "@/lib/ai/settings";
import { redactSecrets } from "@/lib/usage";
import { agentDef } from "../../agent-platform/registry";
import { dbError, type Authed } from "../server";
import type { PairState } from "../pair/protocol";
import type { TranscriptMessage } from "./protocol";
import type { Checkpoint } from "./tools";
import {
  DEFAULT_OPTIONS,
  EMPTY_USAGE,
  type AgentChange,
  type AgentEvent,
  type AgentPlan,
  type EventKind,
  type Pending,
  type RunOptions,
  EMPTY_CHECKS,
  type RunChecks,
  type RunReport,
  type RunStatus,
  type RunTests,
  type RunUsage,
  type RunView,
} from "./types";

/**
 * The coding agent's records, through the user's own Supabase session (so
 * row-level security keeps them to their owner): runs, the append-only
 * activity log, and each file's content before and after a run.
 */

export interface RunRow {
  id: string;
  project_id: string;
  request: string;
  status: RunStatus;
  options: Partial<RunOptions> | null;
  plan: AgentPlan | null;
  pending: Pending | null;
  transcript: TranscriptMessage[];
  summary: string | null;
  error: string | null;
  steps: number;
  step_limit: number;
  locked_until: string | null;
  token_budget: number;
  usage: Partial<RunUsage> | null;
  active_ms: number;
  time_limit_ms: number;
  tests: RunTests | null;
  checks: Partial<RunChecks> | null;
  recent: string[] | null;
  last_edit_at: string | null;
  report: RunReport | null;
  /** Pair coding (two agents): its state; null for an ordinary task. */
  pair?: PairState | null;
  created_at: string;
  updated_at: string;
}

const COMMON_COLS =
  "id, project_id, request, status, options, plan, pending, summary, error, steps, step_limit, locked_until, token_budget, usage, active_ms, time_limit_ms, tests, checks, recent, last_edit_at, report, pair, created_at, updated_at";
const RUN_COLS = `${COMMON_COLS}, transcript`;
const LIST_COLS = COMMON_COLS;

export function runOptions(r: Pick<RunRow, "options">): RunOptions {
  return { ...DEFAULT_OPTIONS, ...(r.options ?? {}) };
}

export function runUsage(r: Pick<RunRow, "usage">): RunUsage {
  return { ...EMPTY_USAGE, ...(r.usage ?? {}) };
}

export function runChecks(r: Pick<RunRow, "checks">): RunChecks {
  return { ...EMPTY_CHECKS, ...(r.checks ?? {}) };
}

export function toRunView(r: Omit<RunRow, "transcript"> & { transcript?: unknown }, now = Date.now()): RunView {
  return {
    id: r.id,
    projectId: r.project_id,
    request: r.request,
    status: r.status,
    options: runOptions(r),
    plan: r.plan,
    pending: r.pending,
    summary: r.summary,
    error: r.error,
    steps: r.steps,
    stepLimit: r.step_limit,
    busy: !!r.locked_until && Date.parse(r.locked_until) > now,
    usage: runUsage(r),
    tokenBudget: r.token_budget,
    activeMs: Number(r.active_ms),
    timeLimitMs: Number(r.time_limit_ms),
    tests: r.tests,
    checks: runChecks(r),
    report: r.report,
    pair: r.pair ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: runVersion(r),
    stepStartedAt: r.locked_until && Date.parse(r.locked_until) > now ? new Date(Date.parse(r.locked_until) - STEP_LOCK_MS).toISOString() : null,
  };
}

export async function createRun(auth: Authed, input: { projectId: string; request: string; options: RunOptions; stepLimit: number; pair?: PairState }): Promise<RunRow> {
  // Orbis Bastion: a workspace boundary may keep this coding agent to other projects (every way of starting one comes here).
  const agent = input.options.agent ?? (input.options.web ? "website_builder" : "engineer");
  const ws = await workspacePolicy(auth.supabase, auth.user.id);
  if (ws === "unavailable") throw new ApiError("provider_unavailable", "Orbis Bastion couldn't read your workspace's security policy, so agents are paused (fail closed). Try again in a moment.");
  if (!projectAllowed(ws, agent, input.projectId)) throw new ApiError("forbidden", `Your workspace's security policy keeps the ${agent.replace("_", " ")} agent to other projects. Change it in Bastion → Policies.`, { scope: "bastion" });
  const { data, error } = await auth.supabase
    .from("code_agent_runs")
    .insert({
      project_id: input.projectId,
      request: input.request,
      status: input.options.approvePlans || input.pair ? "planning" : "running",
      // Which version of the agent's definition ran it (never taken from the request).
      options: { ...input.options, agentVersion: agentDef(input.options.agent ?? (input.options.web ? "website_builder" : "engineer"))?.version },
      step_limit: input.stepLimit,
      ...(input.pair ? { pair: input.pair } : {}),
    })
    .select(RUN_COLS)
    .single();
  if (error) throw dbError(error, "code.agent.create");
  const row = data as RunRow;
  // An administrator's default limits for new tasks (the database defaults otherwise). Set after the insert: these columns can be updated but not inserted by users.
  const limits = (await getPlatformSettings()).taskLimits;
  const patch = { ...(limits.tokenBudget ? { token_budget: limits.tokenBudget } : {}), ...(limits.timeLimitMinutes ? { time_limit_ms: limits.timeLimitMinutes * 60_000 } : {}) };
  if (!Object.keys(patch).length) return row;
  const { data: updated, error: limitError } = await auth.supabase.from("code_agent_runs").update(patch).eq("id", row.id).select(RUN_COLS).single();
  if (limitError) throw dbError(limitError, "code.agent.limits");
  return updated as RunRow;
}

/** A run's version for polling: it changes whenever the row is saved or a step takes or releases it. */
export function runVersion(r: Pick<RunRow, "updated_at" | "locked_until">): string {
  return `${r.updated_at}|${r.locked_until ?? ""}`;
}

/** Just what tells whether a run changed (a cheap read before the whole row). */
export async function getRunVersion(auth: Authed, runId: string): Promise<{ version: string; busy: boolean; stepStartedAt: string | null } | null> {
  requireUuid(runId);
  const { data, error } = await auth.supabase.from("code_agent_runs").select("updated_at, locked_until").eq("id", runId).maybeSingle();
  if (error) throw dbError(error, "code.agent.version");
  if (!data) return null;
  const r = data as Pick<RunRow, "updated_at" | "locked_until">;
  const busy = !!r.locked_until && Date.parse(r.locked_until) > Date.now();
  return { version: runVersion(r), busy, stepStartedAt: busy ? new Date(Date.parse(r.locked_until!) - STEP_LOCK_MS).toISOString() : null };
}

/** The run without its transcript (what the page shows). */
export async function getRunForView(auth: Authed, runId: string): Promise<RunRow> {
  requireUuid(runId);
  const { data, error } = await auth.supabase.from("code_agent_runs").select(LIST_COLS).eq("id", runId).maybeSingle();
  if (error) throw dbError(error, "code.agent.get");
  if (!data) throw new ApiError("not_found", "Agent run not found.");
  return data as RunRow;
}

export async function getRun(auth: Authed, runId: string): Promise<RunRow> {
  requireUuid(runId);
  const { data, error } = await auth.supabase.from("code_agent_runs").select(RUN_COLS).eq("id", runId).maybeSingle();
  if (error) throw dbError(error, "code.agent.get");
  if (!data) throw new ApiError("not_found", "Agent run not found.");
  return data as RunRow;
}

const ENDED: RunStatus[] = ["completed", "failed", "cancelled"];

export async function listRuns(auth: Authed, projectId: string, limit = 30): Promise<RunView[]> {
  const { data, error } = await auth.supabase.from("code_agent_runs").select(LIST_COLS).eq("project_id", projectId).order("created_at", { ascending: false }).limit(limit);
  if (error) throw dbError(error, "code.agent.list");
  return (data as RunRow[]).map((r) => toRunView(r));
}

/**
 * The user's tasks across all their projects (History): newest activity first by default, filtered by
 * status or recorded outcome, searched in the request and the agent's summary. Always limited to the
 * signed-in user here as well as by row-level security. One more row than asked for says whether there
 * are more.
 */
export async function listTasks(
  auth: Authed,
  o: {
    statuses?: RunStatus[];
    states?: string[];
    pattern?: string | null;
    projectId?: string | null;
    pairOnly?: boolean;
    agent?: string | null;
    sort: "activity" | "newest" | "oldest";
    offset: number;
    limit: number;
  },
): Promise<{ rows: (RunRow & { project: { name: string } | null })[]; more: boolean }> {
  let q = auth.supabase.from("code_agent_runs").select(`${LIST_COLS}, project:code_projects(name)`).eq("user_id", auth.user.id);
  if (o.projectId) q = q.eq("project_id", requireUuid(o.projectId));
  if (o.pairOnly) q = q.not("pair", "is", null);
  if (o.agent) q = q.eq("options->>agent", o.agent);
  if (o.statuses?.length) q = q.in("status", o.statuses);
  if (o.states?.length) q = q.in("report->>state", o.states);
  if (o.pattern) q = q.or(`request.ilike.${o.pattern},summary.ilike.${o.pattern}`);
  q = o.sort === "activity" ? q.order("updated_at", { ascending: false }) : q.order("created_at", { ascending: o.sort === "oldest" });
  const { data, error } = await q.order("id").range(o.offset, o.offset + o.limit);
  if (error) throw dbError(error, "code.agent.tasks");
  const rows = data as unknown as (RunRow & { project: { name: string } | null })[];
  return { rows: rows.slice(0, o.limit), more: rows.length > o.limit };
}

/**
 * Delete a finished task's record: its activity, change records, checkpoints and attachments go with it
 * (the database cascades). The project's files stay as they are, so the task's changes can't be undone
 * afterwards. An open task, or one a step or re-check holds right now, isn't deleted.
 */
export async function deleteRun(auth: Authed, runId: string, now = Date.now()): Promise<void> {
  const run = await getRun(auth, runId);
  if (!ENDED.includes(run.status)) throw new ApiError("conflict", "This task is still open. Stop it first, then delete it.");
  const { data, error } = await auth.supabase
    .from("code_agent_runs")
    .delete()
    .eq("id", runId)
    .eq("user_id", auth.user.id)
    .in("status", ENDED)
    .or(`locked_until.is.null,locked_until.lt.${new Date(now).toISOString()}`)
    .select("id");
  if (error) throw dbError(error, "code.agent.delete");
  if (!data?.length) throw new ApiError("conflict", "This task is busy right now (its checks may be running). Try again in a moment.");
}

/** The project's run that is still going (working or waiting for the user), if any. */
export async function openRun(auth: Authed, projectId: string): Promise<RunView | null> {
  const { data, error } = await auth.supabase
    .from("code_agent_runs")
    .select(LIST_COLS)
    .eq("project_id", projectId)
    .in("status", ["planning", "awaiting_approval", "running", "needs_input"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw dbError(error, "code.agent.open");
  return data ? toRunView(data as RunRow) : null;
}

export type RunPatch = Partial<
  Pick<
    RunRow,
    | "status"
    | "plan"
    | "pending"
    | "transcript"
    | "summary"
    | "error"
    | "steps"
    | "step_limit"
    | "locked_until"
    | "token_budget"
    | "usage"
    | "active_ms"
    | "time_limit_ms"
    | "tests"
    | "checks"
    | "recent"
    | "last_edit_at"
    | "report"
    | "pair"
  >
>;

export async function updateRun(auth: Authed, runId: string, patch: RunPatch): Promise<RunRow> {
  const { data, error } = await auth.supabase
    .from("code_agent_runs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", runId)
    .select(RUN_COLS)
    .single();
  if (error) throw dbError(error, "code.agent.update");
  return data as RunRow;
}

/**
 * Save a step's outcome only if the user hasn't stopped the run meanwhile, in
 * one conditional update (so a Stop can never be overwritten). Null when the
 * run was stopped.
 */
export async function updateRunIfNotCancelled(auth: Authed, runId: string, patch: RunPatch): Promise<RunRow | null> {
  const { data, error } = await auth.supabase
    .from("code_agent_runs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", runId)
    .neq("status", "cancelled")
    .select(RUN_COLS)
    .maybeSingle();
  if (error) throw dbError(error, "code.agent.update");
  return (data as RunRow | null) ?? null;
}

/** How long one step may hold a run (a step takes at most a model call and one command). */
export const STEP_LOCK_MS = 5 * 60_000;

/**
 * Claim the run for one step: only when it's in one of `statuses` and no other
 * step holds it. Returns null when it's busy or not in those states.
 */
export async function lockRun(auth: Authed, runId: string, statuses: RunStatus[], now = Date.now()): Promise<RunRow | null> {
  const { data, error } = await auth.supabase
    .from("code_agent_runs")
    .update({ locked_until: new Date(now + STEP_LOCK_MS).toISOString() })
    .eq("id", runId)
    .in("status", statuses)
    .or(`locked_until.is.null,locked_until.lt.${new Date(now).toISOString()}`)
    .select(RUN_COLS)
    .maybeSingle();
  if (error) throw dbError(error, "code.agent.lock");
  return (data as RunRow | null) ?? null;
}

export async function runStatus(auth: Authed, runId: string): Promise<RunStatus | null> {
  const { data } = await auth.supabase.from("code_agent_runs").select("status").eq("id", runId).maybeSingle();
  return (data as { status: RunStatus } | null)?.status ?? null;
}

// ---------------------------------------------------------------- events

const MAX_DETAIL_CHARS = 60_000;

/** Strip anything that looks like a credential from text the log keeps. */
export function scrub(text: string): string {
  return redactSecrets(text).replace(
    /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})\b/g,
    "[redacted]",
  );
}

/** A screenshot kept in an event: base64 JPEG, small enough for the log. Generated by Orbis, so it isn't scrubbed (scrubbing could corrupt it). */
const SHOT = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_SHOT_CHARS = 55_000;

function scrubDetail(input: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!input) return null;
  const shot = typeof input.screenshot === "string" && input.screenshot.length <= MAX_SHOT_CHARS && SHOT.test(input.screenshot) ? input.screenshot : null;
  if (shot) {
    const rest = { ...input };
    delete rest.screenshot;
    return { ...(scrubDetail(rest) ?? {}), screenshot: shot };
  }
  const detail = input;
  let json = scrub(JSON.stringify(detail));
  if (json.length > MAX_DETAIL_CHARS) {
    // Shorten the longest strings until it fits.
    const d = JSON.parse(json) as Record<string, unknown>;
    for (const [k, v] of Object.entries(d)) if (typeof v === "string" && v.length > 4_000) d[k] = `${v.slice(0, 4_000)}\n… (shortened)`;
    json = JSON.stringify(d);
    if (json.length > MAX_DETAIL_CHARS) return { note: "Too long to keep." };
  }
  return JSON.parse(json) as Record<string, unknown>;
}

export interface NewEvent {
  kind: EventKind;
  title: string;
  detail?: Record<string, unknown> | null;
}

/** Append events to a run's activity log, numbered after the last one. Returns their numbers. */
export async function addEvents(auth: Authed, runId: string, events: NewEvent[]): Promise<number[]> {
  if (!events.length) return [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: last } = await auth.supabase.from("code_agent_events").select("seq").eq("run_id", runId).order("seq", { ascending: false }).limit(1).maybeSingle();
    const base = ((last as { seq: number } | null)?.seq ?? 0) + 1;
    const { error } = await auth.supabase
      .from("code_agent_events")
      .insert(events.map((e, i) => ({ run_id: runId, seq: base + i, kind: e.kind, title: scrub(e.title).slice(0, 400), detail: scrubDetail(e.detail) })));
    if (!error) return events.map((_, i) => base + i);
    if (error.code !== "23505") throw dbError(error, "code.agent.events");
  }
  throw new ApiError("conflict", "The activity log is busy. Please try again.");
}

export async function listEvents(auth: Authed, runId: string, afterSeq = 0): Promise<AgentEvent[]> {
  const { data, error } = await auth.supabase.from("code_agent_events").select("id, seq, kind, title, detail, created_at").eq("run_id", runId).gt("seq", afterSeq).order("seq").limit(500);
  if (error) throw dbError(error, "code.agent.events.list");
  return (data as { id: string; seq: number; kind: EventKind; title: string; detail: Record<string, unknown> | null; created_at: string }[]).map((e) => ({
    id: e.id,
    seq: e.seq,
    kind: e.kind,
    title: e.title,
    detail: e.detail,
    createdAt: e.created_at,
  }));
}

// ---------------------------------------------------------------- changes

type ChangeRow = { id: string; path: string; before: string | null; after: string | null; reverted_at: string | null; updated_at: string };

export async function listChanges(auth: Authed, runId: string): Promise<AgentChange[]> {
  const { data, error } = await auth.supabase.from("code_agent_changes").select("id, path, before, after, reverted_at, updated_at").eq("run_id", runId).order("path").limit(1000);
  if (error) throw dbError(error, "code.agent.changes");
  return (data as ChangeRow[]).map((c) => ({ id: c.id, path: c.path, before: c.before, after: c.after, revertedAt: c.reverted_at, updatedAt: c.updated_at }));
}

/** Change counts per run, for the history list. */
export async function changeCounts(auth: Authed, runIds: string[]): Promise<Record<string, number>> {
  if (!runIds.length) return {};
  const { data, error } = await auth.supabase.from("code_agent_changes").select("run_id, before, after, reverted_at").in("run_id", runIds).limit(5000);
  if (error) throw dbError(error, "code.agent.changes.count");
  const out: Record<string, number> = {};
  for (const c of data as { run_id: string; before: string | null; after: string | null; reverted_at: string | null }[]) {
    if (c.before !== c.after && !c.reverted_at) out[c.run_id] = (out[c.run_id] ?? 0) + 1;
  }
  return out;
}

/**
 * Record what a run did to a file: its content before the run's first touch
 * is kept, and its latest content replaces the previous "after".
 */
export async function recordChanges(auth: Authed, runId: string, changes: { path: string; before: string | null; after: string | null }[]): Promise<void> {
  if (!changes.length) return;
  const { data, error } = await auth.supabase
    .from("code_agent_changes")
    .select("id, path")
    .eq("run_id", runId)
    .in(
      "path",
      changes.map((c) => c.path),
    );
  if (error) throw dbError(error, "code.agent.changes.read");
  const existing = new Map((data as { id: string; path: string }[]).map((r) => [r.path, r.id]));
  const fresh = changes.filter((c) => !existing.has(c.path));
  if (fresh.length) {
    const ins = await auth.supabase.from("code_agent_changes").insert(fresh.map((c) => ({ run_id: runId, path: c.path, before: c.before, after: c.after })));
    if (ins.error) throw dbError(ins.error, "code.agent.changes.insert");
  }
  for (const c of changes.filter((c) => existing.has(c.path))) {
    const up = await auth.supabase.from("code_agent_changes").update({ after: c.after, reverted_at: null, updated_at: new Date().toISOString() }).eq("id", existing.get(c.path)!);
    if (up.error) throw dbError(up.error, "code.agent.changes.update");
  }
}

export async function markReverted(auth: Authed, changeIds: string[]): Promise<void> {
  if (!changeIds.length) return;
  const { error } = await auth.supabase.from("code_agent_changes").update({ reverted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).in("id", changeIds);
  if (error) throw dbError(error, "code.agent.changes.revert");
}

// ---------------------------------------------------------------- checkpoints

type CheckpointRow = { id: string; label: string; files: Record<string, string | null>; created_at: string };

export async function listCheckpoints(auth: Authed, runId: string): Promise<Checkpoint[]> {
  const { data, error } = await auth.supabase.from("code_agent_checkpoints").select("id, label, files, created_at").eq("run_id", runId).order("created_at").limit(100);
  if (error) throw dbError(error, "code.agent.checkpoints");
  return (data as CheckpointRow[]).map((c) => ({ id: c.id, label: c.label, files: c.files, createdAt: c.created_at }));
}

export async function createCheckpoint(auth: Authed, runId: string, label: string, files: Record<string, string | null>): Promise<Checkpoint> {
  const { data, error } = await auth.supabase
    .from("code_agent_checkpoints")
    .insert({ run_id: runId, label: label.slice(0, 200), files })
    .select("id, label, files, created_at")
    .single();
  if (error) throw dbError(error, "code.agent.checkpoints.create");
  const c = data as CheckpointRow;
  return { id: c.id, label: c.label, files: c.files, createdAt: c.created_at };
}
