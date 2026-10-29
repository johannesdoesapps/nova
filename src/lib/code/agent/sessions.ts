import "server-only";
import { resolveModelChoice } from "@/lib/ai";
import { autoIdFor } from "@/lib/ai/platform";
import { ApiError } from "@/lib/http";
import { planLimits } from "@/lib/usage";
import { getFiles, type Authed } from "../server";
import { compactTranscript, finalize, saveChanges, turnPoint, workingStatus } from "./engine";
import { agentPurpose } from "./profiles";
import { appendStep, appendUser, capTranscript, type TranscriptMessage } from "./protocol";
import {
  addEvents,
  createRun,
  getRun,
  listChanges,
  listCheckpoints,
  lockRun,
  openRun,
  pushMessage,
  runOptions,
  runUsage,
  toRunView,
  updateRun,
  type RunPatch,
  type RunRow,
} from "./runs";
import { planRestore } from "./tools";
import {
  DEFAULT_STEP_LIMIT,
  DEFAULT_TIME_LIMIT_MS,
  DEFAULT_TOKEN_BUDGET,
  ENDED_STATUSES,
  MAX_TIME_LIMIT_MS,
  MAX_TOKEN_BUDGET,
  SESSION_STEP_LIMIT,
  WORKING_STATUSES,
  type RunOptions,
  type RunStatus,
  type RunView,
} from "./types";

/**
 * Sessions that continue: a coding session keeps its conversation across messages, like a terminal agent.
 *
 * - A message sent while the agent works waits in the session's inbox and is given to it at its next step.
 * - A message to a finished session reopens it: the agent carries on with everything it already knows.
 * - Rewind goes back to before one of the user's messages: the conversation is cut there and the files the session
 *   changed since are put back (files someone else changed since are left alone unless the user insists).
 * - Fork starts a new session with a copy of the conversation (up to a message, if given); files aren't copied —
 *   they're the project's.
 * - Compact summarises the conversation to make room; the mode and model can change between messages.
 */

export type SessionOptions = Partial<Pick<RunOptions, "modelId" | "approvePlans" | "reviewEdits" | "commands" | "readOnly">>;

const PERMISSION_KEYS = ["modelId", "approvePlans", "reviewEdits", "commands", "readOnly"] as const;

function mergeOptions(row: Pick<RunRow, "options">, patch: SessionOptions | undefined): RunOptions {
  const o = runOptions(row);
  if (!patch) return o;
  const next: RunOptions = { ...o };
  for (const k of PERMISSION_KEYS) if (patch[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = patch[k];
  // A read-only session never plans, edits or runs commands.
  if (next.readOnly) Object.assign(next, { approvePlans: false, reviewEdits: false, commands: "off" });
  return next;
}

/** Calls the model left without results (a step cut off, or a run that failed mid-step) get them before new messages. */
function closeOpenCalls(t: TranscriptMessage[], why: string): TranscriptMessage[] {
  const tail = t[t.length - 1];
  if (tail?.role !== "assistant" || !tail.calls?.length) return t;
  return appendStep(
    t,
    tail,
    tail.calls.map((c) => ({ id: c.id, tool: c.tool, ok: false, text: why })),
  );
}

/** The conversation as it was at a rewind point: its messages then, and the last one as long as it was. */
export function cutTranscript(t: TranscriptMessage[], point: { transcriptLen?: number; tailChars?: number }): TranscriptMessage[] {
  const out = t.slice(0, point.transcriptLen ?? 0);
  const last = out[out.length - 1];
  if (last?.role === "user" && typeof point.tailChars === "number" && last.content.length > point.tailChars) out[out.length - 1] = { ...last, content: last.content.slice(0, point.tailChars) };
  return out;
}

/** Room for the next message: more steps, tokens and time on top of what the session has used. */
function roomFor(row: RunRow): RunPatch {
  const used = runUsage(row);
  return {
    step_limit: Math.min(SESSION_STEP_LIMIT, row.steps + DEFAULT_STEP_LIMIT),
    token_budget: Math.min(MAX_TOKEN_BUDGET, Math.max(row.token_budget, used.inputTokens + used.outputTokens + DEFAULT_TOKEN_BUDGET)),
    time_limit_ms: Math.min(MAX_TIME_LIMIT_MS, Math.max(Number(row.time_limit_ms), Number(row.active_ms) + DEFAULT_TIME_LIMIT_MS)),
  };
}

export interface MessageOutcome {
  run: RunView;
  /** queued: the agent gets it at its next step; reopened: a finished session carries on with it. */
  delivered: "queued" | "reopened";
}

/** A message from the user to a session: queued while it's open, or reopening it when it has finished. */
export async function sendMessage(auth: Authed, runId: string, text: string, options?: SessionOptions): Promise<MessageOutcome> {
  const row = await getRun(auth, runId);
  if (row.pair) throw new ApiError("bad_request", "Pair sessions take instructions with Add instructions; start a new session for something else.");
  if (!ENDED_STATUSES.includes(row.status)) {
    if (!(await pushMessage(auth, runId, text))) throw new ApiError("conflict", "That message couldn't be queued: the session just ended, or 20 messages are already waiting. Try again in a moment.");
    if (options) await setSessionOptions(auth, runId, options);
    return { run: toRunView(await getRun(auth, runId)), delivered: "queued" };
  }
  return { run: await reopenRun(auth, row, text, options), delivered: "reopened" };
}

/** Carry on a finished session with a new message. */
export async function reopenRun(auth: Authed, row: RunRow, text: string, options?: SessionOptions): Promise<RunView> {
  const open = await openRun(auth, row.project_id);
  if (open && open.id !== row.id) throw new ApiError("conflict", "Another session is working on this project. Stop it or let it finish first.", { runId: open.id });
  const locked = await lockRun(auth, row.id, ENDED_STATUSES);
  if (!locked) throw new ApiError("conflict", "This session is busy (its checks may be running). Try again in a moment.");
  try {
    const next: RunOptions = { ...mergeOptions(locked, options), resumed: true };
    let transcript = closeOpenCalls(locked.transcript ?? [], "Not run: the session ended before this action's result was recorded.");
    // A session rewound to before its first message starts again: the next step builds its first message from this one.
    const fresh = transcript.length === 0;
    if (!fresh) {
      await turnPoint(auth, row.id, transcript, text);
      transcript = appendUser(transcript, `New message from the user (the session continues; the files are as they are now, so re-read any you change):\n${text}`);
    }
    const plan = next.approvePlans && !next.readOnly ? null : locked.plan;
    const status: RunStatus = workingStatus({ options: next, plan });
    await addEvents(auth, row.id, [{ kind: "answer", title: `You said: ${text.replace(/\s+/g, " ").slice(0, 360)}`, detail: { resume: true, text: text.slice(0, 4_000) } }]);
    const updated = await updateRun(auth, row.id, {
      ...roomFor(locked),
      status,
      options: next,
      plan,
      pending: null,
      summary: null,
      error: null,
      recent: [],
      transcript: capTranscript(transcript),
      checks: { ...(locked.checks ?? {}), verify: null },
      tests: locked.tests ? { ...locked.tests, failuresInRow: 0, attemptLimit: Math.max(locked.tests.attemptLimit, 3) } : null,
      locked_until: null,
      ...(fresh ? { request: text.slice(0, 8_000) } : {}),
    });
    return toRunView(updated);
  } catch (err) {
    await updateRun(auth, row.id, { locked_until: null }).catch(() => {});
    throw err;
  }
}

/** Change how the agent may work (and which model) from its next step on. */
export async function setSessionOptions(auth: Authed, runId: string, options: SessionOptions): Promise<RunView> {
  const row = await getRun(auth, runId);
  if (row.pair) throw new ApiError("bad_request", "A pair session's settings can't be changed while it runs.");
  const next = mergeOptions(row, options);
  const patch: RunPatch = { options: next };
  // Leaving "plan first" while planning: the agent may start working at its next step.
  if (row.status === "planning" && !next.approvePlans) patch.status = "running";
  if (row.status === "running" && next.approvePlans && !row.plan?.approved && !next.readOnly) patch.status = "planning";
  return toRunView(await updateRun(auth, runId, patch));
}

export interface RewindPoint {
  id: string;
  message: string;
  createdAt: string;
  /** The conversation can still be cut here (it wasn't summarised since). */
  conversation: boolean;
}

export async function rewindPoints(auth: Authed, runId: string): Promise<RewindPoint[]> {
  const row = await getRun(auth, runId);
  const t = row.transcript ?? [];
  return (await listCheckpoints(auth, runId, "turn")).map((c) => ({ id: c.id, message: c.message ?? c.label, createdAt: c.createdAt, conversation: (c.transcriptLen ?? 0) <= t.length && !compactedSince(row, c.createdAt) }));
}

/** Whether the conversation was summarised after a point (its messages after that point are gone). */
function compactedSince(row: RunRow, at: string): boolean {
  const c = runUsage(row).compactedAt;
  return !!c && Date.parse(c) > Date.parse(at);
}

export interface RewindResult {
  ok: boolean;
  run?: RunView;
  /** Files changed by someone else since; restoring them would lose that work (pass force). */
  conflicts: string[];
  restored: string[];
  /** The message, to put back in the box so it can be edited and sent again. */
  message: string;
}

/** Go back to before one of the user's messages: the conversation is cut there, and the session's files restored. */
export async function rewindRun(auth: Authed, runId: string, pointId: string, opts: { force?: boolean; filesOnly?: boolean } = {}): Promise<RewindResult> {
  // Held for the whole rewind, so no approval or reopen can write the run meanwhile.
  const row = await lockRun(auth, runId, ["awaiting_approval", "needs_input", ...ENDED_STATUSES]);
  if (!row) throw new ApiError("conflict", "Stop the agent (or wait for it to finish) before rewinding.");
  try {
    return await rewindLocked(auth, row, pointId, opts);
  } finally {
    await updateRun(auth, runId, { locked_until: null }).catch(() => {});
  }
}

async function rewindLocked(auth: Authed, row: RunRow, pointId: string, opts: { force?: boolean; filesOnly?: boolean }): Promise<RewindResult> {
  const runId = row.id;
  const point = (await listCheckpoints(auth, runId, "turn")).find((c) => c.id === pointId);
  if (!point) throw new ApiError("not_found", "That point to rewind to wasn't found.");
  const changes = (await listChanges(auth, runId)).map((c) => ({ path: c.path, before: c.before, after: c.revertedAt ? c.before : c.after }));
  const files = await getFiles(auth, row.project_id);
  const plan = planRestore(changes, point.files, files);
  if (plan.conflicts.length && !opts.force) return { ok: false, conflicts: plan.conflicts, restored: [], message: point.message ?? "" };
  let restore = plan.changes;
  if (plan.conflicts.length) {
    const now = new Map(files.map((f) => [f.path, f.content]));
    restore = [
      ...restore,
      ...changes
        .filter((c) => plan.conflicts.includes(c.path))
        .map((c) => ({ path: c.path, before: now.get(c.path) ?? null, after: Object.hasOwn(point.files, c.path) ? point.files[c.path]! : c.before }))
        .filter((c) => c.before !== c.after),
    ];
  }
  if (restore.length) await saveChanges(auth, runId, row.project_id, restore);
  // A session waiting for an answer is stopped by a rewind (what it waited for belongs to the conversation after it).
  const patch: RunPatch = { pending: null, last_edit_at: new Date().toISOString(), ...(ENDED_STATUSES.includes(row.status) ? {} : { status: "cancelled" as RunStatus }) };
  const canCut = !opts.filesOnly && (point.transcriptLen ?? 0) <= (row.transcript ?? []).length && !compactedSince(row, point.createdAt);
  if (canCut) patch.transcript = capTranscript(cutTranscript(row.transcript ?? [], point));
  await addEvents(auth, runId, [
    {
      kind: "revert",
      title: `Rewound to before: ${(point.message ?? point.label).replace(/\s+/g, " ").slice(0, 200)}${restore.length ? ` (${restore.length} file${restore.length === 1 ? "" : "s"} restored)` : ""}${canCut ? "" : " — files only"}`,
      detail: { rewind: point.id, paths: restore.map((c) => c.path), conversation: canCut },
    },
  ]);
  await updateRun(auth, runId, patch);
  const ended = await finalize(auth, runId);
  return { ok: true, run: toRunView(ended ?? (await getRun(auth, runId))), conflicts: plan.conflicts, restored: restore.map((c) => c.path), message: point.message ?? "" };
}

/** A new session with a copy of this one's conversation (up to a rewind point, when given), carrying on with `text`. */
export async function forkRun(auth: Authed, runId: string, text: string, opts: { pointId?: string; options?: SessionOptions } = {}): Promise<RunView> {
  const row = await getRun(auth, runId);
  if (row.pair) throw new ApiError("bad_request", "Pair sessions can't be forked.");
  const open = await openRun(auth, row.project_id);
  if (open) throw new ApiError("conflict", "A session is open on this project. Stop it or let it finish before forking.", { runId: open.id });
  let transcript = row.transcript ?? [];
  if (opts.pointId) {
    const point = (await listCheckpoints(auth, runId, "turn")).find((c) => c.id === opts.pointId);
    if (!point) throw new ApiError("not_found", "That point to fork from wasn't found.");
    transcript = cutTranscript(transcript, point);
  }
  const options = mergeOptions(row, opts.options);
  const fork = await createRun(auth, { projectId: row.project_id, request: text.slice(0, 8_000), options: { ...options, continueFrom: undefined }, stepLimit: DEFAULT_STEP_LIMIT, forkedFrom: row.id });
  if (!transcript.length) return toRunView(fork);
  transcript = closeOpenCalls(transcript, "Not run: the session this one was forked from had stopped before this action's result was recorded.");
  await turnPoint(auth, fork.id, transcript, text);
  transcript = appendUser(transcript, `(This is a fork of an earlier session: everything above happened there. The project's files are as they are now, which may differ; re-read any file before changing it.)\nNew message from the user:\n${text}`);
  await addEvents(auth, fork.id, [{ kind: "status", title: `Forked from an earlier session`, detail: { forkedFrom: row.id } }]);
  const plan = options.approvePlans && !options.readOnly ? null : row.plan;
  return toRunView(await updateRun(auth, fork.id, { transcript: capTranscript(transcript), plan, status: workingStatus({ options, plan }) }));
}

/** /compact: summarise the session's conversation now (with what to keep in particular, if given). */
export async function compactRun(req: Request, auth: Authed, runId: string, focus: string | null): Promise<RunView> {
  const row = await getRun(auth, runId);
  if ((row.transcript ?? []).length < 3) throw new ApiError("bad_request", "There's nothing to compact yet.");
  const all: RunStatus[] = ["planning", "awaiting_approval", "running", "needs_input", "completed", "failed", "cancelled"];
  const locked = await lockRun(auth, runId, all);
  if (!locked) throw new ApiError("conflict", "The agent is in the middle of a step. Try again when it's done.");
  try {
    const limits = await planLimits(auth);
    const choice = await resolveModelChoice(runOptions(locked).modelId ?? autoIdFor("coding"), { prompt: locked.request, mode: "coding", tiers: limits.tiers });
    if (choice.model.provider === "demo") throw new ApiError("not_configured", "No AI model is set up on this site.");
    await compactTranscript(req, auth, locked, locked.transcript ?? [], choice.model, agentPurpose(runOptions(locked).agent), runUsage(locked), focus);
    await addEvents(auth, runId, [{ kind: "status", title: `Summarised the conversation to make room${focus ? ` (keeping: ${focus.slice(0, 160)})` : ""}`, detail: { compact: "manual" } }]);
    return toRunView(await updateRun(auth, runId, { locked_until: null }));
  } catch (err) {
    await updateRun(auth, runId, { locked_until: null }).catch(() => {});
    throw err;
  }
}
