import "server-only";
import { cancelRun, revertRun, stepRun } from "../code/agent/engine";
import { getRun, toRunView } from "../code/agent/runs";
import { WORKING_STATUSES } from "../code/agent/types";
import { getProjectRow, type Authed } from "../code/server";
import { ApiError } from "../http";
import { cancelReview, createReview, getReview, stepReview } from "../review/server";
import { assertAgentAccess } from "./server";
import { startProfileTask } from "./tasks";
import {
  cancel,
  childFromReview,
  childFromRun,
  decide,
  expired,
  isTerminal,
  newSteps,
  observe,
  recover,
  regressionTests,
  reviewTaskIds,
  started,
  startFailed,
  TEMPLATE_INFO,
  addLog,
  type Decision,
  type Recovery,
  type WorkflowInput,
  type WorkflowState,
  type WorkflowStatus,
  type WorkflowStep,
} from "./workflow";

/**
 * Runs workflows: one advance looks at the current step's task, moves it on
 * (one step of the coding agent, or one part of the review) and, when it has
 * ended, records the outcome and starts the next step. The page calls advance
 * while the workflow is running; a step that waits for the user (a plan to
 * approve, a command) is answered in that task's own workspace, and the
 * workflow picks up from there. Every query runs with the user's session, so
 * row-level security applies to the workflow and to each task it starts.
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

export async function getWorkflow(auth: Authed, id: string): Promise<WorkflowRow> {
  const { data, error } = await auth.supabase.from("agent_workflows").select(COLS).eq("id", id).maybeSingle();
  if (error) throw new ApiError("internal", "Couldn't load the workflow.");
  if (!data) throw new ApiError("not_found", "Workflow not found.");
  return data as WorkflowRow;
}

export async function listWorkflows(auth: Authed): Promise<WorkflowView[]> {
  const { data, error } = await auth.supabase.from("agent_workflows").select(`${COLS}, project:code_projects(name)`).order("created_at", { ascending: false }).limit(50);
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
      input: { bug: input.bug, options: input.options ?? {} },
      status: "running",
      current: 0,
      steps: newSteps(input.template),
      log: addLog([], `Started on ${project.name}.`, at),
    })
    .select(COLS)
    .single();
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

/** Start the current step's task. */
async function startStep(req: Request, auth: Authed, row: WorkflowRow, w: WorkflowState): Promise<WorkflowState> {
  const step = w.steps[w.current]!;
  const at = nowIso();
  const o = row.input.options;
  try {
    if (step.key === "fix") {
      const r = await startProfileTask(
        auth,
        { agent: "bug_fixer", projectId: row.project_id, input: row.input.bug, options: { modelId: o.modelId ?? null, approvePlans: o.approvePlans ?? true, commands: o.commands ?? "safe" } },
        row.id,
      );
      return started(w, r.run.id, at);
    }
    if (step.key === "test") {
      const fix = w.steps.find((s) => s.key === "fix")!;
      const fixRun = await getRun(auth, fix.taskId!);
      const changed = fixRun.report?.files.map((f) => f.path) ?? [];
      // QA only writes tests (the server refuses other edits), so it runs without a separate plan approval.
      const r = await startProfileTask(
        auth,
        { agent: "qa_tester", projectId: row.project_id, input: regressionTests(row.input.bug, changed), options: { modelId: o.modelId ?? null, approvePlans: false, commands: o.commands ?? "safe" } },
        row.id,
      );
      return started(w, r.run.id, at);
    }
    if (step.key === "review") {
      const review = await createReview(req, auth, {
        source: { kind: "changes", projectId: row.project_id, taskIds: reviewTaskIds(w) },
        focus: `Changes made to fix: ${row.input.bug.summary}`.slice(0, 2000),
      });
      return started(w, review.id, at);
    }
    return w;
  } catch (err) {
    return startFailed(w, err instanceof ApiError ? err.message : "Something went wrong starting this step.", at);
  }
}

/** Move the current step's task on (one agent step or one review part) and read how it stands. */
async function driveStep(req: Request, auth: Authed, w: WorkflowState): Promise<WorkflowState> {
  const step = w.steps[w.current]!;
  const at = nowIso();
  if (step.kind === "code_run") {
    let run = toRunView(await getRun(auth, step.taskId!));
    if (WORKING_STATUSES.includes(run.status)) run = (await stepRun(req, auth, run.id, { expectStep: run.steps })).run;
    return observe(w, childFromRun(run), at);
  }
  let review = await getReview(auth, step.taskId!);
  if (review.status === "running") review = await stepReview(req, auth, review.id, null);
  return observe(w, childFromReview(review), at);
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
      w = { ...w, status: "failed", error: "The workflow ran for more than 24 hours and was stopped.", log: addLog(w.log, "Stopped: it ran for more than 24 hours.", nowIso()) };
    } else {
      const step = w.steps[w.current];
      if (step && step.kind !== "approval") {
        if (step.status === "pending") w = await startStep(req, auth, row, w);
        else w = await driveStep(req, auth, w);
        // A step that ended moves straight on: start the next one in the same advance.
        const next = w.steps[w.current];
        if (w.status === "running" && next && next.status === "pending" && next.kind !== "approval") w = await startStep(req, auth, row, w);
      }
    }
  } catch (err) {
    // A failure while driving a step (the provider, the computer) leaves the step as it was, to be tried again.
    await save(auth, id, w, { locked_until: null });
    throw err;
  }
  return save(auth, id, w, { locked_until: null });
}

export async function recoverWorkflow(auth: Authed, id: string, action: Recovery): Promise<WorkflowRow> {
  const row = await getWorkflow(auth, id);
  const w = recover(stateOf(row), action, nowIso());
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
    const runs = row.steps.filter((s) => s.kind === "code_run" && s.taskId).reverse();
    const undone: string[] = [];
    for (const s of runs) {
      const r = await revertRun(auth, s.taskId!);
      if (!r.ok) {
        const before = undone.length ? ` (already undone: ${undone.join("; ")})` : "";
        throw new ApiError("conflict", `Couldn't undo “${s.label}”: ${r.conflicts.join(", ")} changed since the task${before}. Undo those files in Code, then reject again.`);
      }
      undone.push(s.label);
    }
  }
  return save(auth, id, w, { decision: { action, at, ...(note ? { note: note.slice(0, 1000) } : {}) } });
}

export async function cancelWorkflow(auth: Authed, id: string): Promise<WorkflowRow> {
  const row = await getWorkflow(auth, id);
  const w = cancel(stateOf(row), nowIso());
  if (!w) throw new ApiError("conflict", "This workflow has already ended.");
  const step = row.steps[row.current];
  if (step?.taskId && (step.status === "running" || step.status === "waiting")) {
    if (step.kind === "code_run") await cancelRun(auth, step.taskId).catch(() => {});
    if (step.kind === "review") await cancelReview(auth, step.taskId).catch(() => {});
  }
  return save(auth, id, w, { locked_until: null });
}

export { isTerminal };
