import "server-only";
import { cancelRun, revertRun, stepRun } from "../code/agent/engine";
import { getRun, toRunView } from "../code/agent/runs";
import { WORKING_STATUSES } from "../code/agent/types";
import { getProjectRow, type Authed } from "../code/server";
import { ApiError } from "../http";
import { cancelReview, createReview, getReview, stepReview } from "../review/server";
import { assertAgentAccess } from "./server";
import { startProfileTask } from "./tasks";
import { clipLog } from "../code/agent/profiles";
import {
  cancel,
  changedBefore,
  childFromReview,
  childFromRun,
  decide,
  expired,
  isTerminal,
  newSteps,
  nextToDrive,
  observe,
  recover,
  regressionTests,
  reviewTaskIds,
  runnable,
  started,
  startFailed,
  tasksToUndo,
  timeOut,
  TEMPLATE_INFO,
  addLog,
  type Decision,
  type Recovery,
  type StepKey,
  type WorkflowInput,
  type WorkflowState,
  type WorkflowStatus,
  type WorkflowStep,
} from "./workflow";

/**
 * Runs workflows: one advance moves one running step's task on (one step of
 * the coding agent, or one part of the review; running steps take turns),
 * records any outcome, and starts the steps that have become ready, as long as
 * they don't edit something another step is editing. The page calls advance
 * while the workflow is running; a step that waits for the user (a plan to
 * approve, a command) is answered in that task's own workspace, and the
 * workflow picks up from there. Every query runs with the user's session, so
 * row-level security applies to the workflow and to each task it starts, and
 * each task is started through its agent's own access checks.
 */

const COLS = "id, project_id, template, title, input, status, current, steps, log, decision, error, locked_until, created_at, updated_at";
/** An advance may run one agent step (up to 270 s); the lock outlasts it. */
const LOCK_MS = 295_000;

export interface WorkflowRow {
  id: string;
  project_id: string;
  template: keyof typeof TEMPLATE_INFO;
  title: string;
  input: { bug: WorkflowInput["bug"]; options: NonNullable<WorkflowInput["options"]> };
  status: WorkflowStatus;
  current: number;
  steps: WorkflowStep[];
  log: WorkflowState["log"];
  decision: { action: Decision; at: string; note?: string } | null;
  error: string | null;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export type WorkflowView = Omit<WorkflowRow, "locked_until" | "input"> & { busy: boolean; summary: string; projectName: string | null };

export function toWorkflowView(r: WorkflowRow, projectName: string | null = null): WorkflowView {
  const { locked_until, input, ...rest } = r;
  return { ...rest, busy: !!locked_until && Date.parse(locked_until) > Date.now(), summary: input.bug.summary, projectName };
}

const stateOf = (r: WorkflowRow): WorkflowState => ({ status: r.status, current: r.current, steps: r.steps, log: r.log, error: r.error });
const nowIso = () => new Date().toISOString();

async function save(auth: Authed, id: string, w: WorkflowState, extra: Record<string, unknown> = {}): Promise<WorkflowRow> {
  const { data, error } = await auth.supabase
    .from("agent_workflows")
    .update({ status: w.status, current: w.current, steps: w.steps, log: w.log, error: w.error, updated_at: nowIso(), ...extra })
    .eq("id", id)
    .select(COLS)
    .single();
  if (error) throw new ApiError("internal", "Couldn't save the workflow.");
  return data as WorkflowRow;
}

/**
 * An advance's save: only while the workflow is still running or waiting, so a Stop that arrived during the
 * advance isn't overwritten. When it was stopped meanwhile, the tasks this advance started are stopped too.
 */
async function saveAdvance(auth: Authed, id: string, w: WorkflowState): Promise<WorkflowRow> {
  const { data, error } = await auth.supabase
    .from("agent_workflows")
    .update({ status: w.status, current: w.current, steps: w.steps, log: w.log, error: w.error, updated_at: nowIso(), locked_until: null })
    .eq("id", id)
    .in("status", ["running", "waiting"])
    .select(COLS)
    .maybeSingle();
  if (error) throw new ApiError("internal", "Couldn't save the workflow.");
  if (data) return data as WorkflowRow;
  await stopTasks(auth, w.steps);
  return getWorkflow(auth, id);
}

/** The database error for a table that doesn't exist yet (the workflows migration hasn't been applied). */
const missingTable = (e: { code?: string; message?: string } | null) => !!e && (e.code === "PGRST205" || e.code === "42P01" || /does not exist|could not find the table/i.test(e.message ?? ""));
const NOT_SET_UP = "Workflows aren't set up on this Orbis deployment yet (their database table hasn't been created).";

/** Whether workflows can run here: their table exists. Anything else unexpected counts as not ready, so nothing is offered that would fail. */
export async function workflowsReady(auth: Authed): Promise<boolean> {
  const { error } = await auth.supabase.from("agent_workflows").select("id", { head: true }).limit(1);
  return !error;
}

export async function getWorkflow(auth: Authed, id: string): Promise<WorkflowRow> {
  const { data, error } = await auth.supabase.from("agent_workflows").select(COLS).eq("id", id).maybeSingle();
  if (missingTable(error)) throw new ApiError("not_configured", NOT_SET_UP);
  if (error) throw new ApiError("internal", "Couldn't load the workflow.");
  if (!data) throw new ApiError("not_found", "Workflow not found.");
  return data as WorkflowRow;
}

export async function listWorkflows(auth: Authed): Promise<WorkflowView[]> {
  const { data, error } = await auth.supabase.from("agent_workflows").select(`${COLS}, project:code_projects(name)`).order("created_at", { ascending: false }).limit(50);
  if (missingTable(error)) throw new ApiError("not_configured", NOT_SET_UP);
  if (error) throw new ApiError("internal", "Couldn't load workflows.");
  return (data as unknown as (WorkflowRow & { project: { name: string } | null })[]).map(({ project, ...r }) => toWorkflowView(r, project?.name ?? null));
}

/** Start a workflow: every agent it will use must be available to this user, and the project must be theirs. */
export async function createWorkflow(auth: Authed, input: WorkflowInput): Promise<WorkflowRow> {
  for (const s of TEMPLATE_INFO[input.template].steps) if (s.agent) await assertAgentAccess(auth, s.agent);
  const project = await getProjectRow(auth, input.projectId);
  const at = nowIso();
  const { data, error } = await auth.supabase
    .from("agent_workflows")
    .insert({
      project_id: project.id,
      template: input.template,
      title: `${TEMPLATE_INFO[input.template].name}: ${input.bug.summary}`.slice(0, 300),
      // Long logs are kept as the agent sees them (start and end), like a Bug Fixing task's own form.
      input: { bug: { ...input.bug, logs: clipLog(input.bug.logs) }, options: input.options ?? {} },
      status: "running",
      current: 0,
      steps: newSteps(input.template),
      log: addLog([], `Started on ${project.name}.`, at),
    })
    .select(COLS)
    .single();
  if (missingTable(error)) throw new ApiError("not_configured", NOT_SET_UP);
  if (error) throw new ApiError("internal", "Couldn't start the workflow.");
  return data as WorkflowRow;
}

async function lock(auth: Authed, id: string): Promise<WorkflowRow | null> {
  const now = nowIso();
  const { data, error } = await auth.supabase
    .from("agent_workflows")
    .update({ locked_until: new Date(Date.now() + LOCK_MS).toISOString() })
    .eq("id", id)
    .in("status", ["running", "waiting"])
    .or(`locked_until.is.null,locked_until.lt.${now}`)
    .select(COLS)
    .maybeSingle();
  if (error) throw new ApiError("internal", "Couldn't take the workflow's next step.");
  return (data as WorkflowRow | null) ?? null;
}

/** Start a ready step's task. */
async function startStep(req: Request, auth: Authed, row: WorkflowRow, w: WorkflowState, key: StepKey): Promise<WorkflowState> {
  const step = w.steps.find((s) => s.key === key)!;
  const at = nowIso();
  const o = row.input.options;
  try {
    if (step.key === "fix") {
      const r = await startProfileTask(
        auth,
        { agent: "bug_fixer", projectId: row.project_id, input: row.input.bug, options: { modelId: o.modelId ?? null, approvePlans: o.approvePlans ?? true, commands: o.commands ?? "safe" } },
        row.id,
      );
      return started(w, key, r.run.id, at);
    }
    if (step.key === "test") {
      const changed = changedBefore(w, key);
      // QA only writes tests (the server refuses other edits), so it runs without a separate plan approval.
      const r = await startProfileTask(
        auth,
        { agent: "qa_tester", projectId: row.project_id, input: regressionTests(row.input.bug, changed), options: { modelId: o.modelId ?? null, approvePlans: false, commands: o.commands ?? "safe" } },
        row.id,
      );
      return started(w, key, r.run.id, at);
    }
    if (step.key === "review") {
      const review = await createReview(req, auth, {
        source: { kind: "changes", projectId: row.project_id, taskIds: reviewTaskIds(w, key) },
        focus: `Changes made to fix: ${row.input.bug.summary}`.slice(0, 2000),
      });
      return started(w, key, review.id, at);
    }
    return w;
  } catch (err) {
    return startFailed(w, key, err instanceof ApiError ? err.message : "Something went wrong starting this step.", at);
  }
}

/** Move a step's task on (one agent step or one review part) and read how it stands. */
async function driveStep(req: Request, auth: Authed, w: WorkflowState, step: WorkflowStep): Promise<WorkflowState> {
  const at = nowIso();
  if (step.kind === "code_run") {
    let run = toRunView(await getRun(auth, step.taskId!));
    if (WORKING_STATUSES.includes(run.status)) run = (await stepRun(req, auth, run.id, { expectStep: run.steps })).run;
    return observe(w, step.key, childFromRun(run), at);
  }
  let review = await getReview(auth, step.taskId!);
  if (review.status === "running") review = await stepReview(req, auth, review.id, null);
  return observe(w, step.key, childFromReview(review), at);
}

/** Start every step that can start now (ready, and not editing what another step is editing). */
async function startReady(req: Request, auth: Authed, row: WorkflowRow, w: WorkflowState): Promise<WorkflowState> {
  for (const s of runnable(w)) w = await startStep(req, auth, row, w, s.key);
  return w;
}

/**
 * One advance. Returns the workflow as it is now; does nothing when another advance holds it, or when it
 * isn't running or waiting (it needs the user's decision, or it ended).
 */
export async function advanceWorkflow(req: Request, auth: Authed, id: string): Promise<WorkflowRow> {
  const row = await lock(auth, id);
  if (!row) return getWorkflow(auth, id);
  let w = stateOf(row);
  try {
    if (expired(row.created_at, Date.now())) {
      await stopTasks(auth, w.steps);
      w = timeOut(w, nowIso()) ?? w;
    } else {
      w = await startReady(req, auth, row, w);
      const step = nextToDrive(w);
      if (step) w = await driveStep(req, auth, w, step);
      // Steps that became ready when another ended start in the same advance.
      w = await startReady(req, auth, row, w);
    }
  } catch (err) {
    // A failure while driving a step (the provider, the computer) leaves the step as it was, to be tried again.
    await saveAdvance(auth, id, w);
    throw err;
  }
  return saveAdvance(auth, id, w);
}

export async function recoverWorkflow(auth: Authed, id: string, action: Recovery, key?: StepKey): Promise<WorkflowRow> {
  const row = await getWorkflow(auth, id);
  const w = recover(stateOf(row), action, nowIso(), key);
  if (!w) throw new ApiError("conflict", action === "retry" ? "This step can't be tried again (it isn't failed, or it has been tried three times)." : "This step can't be skipped.");
  return save(auth, id, w);
}

/**
 * The user's decision at the end. Approving records it (pushing to GitHub stays a separate, confirmed
 * action in Code). Rejecting undoes every change the workflow's tasks made, newest task first.
 */
export async function decideWorkflow(auth: Authed, id: string, action: Decision, note?: string): Promise<WorkflowRow> {
  const row = await getWorkflow(auth, id);
  const at = nowIso();
  const w = decide(stateOf(row), action, at);
  if (!w) throw new ApiError("conflict", "This workflow isn't waiting for your decision.");
  if (action === "reject") {
    const undone: string[] = [];
    for (const s of tasksToUndo(row.steps)) {
      const r = await revertRun(auth, s.taskId);
      if (!r.ok) {
        const before = undone.length ? ` (already undone: ${undone.join("; ")})` : "";
        throw new ApiError("conflict", `Couldn't undo “${s.label}”: ${r.conflicts.join(", ")} changed since the task${before}. Undo those files in Code, then reject again.`);
      }
      if (!undone.includes(s.label)) undone.push(s.label);
    }
  }
  return save(auth, id, w, { decision: { action, at, ...(note ? { note: note.slice(0, 1000) } : {}) } });
}

export async function cancelWorkflow(auth: Authed, id: string): Promise<WorkflowRow> {
  const row = await getWorkflow(auth, id);
  const w = cancel(stateOf(row), nowIso());
  if (!w) throw new ApiError("conflict", "This workflow has already ended.");
  await stopTasks(auth, row.steps);
  return save(auth, id, w, { locked_until: null });
}

/** Stop the tasks of every step still running or waiting (a stop that fails leaves that task to end on its own). */
async function stopTasks(auth: Authed, steps: WorkflowStep[]): Promise<void> {
  for (const step of steps) {
    if (!step.taskId || (step.status !== "running" && step.status !== "waiting")) continue;
    if (step.kind === "code_run") await cancelRun(auth, step.taskId).catch(() => {});
    if (step.kind === "review") await cancelReview(auth, step.taskId).catch(() => {});
  }
}

export { isTerminal };
