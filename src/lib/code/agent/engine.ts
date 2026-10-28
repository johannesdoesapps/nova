import "server-only";
import { readLink } from "../../links/read";
import { emitLive, hasWatchers } from "./live";
import { runHelpers } from "./subagent";
import { searchBackend, searchWeb } from "../../search/live";
import { createHash } from "node:crypto";
import { getProvider, resolveModelChoice, withTimeout } from "@/lib/ai";
import { estimateCost } from "@/lib/ai/cost";
import { autoIdFor } from "@/lib/ai/platform";
import type { ModelInfo, Usage } from "@/lib/ai/types";
import { getConnection, runTool, usable } from "@/lib/connectors/runtime";
import { connector } from "@/lib/connectors/registry";
import { ApiError } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { enforceLimits, planLimits, recordRunLater, releaseUsage } from "@/lib/usage";
import type { FileChange, ProjectFile, ProjectSummary } from "../projects";
import { summarizeCheck } from "../preview-check";
import { checksSummary } from "./verdict";
import { taskTitle } from "./history";
import { pairRespond, pairStep } from "../pair/engine";
import { describeStart, PREVIEW_START_MS, runPreviewCheck, startPreview } from "../preview";
import { applyFileChanges, getFiles, getProjectRow, optionalBox, setRunCommand, syncBack, type Authed } from "../server";
import { claimSync, killJob, readJob, removeFromWorkspace, startJob, writeToWorkspace, type WorkspaceBox } from "../workspace";
import {
  appendStep,
  appendUser,
  capTranscript,
  clipText,
  initialMessage,
  isWebTask,
  latestShots,
  messageSize,
  parseAgentReply,
  systemPrompt,
  toJsonChat,
  toToolMessages,
  trimTranscript,
  type AgentReply,
  type TranscriptMessage,
} from "./protocol";
import { classifyCommand } from "./policy";
import { BULK_DELETE, commandOp, fileWriteOp } from "../../bastion/guards";
import { shouldContain } from "../../bastion/policy";
import { notifyOwner } from "../../bastion/customer/notify";
import { projectAllowed } from "../../bastion/customer/policy";
import { agentSuspended, guard as bastionGuard, refusalsInRun, workspacePolicy, type GuardContext } from "../../bastion/server";
import { agentPurpose, profileGuidance, profileReport, qaMayEdit } from "./profiles";
import { isSiteTemplateId, siteTemplateGuidance } from "../site-templates";
import { buildReport } from "./report";
import {
  addEvents,
  createCheckpoint,
  getRun,
  listChanges,
  listCheckpoints,
  listEvents,
  listRuns,
  lockRun,
  openRun,
  markReverted,
  recordChanges,
  runChecks,
  runOptions,
  runStatus,
  runUsage,
  toRunView,
  updateRun,
  type NewEvent,
  type RunPatch,
  type RunRow,
  updateRunIfNotCancelled,
} from "./runs";
import { detectTestCommand, isTestCommand, testResult, type TestResult } from "./test-results";
import { planVerification } from "./verify";
import { attachmentsBlock } from "./protocol";
import { toolSchemas, type ToolContext } from "./tool-specs";
import { memoryBlock, searchMemory, selectMemory, type MemoryEntry } from "../memory";
import { addMemory, listMemory } from "../memory-store";
import { runAttachments } from "../attachments-store";
import { commandEvent, commandResultText, describeChange, planRestore, runActions, type AgentEnv, type CommandOutcome } from "./tools";
import {
  DEFAULT_TEST_ATTEMPTS,
  ENDED_STATUSES,
  MAX_STEP_LIMIT,
  MAX_TIME_LIMIT_MS,
  MAX_TOKEN_BUDGET,
  STEP_LIMIT_INCREMENT,
  WORKING_STATUSES,
  type Decision,
  type LimitReason,
  type RunChecks,
  type RunStatus,
  type RunTests,
  type RunUsage,
  type RunView,
  type RunningJob,
  type AgentEvent,
  type FailureKind,
  type RunReport,
  type SkippedCheck,
  type VerifyState,
  type VerifyStep,
} from "./types";

/**
 * The coding agent's engine. A run advances one step at a time; each step is
 * one model turn, metered like a chat message, followed by the actions the
 * model asked for, which the server validates and carries out. A run that
 * needs the user stops with what it's waiting for; their answer (POST
 * …/respond) puts it back to work. Only one step runs at a time per run (a
 * lock in the row), and a step request carries the step number it expects,
 * so a retried request never repeats a step.
 *
 * Bounds: a step limit, a token budget, a working-time limit, a limit on
 * failed test runs in a row, and a stop when the model repeats the same
 * actions. Each pauses the run and asks the user whether to go on.
 */

/** How long a step waits for a command; one still running then keeps going in the background (see LONG_COMMAND_MS). */
export const COMMAND_LIMIT_MS = 120_000;
/** How long a command may run in all, across steps (the agent waits for it with wait_for_command), before it's stopped. */
export const LONG_COMMAND_MS = 10 * 60_000;
const MODEL_TIMEOUT_MS = 170_000;
/**
 * Output tokens the agent may use per step (or the plan's reply limit when
 * that's higher). A step's reply carries whole files, so it needs far more
 * room than a chat answer; spending still counts against the plan's
 * allowance like any other model call.
 */
export const AGENT_OUTPUT_TOKENS = 16_000;
/** One request keeps taking steps while it has been working for less than this. */
const MULTI_STEP_MS = 45_000;
/**
 * The step route stops after 300 s (maxDuration). A request plans to finish
 * its steps within this budget, leaving time to save; a step that would run
 * past it gets a shorter model timeout, or isn't started.
 */
export const STEP_BUDGET_MS = 270_000;
/** Time a step needs after its model call: one command (or a browser check), plus saving. */
const AFTER_MODEL_MS = COMMAND_LIMIT_MS + 15_000;
/** The least time worth giving a model call; with less left, the step waits for the next request. */
const MIN_MODEL_MS = 45_000;

/** How long the model may take this step, so the whole step ends before the route's limit. */
export function modelTimeoutFor(deadline: number, now = Date.now()): number {
  return Math.max(0, Math.min(MODEL_TIMEOUT_MS, deadline - now - AFTER_MODEL_MS));
}
const POLL_MS = 1_500;
const MAX_OUTPUT_KEPT = 200_000;
const TOKEN_BUDGET_INCREMENT = 300_000;
const TIME_LIMIT_INCREMENT = 15 * 60_000;
const TEST_ATTEMPT_INCREMENT = 2;
/** Model calls that fail in a row (busy, timed out, unreachable) before the run stops. */
export const MAX_MODEL_FAILURES = 3;
/** Identical steps in a row before the run stops to ask. */
const REPEAT_LIMIT = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Back to work after a pause: planning until the plan is approved (when approval is on), else running. */
export function workingStatus(row: Pick<RunRow, "options" | "plan">): RunStatus {
  return runOptions(row).approvePlans && !row.plan?.approved ? "planning" : "running";
}

/** Providers whose API takes tools natively; the others answer in the JSON format. */
export function usesNativeTools(model: Pick<ModelInfo, "provider">): boolean {
  return (model.provider === "anthropic" || model.provider === "openai") && typeof getProvider(model.provider).toolTurn === "function";
}

/** Add one model call's usage to the run's totals (cost stays null once any call can't be priced). */
export function addUsage(total: RunUsage, model: ModelInfo, usage: Usage, promptChars: number, replyChars: number): RunUsage {
  const input = usage.inputTokens ?? Math.ceil(promptChars / 4);
  const output = usage.outputTokens ?? Math.ceil(replyChars / 4);
  const cost = estimateCost(model, { ...usage, inputTokens: input, outputTokens: output });
  return {
    inputTokens: total.inputTokens + input,
    outputTokens: total.outputTokens + output,
    costUsd: total.costUsd === null || cost === null ? null : Math.round((total.costUsd + cost) * 1e6) / 1e6,
    modelCalls: total.modelCalls + 1,
    models: total.models.includes(model.displayName) ? total.models : [...total.models, model.displayName].slice(-6),
    estimated: total.estimated || usage.inputTokens === null || usage.outputTokens === null || usage.estimated,
  };
}

/** Record test runs in the run's test state: the latest result and failures in a row. */
export function addTests(prev: RunTests | null, results: TestResult[]): RunTests {
  const t: RunTests = prev ?? { last: null, failuresInRow: 0, attemptLimit: DEFAULT_TEST_ATTEMPTS, runs: 0 };
  let { last, failuresInRow, runs } = t;
  for (const r of results) {
    last = r;
    runs++;
    failuresInRow = r.verdict === "passed" ? 0 : failuresInRow + 1;
  }
  return { ...t, last, failuresInRow, runs };
}

/** A step's actions as one short comparable string (ids left out): a hash, so big file contents never end up in the stored list. */
export function actionSignature(reply: Pick<AgentReply, "actions">): string {
  return createHash("sha256")
    .update(JSON.stringify(reply.actions.map((a) => [a.tool, a.args])))
    .digest("base64url")
    .slice(0, 22);
}

/** Add a step's website checks to the run's. */
export function addChecks(prev: RunChecks, step: Partial<RunChecks>): RunChecks {
  return { ...prev, server: step.server ?? prev.server, preview: step.preview ?? prev.preview, build: step.build ?? prev.build };
}

// ---------------------------------------------------------------- the real environment

interface EnvContext {
  auth: Authed;
  run: RunRow;
  /** When this request must be done (the browser check and preview start fit their time to it). */
  deadline?: number;
  project: ProjectSummary;
  docs: boolean;
  github: boolean;
  webSearches: { count: number };
}

async function mirror(box: WorkspaceBox | null, changes: FileChange[]) {
  if (!box) return;
  try {
    await removeFromWorkspace(
      box,
      changes.filter((c) => c.after === null).map((c) => c.path),
    );
    await writeToWorkspace(
      box,
      changes.filter((c): c is FileChange & { after: string } => c.after !== null).map((c) => ({ path: c.path, content: c.after })),
    );
  } catch (err) {
    reportError(err, { where: "code.agent.mirror" });
  }
}

/** Which agent a run is, for Orbis Bastion (suspensions and decisions are per agent). */
export function codeAgentId(row: Pick<RunRow, "options">): string {
  const o = runOptions(row);
  return o.agent ?? (o.web ? "website_builder" : "engineer");
}

/** Why the workspace's policy keeps this coding agent out of this project, or null when it may work there. */
export async function projectBoundary(auth: Authed, agent: string, projectId: string): Promise<string | null> {
  const ws = await workspacePolicy(auth.supabase, auth.user.id);
  if (ws === "unavailable") return "your workspace's security policy couldn't be read, so agents are paused (fail closed). Try again in a moment.";
  return projectAllowed(ws, agent, projectId) ? null : `your workspace's policy keeps the ${agent.replace("_", " ")} agent to other projects (Bastion → Policies).`;
}

/** An agent's action checked by Orbis Bastion where it's carried out. `approved`: the user approved exactly this action. */
export interface Gate {
  agent: string;
  approved?: boolean;
}
const gateCtx = (auth: Authed, runId: string, agent: string): GuardContext => ({ db: auth.supabase, userId: auth.user.id, kind: "agent", agent, runId });

/**
 * Save changes to the project, copy them to the running computer, and record them for the run. With a gate (an
 * agent's changes), each change passes Orbis Bastion first; refused ones aren't saved and are returned.
 */
export async function saveChanges(auth: Authed, runId: string, projectId: string, changes: FileChange[], gate: Gate | null = null): Promise<{ path: string; reason: string }[]> {
  const refused: { path: string; reason: string }[] = [];
  if (gate) {
    const ok: FileChange[] = [];
    const deletes = changes.filter((c) => c.after === null).length;
    for (const c of changes) {
      const op = c.after === null && deletes > BULK_DELETE ? "file.delete.bulk" : fileWriteOp(c.path, c.after, c.before);
      const d = await bastionGuard(gateCtx(auth, runId, gate.agent), op, c.path, { approved: gate.approved });
      if (d.outcome === "allow") ok.push(c);
      else refused.push({ path: c.path, reason: d.reason });
    }
    changes = ok;
  }
  if (!changes.length) return refused;
  await applyFileChanges(
    auth,
    projectId,
    changes.map((c) => ({ path: c.path, content: c.after })),
  );
  await recordChanges(auth, runId, changes);
  await mirror(await optionalBox(auth, projectId), changes);
  return refused;
}

/** Which files a run's commands may change; the rest are put back (QA Testing may only change tests). */
export function commandKeeps(row: Pick<RunRow, "options">): ((path: string) => boolean) | undefined {
  return runOptions(row).agent === "qa_tester" ? qaMayEdit : undefined;
}

export interface ExecOptions {
  /** Keep a command that's still running after the wait going in the background (up to LONG_COMMAND_MS in all), instead of stopping it. */
  background?: { tool: RunningJob["tool"] };
  /** Wait for a command this run left running (no new command is started). */
  resume?: RunningJob;
  /** When the request must be done: a command that can keep going in the background isn't waited for past it. */
  deadline?: number;
}

/** Time kept after waiting for a command, to copy its files back and record the step. */
const AFTER_COMMAND_MS = 20_000;

/**
 * Run a command in the project's computer, wait for it (up to COMMAND_LIMIT_MS this step), and copy back the files it
 * changed. With `background`, a command still running then is left running and remembered on the run (`running` in
 * the outcome); `resume` waits for it again later. Past LONG_COMMAND_MS in all it's stopped.
 */
export async function execCommand(auth: Authed, runId: string, projectId: string, command: string, keep: ((path: string) => boolean) | undefined, gate: Gate, opts: ExecOptions = {}): Promise<CommandOutcome> {
  const resume = opts.resume;
  // Every command an agent runs passes Orbis Bastion here, however it got here (a step, an approval, pair coding, verification).
  // A command being waited for again passed it when it started.
  if (!resume) {
    const d = await bastionGuard(gateCtx(auth, runId, gate.agent), commandOp(command), command, { approved: gate.approved });
    if (d.outcome !== "allow") return { exitCode: null, output: "", durationMs: 0, timedOut: false, cancelled: false, changed: [], skipped: [], blocked: d.reason };
  }
  const box = await optionalBox(auth, projectId);
  if (!box) throw new ApiError("conflict", "The project's computer isn't running.", { scope: "workspace_stopped" });
  const before = await getFiles(auth, projectId);
  const jobId = resume?.jobId ?? `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const started = resume?.startedAt ?? Date.now();
  const canContinue = !!(opts.background || resume);
  // A command that can keep going in the background is waited for only while the request has time left (the rest of
  // the step still has to be recorded); otherwise up to COMMAND_LIMIT_MS.
  const waitUntil = Math.min(Date.now() + COMMAND_LIMIT_MS, canContinue && opts.deadline ? opts.deadline - AFTER_COMMAND_MS : Infinity);
  const limit = canContinue ? LONG_COMMAND_MS : COMMAND_LIMIT_MS;
  // What the run was waiting for before (an approval, say), put back if the command can't be started.
  const prevPending = resume ? null : (await getRun(auth, runId)).pending;
  await updateRun(auth, runId, { pending: { kind: "job", jobId, command } });
  if (!resume) {
    try {
      await startJob(box, jobId, command);
    } catch (err) {
      await updateRun(auth, runId, { pending: prevPending ?? null }).catch(() => {});
      throw err;
    }
  }

  let output = "";
  let offset = resume?.offset ?? 0;
  let exitCode: number | null = null;
  let done = false;
  let cancelled = false;
  let startedAt = started;
  let polls = 0;
  let more = false;
  while (Date.now() < waitUntil && Date.now() - started < limit) {
    if (!more) await sleep(POLL_MS);
    const r = await readJob(box, jobId, offset);
    // A finished command's remaining output is read straight away.
    more = r.done && r.output.length > 0;
    output += r.output;
    if (output.length > MAX_OUTPUT_KEPT) output = output.slice(-MAX_OUTPUT_KEPT);
    offset = r.offset;
    if (r.startedAt) startedAt = r.startedAt;
    if (r.done && !r.output) {
      done = true;
      exitCode = r.exitCode;
      break;
    }
    if (++polls % 2 === 0 && (await runStatus(auth, runId)) === "cancelled") {
      cancelled = true;
      break;
    }
  }
  // A command that finished while nobody was waiting (e.g. resumed after its time) is read once before deciding.
  if (!done && !cancelled) {
    const r = await readJob(box, jobId, offset).catch(() => null);
    if (r?.done) {
      output += r.output;
      if (output.length > MAX_OUTPUT_KEPT) output = output.slice(-MAX_OUTPUT_KEPT);
      offset = r.offset;
      exitCode = r.exitCode;
      done = true;
    }
  }
  if (!done && !cancelled && canContinue && Date.now() - started < limit - 5_000) {
    // Still running: leave it going, and remember it so a later step can wait for it (and Stop can end it).
    const tool = resume?.tool ?? opts.background?.tool ?? "run_command";
    await updateRun(auth, runId, { job: { jobId, command, tool, startedAt: started, offset } });
    return { exitCode: null, output, durationMs: Date.now() - started, timedOut: false, cancelled: false, changed: [], skipped: [], running: true };
  }
  // It's over (finished, stopped, or out of time): forget it as a running command.
  if (resume) await updateRun(auth, runId, { job: null });
  const timedOut = !done && !cancelled;
  if (!done) {
    await killJob(box, jobId).catch(() => {});
    const r = await readJob(box, jobId, offset).catch(() => null);
    if (r) {
      output += r.output;
      exitCode = r.exitCode;
    }
  }

  let changed: FileChange[] = [];
  let skipped: string[] = [];
  if (await claimSync(box, jobId).catch(() => false)) {
    try {
      const sync = await syncBack(auth, projectId, box, startedAt, jobId);
      skipped = sync.skipped;
      const after = new Map((await getFiles(auth, projectId)).map((f) => [f.path, f.content]));
      const prior = new Map(before.map((f) => [f.path, f.content]));
      changed = [...sync.changed, ...sync.deleted].map((path) => ({ path, before: prior.get(path) ?? null, after: after.get(path) ?? null })).filter((c) => c.before !== c.after);
      await recordChanges(auth, runId, changed);
      const refused = keep ? changed.filter((c) => !keep(c.path)) : [];
      if (refused.length) {
        await saveChanges(auth, runId, projectId, refused.map((c) => ({ path: c.path, before: c.after, after: c.before })));
        changed = changed.filter((c) => keep!(c.path));
        skipped = [...skipped, ...refused.map((c) => `${c.path} (put back: this agent may only change test files)`)];
      }
    } catch (err) {
      reportError(err, { where: "code.agent.sync" });
      skipped = ["(files changed by this command couldn't be copied back)"];
    }
  }
  return { exitCode, output, durationMs: Date.now() - started, timedOut, cancelled, changed, skipped };
}

/** Whether the model is shown attached images: it must take images and be called with native tools (the JSON format is text only). */
function seesImages(model: Pick<ModelInfo, "provider" | "capabilities">): boolean {
  return model.capabilities.includes("vision") && usesNativeTools(model);
}

/** The run's attached images, for models that can see them (loaded each step: they go with the first message). */
async function attachedImages(auth: Authed, runId: string, count: number, model: Pick<ModelInfo, "provider" | "capabilities">): Promise<{ mediaType: "image/jpeg" | "image/png"; data: string }[]> {
  if (!count || !seesImages(model)) return [];
  return (await runAttachments(auth, runId, true)).filter((a) => a.kind === "image").map((a) => ({ mediaType: a.mediaType as "image/jpeg" | "image/png", data: a.content }));
}

/** The activity log says what the agent was given — and plainly when it can't see the images. */
function attachmentEvents(atts: { name: string; kind: "text" | "image" }[], canSee: boolean, modelName: string): NewEvent[] {
  const texts = atts.filter((a) => a.kind === "text").map((a) => a.name);
  const images = atts.filter((a) => a.kind === "image").map((a) => a.name);
  const out: NewEvent[] = [];
  if (texts.length) out.push({ kind: "inspect", title: `Given ${texts.length} attached file${texts.length === 1 ? "" : "s"}: ${texts.join(", ").slice(0, 280)}`, detail: { attachments: texts } });
  if (images.length)
    out.push(
      canSee
        ? { kind: "inspect", title: `Shown ${images.length} attached image${images.length === 1 ? "" : "s"}: ${images.join(", ").slice(0, 280)}`, detail: { attachments: images } }
        : { kind: "error", title: `${modelName} can't view images, so ${images.length === 1 ? "the attached image wasn't" : `the ${images.length} attached images weren't`} looked at. Choose a model that can see images to use them.`, detail: { attachments: images } },
    );
  return out;
}

function realEnv(c: EnvContext): AgentEnv {
  const { auth, run, project } = c;
  const agent = codeAgentId(run);
  const env: AgentEnv = {
    files: () => getFiles(auth, project.id),
    save: (changes) => saveChanges(auth, run.id, project.id, changes, { agent }),
    computer: async () => Boolean(await optionalBox(auth, project.id)),
    exec: (command, approved, tool) => execCommand(auth, run.id, project.id, command, commandKeeps(run), { agent, approved }, tool ? { background: { tool }, deadline: c.deadline } : {}),
    waitCommand: async () => {
      const job = run.job;
      if (!job) return null;
      // The computer stopped (time ran out, or Stop computer): the command went with it. Forget it, so it doesn't block
      // new commands, and say so.
      if (!(await optionalBox(auth, project.id))) {
        await updateRun(auth, run.id, { job: null, pending: null });
        return { command: job.command, tool: job.tool, out: { exitCode: null, output: "The project's computer stopped before this command finished, so it was lost. Start the computer again and rerun it if it's still needed.", durationMs: Date.now() - job.startedAt, timedOut: false, cancelled: true, changed: [], skipped: [] } };
      }
      return { command: job.command, tool: job.tool, out: await execCommand(auth, run.id, project.id, job.command, commandKeeps(run), { agent, approved: true }, { resume: job, deadline: c.deadline }) };
    },
    guard: (op, resource, approved) => bastionGuard(gateCtx(auth, run.id, agent), op, resource, { approved }),
    changes: async () => (await listChanges(auth, run.id)).map((ch) => ({ path: ch.path, before: ch.before, after: ch.after })),
    checkpoints: { list: () => listCheckpoints(auth, run.id), create: (label, files) => createCheckpoint(auth, run.id, label, files) },
    project: { runCommand: project.runCommand },
    emit: (events) => addEvents(auth, run.id, events),
    cancelled: async () => (await runStatus(auth, run.id)) === "cancelled",
    preview: {
      start: async (command) => {
        const box = await optionalBox(auth, project.id);
        if (!box) throw new ApiError("conflict", "The project's computer isn't running.", { scope: "workspace_stopped" });
        const left = (c.deadline ?? Date.now() + STEP_BUDGET_MS) - Date.now() - 10_000;
        const s = await startPreview(box, command, { signal: async () => (await runStatus(auth, run.id)) === "cancelled", timeoutMs: Math.max(10_000, Math.min(PREVIEW_START_MS, left)) });
        return { state: s.state, http: s.http, exitCode: s.exitCode, text: describeStart(s, command) };
      },
      check: async (path) => {
        const box = await optionalBox(auth, project.id);
        if (!box) throw new ApiError("conflict", "The project's computer isn't running.", { scope: "workspace_stopped" });
        const check = summarizeCheck(await runPreviewCheck(box, path, undefined, undefined, { budgetMs: (c.deadline ?? Date.now() + STEP_BUDGET_MS) - Date.now() - 10_000 }));
        const shots = await addEvents(
          auth,
          run.id,
          check.shots.map((x) => ({ kind: "inspect" as const, title: `Screenshot: ${x.caption}`, detail: { screenshot: x.data, view: x.name, path } })),
        );
        return { check, shots };
      },
      setRunCommand: (command) => setRunCommand(auth, project.id, command),
    },
  };
  if (runOptions(c.run).attachments) {
    env.attachments = {
      read: async (name) => {
        const a = (await runAttachments(auth, run.id, true)).find((x) => x.name === name || x.name.split("/").pop() === name);
        return a ? { kind: a.kind, content: a.content } : null;
      },
    };
  }
  env.memory = {
    search: async (query) => searchMemory(await listMemory(auth, project.id), query),
    propose: (note) => addMemory(auth, project.id, { ...note, status: "proposed", source: "agent", runId: run.id }),
  };
  if (c.docs) {
    env.lookupDocs = async (query) => {
      c.webSearches.count++;
      const r = await searchWeb(query, { auth, signal: withTimeout(30_000), purpose: "code_docs" });
      return r.sources.slice(0, 6).map((s) => ({ title: s.title, url: s.url, snippet: s.snippet }));
    };
  }
  env.readPage = async (url) => {
    const r = await readLink(url, withTimeout(20_000));
    return r.ok ? { ok: true, url: r.finalUrl, title: r.title ?? null, text: r.text } : { ok: false, reason: r.reason };
  };
  if (c.github) {
    env.github = async (tool, args) => {
      const r = await runTool(auth, tool, args, { actor: { kind: "agent", agent: codeAgentId(run), runId: run.id } });
      if (!r.ok || !r.result) return { ok: false, text: r.error ?? "GitHub couldn't complete that.", summary: "" };
      const items = r.result.items.map((i) => `- ${i.title}${i.url ? ` (${i.url})` : ""}${i.snippet ? `: ${i.snippet}` : ""}`).join("\n");
      return { ok: true, text: clipText(r.result.text ?? items ?? "", 30_000) || "(nothing found)", summary: r.result.summary };
    };
  }
  return env;
}

async function githubUsable(auth: Authed): Promise<boolean> {
  const gh = connector("github");
  if (!gh) return false;
  try {
    return usable(gh, await getConnection(auth, "github"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the report

/** Build and store the run's final report from its records (best effort: a failure is logged, not shown). */
async function finalize(auth: Authed, runId: string, unresolved: string[] = [], skipped: SkippedCheck[] = [], failure?: FailureKind): Promise<RunRow | null> {
  try {
    const row = await getRun(auth, runId);
    // The run is over: a command it left running in the background is ended.
    if (row.job) await endRunningJob(auth, row);
    const [changes, files, events, checkpoints] = await Promise.all([listChanges(auth, runId), getFiles(auth, row.project_id), listEvents(auth, runId), listCheckpoints(auth, runId)]);
    const report = buildReport({
      status: row.status,
      summary: row.summary,
      unresolved: unresolved.length ? unresolved : (row.report?.unresolved ?? []),
      changes,
      current: new Map(files.map((f) => [f.path, f.content])),
      events,
      tests: row.tests,
      checks: runChecks(row),
      lastEditAt: row.last_edit_at,
      usage: runUsage(row),
      steps: row.steps,
      activeMs: Number(row.active_ms),
      checkpoints: checkpoints.length,
      testSetup: detectTestCommand(files),
      web: !!runOptions(row).web,
      skipped,
    });
    report.timing = runTiming(row, events);
    if (failure) report.failure = failure;
    const profile = runOptions(row).agent;
    if (profile) report.profile = profileReport(profile, events, report.files);
    logRunEnd(row, report);
    return await updateRun(auth, runId, { report });
  } catch (err) {
    reportError(err, { where: "code.agent.report" });
    return null;
  }
}

/** Real timings from the run's records: created → now, created → first progress, and the last verification's duration. */
export function runTiming(row: Pick<RunRow, "created_at">, events: Pick<AgentEvent, "kind" | "title" | "detail" | "createdAt">[], now = Date.now()): NonNullable<RunReport["timing"]> {
  const created = Date.parse(row.created_at);
  const progress = events.find((e) => e.kind !== "status" && e.kind !== "error");
  const verify = [...events].reverse().find((e) => typeof e.detail?.verifyMs === "number");
  return {
    totalMs: Number.isFinite(created) ? Math.max(0, now - created) : 0,
    firstProgressMs: progress && Number.isFinite(created) ? Math.max(0, Date.parse(progress.createdAt) - created) : null,
    verifyMs: verify ? (verify.detail!.verifyMs as number) : null,
  };
}

/** One structured line per ended run, for the logs: outcome and timings only — never the request, code or output. */
function logRunEnd(row: Pick<RunRow, "id" | "status" | "steps" | "active_ms">, report: RunReport) {
  console.info(
    JSON.stringify({
      event: "agent_run_end",
      runId: row.id,
      status: row.status,
      state: report.state ?? null,
      failure: report.failure ?? null,
      steps: row.steps,
      activeMs: Number(row.active_ms),
      ...report.timing,
      retries: report.usage.retries ?? 0,
      modelCalls: report.usage.modelCalls,
      costUsd: report.usage.costUsd,
    }),
  );
}

// ---------------------------------------------------------------- steps

export interface StepResult {
  run: RunView;
  /** Why no step ran: busy elsewhere, the run is waiting or finished, or the step asked for already ran. */
  skipped?: "busy" | "not_working" | "stale";
}

/** Finish a step: save the run unless the user stopped it meanwhile, and write the report when it ended. */
export async function finishStep(auth: Authed, runId: string, patch: RunPatch, unresolved: string[] = [], skipped: SkippedCheck[] = [], failure?: FailureKind): Promise<RunRow> {
  let row = await updateRunIfNotCancelled(auth, runId, { ...patch, locked_until: null });
  if (!row) {
    // The user's stop stands: the step's records are kept, its status, waiting state and summary aren't.
    const kept: RunPatch = { ...patch };
    delete kept.status;
    delete kept.summary;
    row = await updateRun(auth, runId, { ...kept, locked_until: null, pending: null });
  }
  if (ENDED_STATUSES.includes(row.status)) return (await finalize(auth, runId, unresolved, skipped, row.status === "failed" ? (failure ?? "internal") : undefined)) ?? row;
  return row;
}

export const pauseFor = (reason: LimitReason, steps: number, detail: string): RunPatch => ({ status: "needs_input", pending: { kind: "limit", steps, reason, detail } });

const FORMAT_RETRY = "FORMAT PROBLEM:";

/**
 * Take the run's next step, and keep going while it's working and the request
 * is young. `expectStep` is the step count the caller last saw: when the run
 * has moved on since (a retried request), nothing runs.
 */
export async function stepRun(req: Request, auth: Authed, runId: string, opts: { expectStep?: number; now?: () => number; keepGoingMs?: number } = {}): Promise<StepResult> {
  const clock = opts.now ?? Date.now;
  const started = clock();
  const deadline = started + STEP_BUDGET_MS;
  let latest: RunView | null = null;
  for (let n = 0; ; n++) {
    // Another step only when it can finish inside this request's time (the route is stopped at 300 s).
    if (n > 0 && modelTimeoutFor(deadline, clock()) < MIN_MODEL_MS) return { run: latest! };
    const row = await lockRun(auth, runId, WORKING_STATUSES);
    if (!row) {
      const now = toRunView(await getRun(auth, runId));
      if (n > 0) return { run: now };
      return { run: now, skipped: WORKING_STATUSES.includes(now.status) ? "busy" : "not_working" };
    }
    if (n === 0 && opts.expectStep !== undefined && row.steps !== opts.expectStep) {
      const released = await updateRun(auth, runId, { locked_until: null });
      return { run: toRunView(released), skipped: "stale" };
    }
    try {
      latest = toRunView(await step(req, auth, row, deadline, clock));
    } catch (err) {
      await updateRun(auth, runId, { locked_until: null }).catch(() => {});
      // The first step's failure goes back to the caller; a later one has been logged, so report where the run is.
      if (n === 0) throw err;
      return { run: toRunView(await getRun(auth, runId)) };
    }
    // The page asks again for more; the background worker keeps going for longer (keepGoingMs), within the deadline.
    if (!WORKING_STATUSES.includes(latest.status) || clock() - started > (opts.keepGoingMs ?? MULTI_STEP_MS)) return { run: latest };
  }
}

async function step(req: Request, auth: Authed, row: RunRow, deadline = Date.now() + STEP_BUDGET_MS, clock: () => number = Date.now): Promise<RunRow> {
  // Orbis Bastion: a suspended agent stops at its next step, whatever it was doing.
  const suspended = await agentSuspended(codeAgentId(row), { db: auth.supabase, ownerId: auth.user.id });
  if (suspended?.kind === "unavailable") throw new ApiError("provider_unavailable", suspended.message);
  // A workspace boundary (Bastion → Policies) may keep this agent to other projects; checked at every step.
  const boundary = await projectBoundary(auth, codeAgentId(row), row.project_id);
  if (boundary) {
    await addEvents(auth, row.id, [{ kind: "status", title: `Stopped by Orbis Bastion: ${boundary}`, detail: { bastion: true } }]);
    return finishStep(auth, row.id, { status: "failed", error: `Stopped by Orbis Bastion: ${boundary}`, pending: null }, [], [], "blocked_by_policy");
  }
  if (suspended) {
    await addEvents(auth, row.id, [{ kind: "status", title: `Stopped by Orbis Bastion: ${suspended.message}`, detail: { bastion: true } }]);
    return finishStep(auth, row.id, { status: "failed", error: `Stopped by Orbis Bastion: ${suspended.message}`, pending: null }, [], [], "blocked_by_policy");
  }
  // Pair coding: two agents take turns (pair/engine.ts).
  if (runOptions(row).pair) return pairStep(req, auth, row, deadline, clock);
  // The agent has finished: Orbis runs the checks itself, one per step, before the run may end.
  if (runChecks(row).verify) return verifyStep(auth, row, deadline);
  const stepStarted = Date.now();
  const opts = runOptions(row);
  const project = await getProjectRow(auth, row.project_id);
  let usage = runUsage(row);

  // Limits are checked before spending anything on the next turn.
  if (row.steps >= row.step_limit) {
    await addEvents(auth, row.id, [{ kind: "status", title: `Paused after ${row.steps} steps` }]);
    return finishStep(auth, row.id, pauseFor("steps", row.steps, `The run has taken ${row.steps} steps.`));
  }
  if (usage.inputTokens + usage.outputTokens >= row.token_budget) {
    await addEvents(auth, row.id, [{ kind: "status", title: `Paused: used its token budget (${row.token_budget.toLocaleString("en-US")} tokens)` }]);
    return finishStep(
      auth,
      row.id,
      pauseFor("tokens", row.steps, `The run has used ${(usage.inputTokens + usage.outputTokens).toLocaleString("en-US")} tokens of its ${row.token_budget.toLocaleString("en-US")}.`),
    );
  }
  if (Number(row.active_ms) >= Number(row.time_limit_ms)) {
    await addEvents(auth, row.id, [{ kind: "status", title: `Paused after ${Math.round(Number(row.active_ms) / 60_000)} minutes of work` }]);
    return finishStep(auth, row.id, pauseFor("time", row.steps, `The agent has worked for ${Math.round(Number(row.active_ms) / 60_000)} minutes.`));
  }

  const limits = await planLimits(auth);
  const attached = opts.attachments ?? { texts: 0, images: 0 };
  // With images attached, Auto picks a model that can see them.
  const choice = await resolveModelChoice(opts.modelId ?? autoIdFor("coding"), { prompt: row.request, mode: "coding", tiers: limits.tiers, ...(attached.images ? { needs: ["vision" as const] } : {}) });
  const model = choice.model;
  if (model.provider === "demo") {
    const message = "No AI model is set up on this site, so the agent can't run.";
    await addEvents(auth, row.id, [{ kind: "error", title: message }]);
    return finishStep(auth, row.id, { status: "failed", error: message, pending: null }, [], [], "no_model");
  }

  const docs = searchBackend() !== null && limits.webSearchesLeft !== 0;
  const github = await githubUsable(auth);
  let transcript: TranscriptMessage[] = row.transcript ?? [];
  if (!transcript.length) {
    const files = await getFiles(auth, project.id);
    const computer = Boolean(await optionalBox(auth, project.id));
    const record = (r: Pick<RunView, "request" | "status" | "summary" | "report">) => ({
      request: r.request,
      status: r.status,
      summary: r.report?.summary ?? r.summary,
      files: (r.report?.files ?? []).map((f) => f.path),
      checks: r.report && r.status === "completed" ? checksSummary(r.report) : null,
    });
    // The finished task this one continues (chosen in History), read again here: it must still exist, be the user's and be in this project.
    const continueFrom = opts.continueFrom
      ? await getRun(auth, opts.continueFrom)
          .then((r) => (r.project_id === project.id && ENDED_STATUSES.includes(r.status) ? r : null))
          .catch(() => null)
      : null;
    // Earlier finished runs in this project, so a follow-up ("make it blue") needn't explain the whole site again.
    const earlier = (await listRuns(auth, project.id, 8).catch(() => []))
      .filter((r) => r.id !== row.id && r.id !== continueFrom?.id && ENDED_STATUSES.includes(r.status))
      .slice(0, 3)
      .map(record);
    // What the user attached: text in the first message, images shown with it when the model can see them.
    const atts = attached.texts + attached.images ? await runAttachments(auth, row.id, true) : [];
    const canSee = seesImages(model);
    // Project memory: approved notes that fit this request (instructions and "always" notes every time).
    const notes = await listMemory(auth, project.id).catch(() => [] as MemoryEntry[]);
    const active = notes.filter((n) => n.status === "active");
    const used = selectMemory(active, row.request);
    transcript = [
      {
        role: "user",
        content: initialMessage(row.request, files, {
          projectName: project.name,
          runCommand: project.runCommand,
          computer,
          earlier,
          memory: memoryBlock(used, active.length),
          attachments: attachmentsBlock(atts, canSee),
          ...(opts.continueFrom ? { continuing: continueFrom ? record(continueFrom) : null } : {}),
        }),
      },
    ];
    await addEvents(auth, row.id, [
      { kind: "status", title: `Started with ${model.displayName}`, detail: { model: model.displayName, routing: choice.routing?.reason ?? null } },
      ...(opts.continueFrom
        ? [
            continueFrom
              ? { kind: "inspect" as const, title: `Continues an earlier task: ${taskTitle(continueFrom.request).slice(0, 300)}`, detail: { continueFrom: continueFrom.id } }
              : { kind: "note" as const, title: "The task this was meant to continue no longer exists, so the agent works from the project's files as they are." },
          ]
        : []),
      ...attachmentEvents(atts, canSee, model.displayName),
      ...(used.length
        ? [{ kind: "inspect" as const, title: `Using ${used.length} note${used.length === 1 ? "" : "s"} from project memory: ${used.map((n) => n.title).join(", ").slice(0, 300)}`, detail: { memory: used.map((n) => ({ id: n.id, kind: n.kind, title: n.title })) } }]
        : []),
    ]);
    // Kept now, so a retry after a failed first model call doesn't start (and log) the run again.
    await updateRun(auth, row.id, { transcript });
  }

  // A step that was cut off after the model asked for actions (a crash or timeout) left its calls without
  // results. They may or may not have run, so the model is told to check rather than repeat them.
  const tail = transcript[transcript.length - 1];
  if (tail?.role === "assistant" && tail.calls?.length) {
    transcript = appendStep(
      transcript,
      tail,
      tail.calls.map((c) => ({
        id: c.id,
        tool: c.tool,
        ok: false,
        text: "Interrupted: the previous step stopped before this action's result was recorded. It may or may not have run. Check the current state (git_status, read_files) before doing it again.",
      })),
    );
    await addEvents(auth, row.id, [{ kind: "status", title: "Recovered from an interrupted step; the agent will check what already happened" }]);
  }

  const readOnly = !!opts.readOnly;
  const planApproved = !readOnly && (!opts.approvePlans || !!row.plan?.approved);
  const native = usesNativeTools(model);
  const ctx: ToolContext = { commands: readOnly ? "off" : opts.commands, docs, github, approvePlans: opts.approvePlans, readOnly, memory: true, attachments: attached.texts + attached.images > 0, pages: true, helpers: native };
  const maxOutputTokens = Math.max(limits.maxOutputTokens, AGENT_OUTPUT_TOKENS);
  const replyChars = maxOutputTokens * 3;
  const web = opts.web ?? isWebTask(row.request, [], project.template);
  const system = `${systemPrompt({ ...ctx, planning: !readOnly && !planApproved, reviewEdits: opts.reviewEdits, native, web, replyChars })}
- Keep each reply under about ${replyChars.toLocaleString("en-US")} characters. A file that wouldn't fit: split it into several files, or write the first part and add the rest with edit_file in the next step.${opts.agent ? `\n\n${profileGuidance(opts.agent, ctx)}` : ""}${web && !readOnly && isSiteTemplateId(opts.siteTemplate) ? `\n\n${siteTemplateGuidance(opts.siteTemplate)}` : ""}`;
  const history = trimTranscript(transcript, Math.max(24_000, limits.historyChars));
  const promptChars = system.length + history.reduce((n, m) => n + messageSize(m), 0);
  const purpose = agentPurpose(opts.agent);
  await enforceLimits(req, auth, 1, [model], { purpose, inputTokens: Math.ceil(promptChars / 3.5) + 200, maxOutputTokens });

  // The model call isn't tied to the browser's request: a closed tab doesn't cut a step off half way.
  const started = performance.now();
  emitLive(row.id, { t: "step", step: row.steps + 1 });
  let reply: AgentReply;
  let raw = "";
  let callUsage: Usage;
  let servedModel: string | null = null;
  let stop: "tool_use" | "end_turn" | "max_tokens" | "refusal" | "other" | "json" = "json";
  try {
    if (native) {
      const r = await getProvider(model.provider).toolTurn!({ model, system, messages: toToolMessages(history, await screenshots(auth, row.id, history), await attachedImages(auth, row.id, attached.images, model)), tools: toolSchemas(ctx), maxOutputTokens, signal: withTimeout(modelTimeoutFor(deadline, clock())), ...(hasWatchers(row.id) ? { onText: (d: string) => emitLive(row.id, { t: "text", d }) } : {}) });
      reply = { thought: clipText(r.text, 6_000), actions: r.calls.slice(0, 8).map((c) => ({ id: c.id, tool: c.name, args: c.args })) };
      raw = `${r.text}\n${JSON.stringify(r.calls)}`;
      callUsage = r.usage;
      servedModel = r.servedModel;
      stop = r.stop;
    } else {
      const r = await getProvider(model.provider).generate({
        model,
        messages: [{ role: "system", content: system }, ...toJsonChat(history)],
        maxOutputTokens,
        temperature: 0.2,
        signal: withTimeout(modelTimeoutFor(deadline, clock())),
      });
      raw = r.text;
      callUsage = r.usage;
      servedModel = r.servedModel ?? null;
      const parsed = parseAgentReply(r.text);
      reply = parsed.ok ? { ...parsed.data, actions: parsed.data.actions.map((a, i) => ({ ...a, id: `s${row.steps}a${i}` })) } : { thought: "", actions: [] };
      if (!parsed.ok) {
        usage = { ...addUsage(usage, model, callUsage, promptChars, raw.length), modelFailuresInRow: 0 };
        return formatProblem(auth, row, transcript, raw, parsed.error, usage, stepStarted);
      }
    }
  } catch (err) {
    emitLive(row.id, { t: "model_done" });
    await releaseUsage(auth);
    reportError(err, { where: "code.agent.model" });
    // Provider messages from ApiError are already safe to show; anything else gets a generic one.
    const reason = err instanceof ApiError ? err.message : `${model.displayName} didn't answer.`;
    const failures = (usage.modelFailuresInRow ?? 0) + 1;
    usage = { ...usage, retries: (usage.retries ?? 0) + 1 };
    // A rejected request (or a missing key) fails the same way every time; a busy or unreachable provider may recover.
    const permanent = err instanceof ApiError && (err.code === "bad_request" || err.code === "not_configured");
    if (permanent || failures >= MAX_MODEL_FAILURES) {
      const message = permanent ? `${reason} The run stopped; try another model.` : `${model.displayName} failed ${failures} times in a row (${reason}), so the run stopped. Try again later or with another model.`;
      await addEvents(auth, row.id, [{ kind: "error", title: message.slice(0, 380) }]);
      const kind: FailureKind = !permanent ? "provider_unavailable" : (err as ApiError).code === "not_configured" ? "provider_not_configured" : "provider_rejected";
      return finishStep(auth, row.id, { status: "failed", error: message.slice(0, 2000), pending: null, usage: { ...usage, modelFailuresInRow: failures } }, [], [], kind);
    }
    await updateRun(auth, row.id, { usage: { ...usage, modelFailuresInRow: failures } });
    await addEvents(auth, row.id, [{ kind: "error", title: `${reason} This step wasn't counted; it can be retried.`.slice(0, 380) }]);
    throw new ApiError("upstream_error", `${reason} This step wasn't counted. Press Continue to try again.`);
  }
  const latencyMs = performance.now() - started;
  emitLive(row.id, { t: "model_done" });
  usage = { ...addUsage(usage, model, callUsage, promptChars, raw.length), modelFailuresInRow: 0 };
  const webSearches = { count: 0 };
  const record = (tools: string[]) =>
    recordRunLater(auth, {
      model,
      prompt: `[code agent] ${row.request.slice(0, 400)}`,
      response: raw.slice(0, 2000),
      latencyMs,
      usage: callUsage,
      status: "success",
      purpose,
      category: "coding",
      servedModel,
      requestedModel: opts.modelId ?? "auto:coding",
      routingReason: choice.routing?.reason ?? "Chosen by the user.",
      tools,
    });

  if (stop === "refusal") {
    record([]);
    const message = `${model.displayName} declined this request, so the run stopped. Try rephrasing it, or another model.`;
    await addEvents(auth, row.id, [{ kind: "error", title: message }]);
    return finishStep(auth, row.id, { status: "failed", error: message, pending: null, usage, steps: row.steps + 1, active_ms: Number(row.active_ms) + (Date.now() - stepStarted) }, [], [], "refused");
  }

  const assistant: TranscriptMessage = { role: "assistant", content: reply.thought, ...(reply.actions.length ? { calls: reply.actions.map((a) => ({ id: a.id!, tool: a.tool, args: a.args })) } : {}) };
  const base = { steps: row.steps + 1, usage, active_ms: Number(row.active_ms) + (Date.now() - stepStarted) };

  // The reply was cut off at the output limit: none of its actions are trusted.
  if (stop === "max_tokens") {
    record([]);
    const results = reply.actions.map((a) => ({ id: a.id, tool: a.tool, ok: false, text: "Not run: your reply was cut off at the output limit." }));
    const next = assistant.calls ? appendStep(transcript, assistant, results) : [...transcript, assistant];
    const t = appendUser(
      next,
      `Your reply was cut off at the output limit (${maxOutputTokens.toLocaleString("en-US")} tokens, about ${(maxOutputTokens * 3).toLocaleString("en-US")} characters), so none of it ran. Do less per reply: one or two files at a time, styles and scripts in their own files, and a long file split up or built with edit_file over several steps.`,
    );
    await addEvents(auth, row.id, [{ kind: "note", title: "The AI's reply was cut off at the output limit; asking it to work in smaller parts." }]);
    return finishStep(auth, row.id, { ...base, transcript: capTranscript(t) });
  }

  // Stopped while the model was thinking: nothing it asked for is carried out.
  if ((await runStatus(auth, row.id)) === "cancelled") {
    record([]);
    const results = reply.actions.map((a) => ({ id: a.id, tool: a.tool, ok: false, text: "Not run: the user stopped the run." }));
    const t = assistant.calls ? appendStep(transcript, assistant, results) : appendUser([...transcript, assistant], "The user stopped the run. Nothing was done.");
    return finishStep(auth, row.id, { ...base, transcript: capTranscript(t) });
  }

  // The same actions three steps running: the agent is going round in circles.
  const signature = actionSignature(reply);
  const recent = [...(row.recent ?? []), signature].slice(-6);
  if (reply.actions.length && recent.length >= REPEAT_LIMIT && recent.slice(-REPEAT_LIMIT).every((s) => s === signature)) {
    record([]);
    const results = reply.actions.map((a) => ({
      id: a.id,
      tool: a.tool,
      ok: false,
      text: "Not run: this is the same set of actions as your last two steps. Try a different approach, or finish and explain what's blocking you.",
    }));
    await addEvents(auth, row.id, [{ kind: "status", title: "Paused: the agent repeated the same actions three times" }]);
    return finishStep(auth, row.id, {
      ...base,
      recent,
      transcript: capTranscript(appendStep(transcript, assistant, results)),
      ...pauseFor("repeat", row.steps + 1, "The agent asked for the same actions three steps in a row."),
    });
  }

  // Keep the request for actions before carrying them out, so an interrupted step can be recovered.
  const withAssistant = [...transcript, assistant];
  await updateRun(auth, row.id, { transcript: capTranscript(withAssistant), usage, recent });

  const env = realEnv({ auth, run: row, project, docs, github, webSearches, deadline });
  // Helper agents (delegate): read-only, with the run's model; each call is metered and recorded like the agent's own,
  // and its tokens count toward the run's budget.
  const helperUsage: Usage[] = [];
  if (native) {
    const readOnlyEnv: AgentEnv = { ...env, emit: undefined };
    env.delegate = (questions) =>
      runHelpers(questions, {
        env: readOnlyEnv,
        deadline: Math.min(deadline - 20_000, Date.now() + 120_000),
        turn: async (p) => {
          const promptChars = p.system.length + JSON.stringify(p.messages).length;
          await enforceLimits(req, auth, 1, [model], { purpose, inputTokens: Math.ceil(promptChars / 3.5) + 200, maxOutputTokens: p.maxOutputTokens });
          const t0 = performance.now();
          try {
            const r = await getProvider(model.provider).toolTurn!({ ...p, model });
            helperUsage.push(r.usage);
            recordRunLater(auth, {
              model,
              prompt: `[code helper] ${row.request.slice(0, 300)}`,
              response: r.text.slice(0, 1000),
              latencyMs: performance.now() - t0,
              usage: r.usage,
              status: "success",
              purpose,
              category: "coding",
              servedModel: r.servedModel,
              requestedModel: opts.modelId ?? "auto:coding",
              routingReason: "Helper agent for the coding agent's delegate tool.",
              tools: r.calls.map((c) => c.name),
            });
            return r;
          } catch (err) {
            await releaseUsage(auth);
            throw err;
          }
        },
      });
  }
  if (reply.thought) await addEvents(auth, row.id, [{ kind: "note", title: clipText(reply.thought, 380) }]);
  const outcome = await runActions(
    reply,
    { planApproved, approvePlans: opts.approvePlans, reviewEdits: opts.reviewEdits, commands: ctx.commands, lastTests: row.tests?.last ?? null, readOnly, testsOnly: opts.agent === "qa_tester", runningCommand: row.job?.command ?? null },
    env,
  );
  record(webSearches.count ? ["web_search"] : []);
  for (const u of helperUsage) usage = addUsage(usage, model, u, 0, 0);

  const tests = outcome.tests.length ? addTests(row.tests, outcome.tests) : row.tests;
  const checks = Object.keys(outcome.checks).length ? addChecks(runChecks(row), outcome.checks) : null;
  const plan = outcome.plan ? outcome.plan : row.plan;
  const patch: RunPatch = {
    ...base,
    usage,
    active_ms: Number(row.active_ms) + (Date.now() - stepStarted),
    recent,
    tests,
    ...(checks ? { checks } : {}),
    transcript: capTranscript(reply.actions.length ? appendStep(withAssistant, assistant, outcome.results) : withAssistant),
    plan,
    pending: null,
    status: workingStatus({ options: row.options, plan }),
    ...(outcome.edited ? { last_edit_at: outcome.editedAt ?? new Date().toISOString() } : {}),
  };
  if (outcome.pause) {
    patch.status = outcome.pause.status;
    patch.pending = outcome.pause.pending;
  } else if (outcome.tests.length && tests && tests.failuresInRow >= tests.attemptLimit) {
    await addEvents(auth, row.id, [{ kind: "status", title: `Paused: tests failed ${tests.failuresInRow} times in a row` }]);
    Object.assign(patch, pauseFor("tests", row.steps + 1, `The tests failed ${tests.failuresInRow} times in a row.`));
    patch.transcript = capTranscript(appendUser(patch.transcript!, `The tests have failed ${tests.failuresInRow} times in a row. The user has been asked whether you should keep trying.`));
  }
  if (!reply.actions.length) {
    // A reply with no actions: nudge once; it ends the run if it happens again.
    const nudged = (row.transcript ?? []).slice(-1)[0]?.content.includes("You took no actions");
    patch.transcript = capTranscript(appendUser(patch.transcript!, "You took no actions. Continue the work with the tools, or call finish if you're done."));
    if (nudged) {
      patch.status = "completed";
      patch.summary = reply.thought || "The agent stopped without a summary.";
      await addEvents(auth, row.id, [{ kind: "summary", title: "Finished", detail: { summary: patch.summary } }]);
    }
  }
  if (outcome.summary) patch.summary = outcome.summary;
  // Orbis Bastion: repeated refusals in one run stop it (one harmless refusal doesn't).
  if (outcome.denied) {
    const refusals = await refusalsInRun(auth.supabase, auth.user.id, row.id, row.created_at).catch(() => 0);
    if (shouldContain(refusals)) {
      await addEvents(auth, row.id, [{ kind: "status", title: `Stopped by Orbis Bastion after ${refusals} refused actions`, detail: { bastion: true } }]);
      await notifyOwner(auth.supabase, auth.user.id, "repeatedBlocks", `contain:${row.id}`, "Orbis Bastion stopped a coding task", `A ${codeAgentId(row).replace("_", " ")} task was stopped after ${refusals} actions that policy doesn't allow. Look at its activity before starting it again.`).catch(() => {});
      return finishStep(auth, row.id, { ...patch, status: "failed", pending: null, error: `Stopped by Orbis Bastion: the agent tried ${refusals} actions that policy doesn't allow. Review the activity log before starting again.` }, outcome.unresolved, [], "blocked_by_policy");
    }
  }
  if (patch.status === "completed") return beginVerification(auth, row, patch, env, outcome.unresolved);
  return finishStep(auth, row.id, patch, outcome.unresolved);
}

// ---------------------------------------------------------------- verification

/** Tries at one check (an interrupted step counts) before it's reported as not finished. */
const VERIFY_ATTEMPTS = 2;

/**
 * The agent says it's done. Work out which checks apply and haven't run since
 * its last change; with any to run, the run stays working in the verifying
 * phase (checks.verify) and the next steps run them. Otherwise it ends now,
 * and the report says which checks didn't run and why.
 */
async function beginVerification(auth: Authed, row: RunRow, patch: RunPatch, env: AgentEnv, unresolved: string[]): Promise<RunRow> {
  const checks = runChecks({ checks: patch.checks ?? row.checks });
  const [files, changes, computer] = await Promise.all([env.files(), listChanges(auth, row.id), env.computer()]);
  const now = new Map(files.map((f) => [f.path, f.content]));
  const plan = planVerification({
    options: runOptions(row),
    files,
    tests: patch.tests ?? row.tests,
    checks,
    lastEditAt: patch.last_edit_at ?? row.last_edit_at,
    changedFiles: changes.filter((c) => (now.get(c.path) ?? null) !== c.before).length,
    computer,
  });
  if (!plan.queue.length) return finishStep(auth, row.id, patch, unresolved, plan.skipped);
  const verify: VerifyState = { summary: patch.summary ?? row.summary ?? "", unresolved, queue: plan.queue, attempts: 0, skipped: plan.skipped, startedAt: new Date().toISOString() };
  await addEvents(auth, row.id, [{ kind: "status", title: `Verifying: Orbis is running ${describeQueue(plan.queue)} before calling this done`, detail: { verify: plan.queue } }]);
  return finishStep(auth, row.id, { ...patch, status: "running", summary: patch.summary ?? row.summary, checks: { ...checks, verify } }, unresolved);
}

const describeQueue = (q: VerifyStep[]) => q.map((v) => (v.check === "tests" ? `the tests (${v.command})` : "a browser inspection of the page")).join(" and ");

/** Run the next check in the verifying phase through the same tool code the agent uses, and record what happened. */
async function verifyStep(auth: Authed, row: RunRow, deadline: number): Promise<RunRow> {
  const checks0 = runChecks(row);
  const v = checks0.verify!;
  const head = v.queue[0];
  const next = (skipped: SkippedCheck[]): VerifyState => ({ ...v, queue: v.queue.slice(1), attempts: 0, skipped });
  const proceed = (patch: RunPatch, state: VerifyState): Promise<RunRow> =>
    state.queue.length
      ? finishStep(auth, row.id, { ...patch, pending: null, status: "running", checks: { ...checks0, ...patch.checks, verify: state } })
      : finishVerification(auth, row, patch, state);
  if (!head) return proceed({}, v);
  if (v.attempts >= VERIFY_ATTEMPTS) {
    const label = head.check === "tests" ? "The tests" : "The browser inspection";
    await addEvents(auth, row.id, [{ kind: "error", title: `${label} didn't finish after ${VERIFY_ATTEMPTS} tries` }]);
    return proceed({}, next([...v.skipped, { check: head.check, reason: `Not finished: the check was interrupted ${VERIFY_ATTEMPTS} times without a result.` }]));
  }
  // Count the try before starting, so a step that dies mid-check still counts it.
  await updateRun(auth, row.id, { checks: { ...checks0, verify: { ...v, attempts: v.attempts + 1 } } });
  const project = await getProjectRow(auth, row.project_id);
  const env = realEnv({ auth, run: row, project, docs: false, github: false, webSearches: { count: 0 }, deadline });
  const reply: AgentReply = {
    thought: "",
    actions: [head.check === "tests" ? { id: "verify-tests", tool: "run_tests", args: { command: head.command } } : { id: "verify-browser", tool: "check_preview", args: { path: head.path } }],
  };
  const outcome = await runActions(reply, { planApproved: true, approvePlans: false, reviewEdits: false, commands: "safe", approvedCommand: head.check === "tests" ? head.command : null, lastTests: row.tests?.last ?? null }, env);
  if (outcome.pause?.status === "cancelled") return finishStep(auth, row.id, { status: "cancelled", pending: null });

  let skipped = v.skipped;
  const ran = head.check === "tests" ? outcome.tests.length > 0 : !!outcome.checks.preview;
  if (!ran) {
    const why =
      outcome.pause?.pending?.kind === "computer"
        ? "Not run: the project's computer had stopped."
        : outcome.pause
          ? "Not run: it needed your approval."
          : `Not run: ${clipText(outcome.results[0]?.text ?? "the check couldn't start.", 200)}`;
    skipped = [...skipped, { check: head.check, reason: why }];
    await addEvents(auth, row.id, [{ kind: "status", title: `Verification: ${head.check === "tests" ? "the tests" : "the browser inspection"} couldn't run`, detail: { reason: why } }]);
  }
  const tests = outcome.tests.length ? addTests(row.tests, outcome.tests) : row.tests;
  const checks = { ...addChecks(checks0, outcome.checks), verify: null };
  return proceed({ tests, checks, ...(outcome.edited ? { last_edit_at: outcome.editedAt ?? new Date().toISOString() } : {}) }, next(skipped));
}

async function finishVerification(auth: Authed, row: RunRow, patch: RunPatch, v: VerifyState): Promise<RunRow> {
  await addEvents(auth, row.id, [{ kind: "status", title: v.rerun ? "Checks re-run" : "Verification finished", detail: { verifyMs: Math.max(0, Date.now() - Date.parse(v.startedAt)) } }]);
  return finishStep(auth, row.id, { ...patch, status: "completed", pending: null, summary: v.summary || row.summary, checks: { ...runChecks(row), ...patch.checks, verify: null } }, v.unresolved, v.skipped);
}

/**
 * "Re-run checks" on a finished run: every check that applies runs again
 * (the click is the approval), then the report is rebuilt from the results.
 */
export async function reverifyRun(auth: Authed, runId: string): Promise<RunView> {
  const row = await getRun(auth, runId);
  if (row.status !== "completed") throw new ApiError("conflict", "Checks can be re-run once the agent has finished.");
  const open = await openRun(auth, row.project_id);
  if (open && open.id !== row.id) throw new ApiError("conflict", "Another session is working on this project. Wait for it to finish first.", { runId: open.id });
  const [files, changes, box] = await Promise.all([getFiles(auth, row.project_id), listChanges(auth, runId), optionalBox(auth, row.project_id)]);
  const checks = runChecks(row);
  const now = new Map(files.map((f) => [f.path, f.content]));
  const plan = planVerification({
    options: runOptions(row),
    files,
    tests: row.tests,
    checks,
    lastEditAt: row.last_edit_at,
    changedFiles: changes.filter((c) => (now.get(c.path) ?? null) !== c.before).length,
    computer: !!box,
    rerun: true,
  });
  if (!plan.queue.length) {
    throw new ApiError("conflict", plan.skipped[0]?.reason.replace(/^Not run: /, "") ?? "There's nothing Orbis can check here: the project has no tests and isn't a website.");
  }
  const verify: VerifyState = { summary: row.summary ?? "", unresolved: row.report?.unresolved ?? [], queue: plan.queue, attempts: 0, skipped: plan.skipped, startedAt: new Date().toISOString(), rerun: true };
  await addEvents(auth, runId, [{ kind: "status", title: `You asked Orbis to re-run the checks: ${describeQueue(plan.queue)}` }]);
  return toRunView(await updateRun(auth, runId, { status: "running", pending: null, locked_until: null, checks: { ...checks, verify } }));
}

/** The screenshots the model is shown with its latest results (loaded from the activity log). */
async function screenshots(auth: Authed, runId: string, history: TranscriptMessage[]): Promise<Map<number, string>> {
  const want = latestShots(history);
  const out = new Map<number, string>();
  if (!want.length) return out;
  try {
    for (const e of await listEvents(auth, runId, Math.min(...want) - 1)) {
      if (want.includes(e.seq) && typeof e.detail?.screenshot === "string") out.set(e.seq, e.detail.screenshot);
    }
  } catch (err) {
    reportError(err, { where: "code.agent.screenshots" });
  }
  return out;
}

/** A JSON-format reply that couldn't be read: ask again once, then stop. */
async function formatProblem(auth: Authed, row: RunRow, transcript: TranscriptMessage[], raw: string, error: string, usage: RunUsage, stepStarted: number): Promise<RunRow> {
  const last = transcript[transcript.length - 1];
  const repeated = last?.role === "user" && last.content.includes(FORMAT_RETRY);
  const t = appendUser([...transcript, { role: "assistant", content: clipText(raw, 8_000) }], `${FORMAT_RETRY} ${error} Answer with exactly one JSON object: {"thought": ..., "actions": [...]}.`);
  const base = { transcript: capTranscript(t), steps: row.steps + 1, usage, active_ms: Number(row.active_ms) + (Date.now() - stepStarted) };
  if (repeated) {
    const message = "The AI's replies couldn't be understood twice in a row, so the run stopped. Try again, perhaps with another model.";
    await addEvents(auth, row.id, [{ kind: "error", title: message }]);
    return finishStep(auth, row.id, { ...base, status: "failed", error: message, pending: null }, [], [], "unreadable_replies");
  }
  await addEvents(auth, row.id, [{ kind: "note", title: "The AI's reply wasn't in the expected format; asking it again." }]);
  return finishStep(auth, row.id, base);
}

// ---------------------------------------------------------------- the user's answers

export interface RespondInput {
  decision: Decision;
  text?: string;
}

/** Answer what the run is waiting for (approve a plan, a command or edits; answer a question; carry on). */
export async function respondToRun(auth: Authed, runId: string, input: RespondInput): Promise<RunView> {
  const row = await lockRun(auth, runId, ["awaiting_approval", "needs_input"]);
  if (!row) {
    const now = await getRun(auth, runId);
    throw new ApiError("conflict", now.status === "awaiting_approval" || now.status === "needs_input" ? "The agent is busy. Try again in a moment." : "This run isn't waiting for an answer.");
  }
  try {
    return toRunView(await respond(auth, row, input));
  } catch (err) {
    await updateRun(auth, runId, { locked_until: null }).catch(() => {});
    throw err;
  }
}

async function respond(auth: Authed, row: RunRow, input: RespondInput): Promise<RunRow> {
  const pending = row.pending;
  const text = input.text?.trim() ?? "";
  if (input.decision === "stop") return cancelLocked(auth, row);
  if (row.pair) return pairRespond(auth, row, input);
  if (!pending) throw new ApiError("conflict", "This run isn't waiting for an answer.");
  let transcript = row.transcript ?? [];
  const working = workingStatus(row);
  const done = async (patch: RunPatch, events: NewEvent[]) => {
    await addEvents(auth, row.id, events);
    return (await updateRunIfNotCancelled(auth, row.id, { pending: null, ...patch, locked_until: null })) ?? updateRun(auth, row.id, { locked_until: null });
  };

  switch (pending.kind) {
    case "plan": {
      if (input.decision === "approve") {
        const plan = { ...(row.plan ?? { summary: "", steps: [] }), approved: true };
        transcript = appendUser(transcript, `The user approved your plan${text ? ` and added: ${text}` : ""}. You may now edit files and run commands. Go ahead.`);
        return done({ status: "running", plan, transcript }, [{ kind: "approval", title: "You approved the plan" }]);
      }
      if (input.decision === "reject") {
        if (!text) throw new ApiError("bad_request", "Say what should change in the plan.");
        transcript = appendUser(transcript, `The user wants changes to the plan: ${text}\nRevise it and call propose_plan again.`);
        return done({ status: "planning", transcript }, [{ kind: "answer", title: `You asked for plan changes: ${clipText(text, 300)}` }]);
      }
      break;
    }
    case "command": {
      if (input.decision === "approve" && pending.preview) {
        const lead: NewEvent = { kind: "approval", title: `You approved the server command: ${pending.command.slice(0, 200)}` };
        if (!(await optionalBox(auth, row.project_id))) {
          return done({ status: "needs_input", pending: { kind: "computer", command: pending.command, preview: true } }, [lead, { kind: "status", title: "Needs the project's computer to start the preview" }]);
        }
        return startApprovedPreview(auth, row, pending.command, [lead]);
      }
      if (input.decision === "approve") {
        if (!(await optionalBox(auth, row.project_id))) {
          return done({ status: "needs_input", pending: { kind: "computer", command: pending.command } }, [
            { kind: "approval", title: `You approved: ${pending.command.slice(0, 200)}` },
            { kind: "status", title: "Needs the project's computer to run it" },
          ]);
        }
        return runApproved(auth, row, pending.command, [{ kind: "approval", title: `You approved: ${pending.command.slice(0, 200)}` }]);
      }
      if (input.decision === "reject") {
        transcript = appendUser(transcript, `The user didn't allow the command \`${pending.command}\`${text ? `: ${text}` : "."} Don't run it; find another way or tell the user what to do.`);
        return done({ status: working, transcript }, [{ kind: "approval", title: `You declined: ${pending.command.slice(0, 200)}` }]);
      }
      break;
    }
    case "edits": {
      if (input.decision === "approve") {
        const current = new Map((await getFiles(auth, row.project_id)).map((f) => [f.path, f.content]));
        const stale = pending.changes.filter((c) => (current.get(c.path) ?? null) !== c.before);
        if (stale.length) {
          transcript = appendUser(
            transcript,
            `The user approved your edits, but ${stale.map((c) => c.path).join(", ")} changed since you proposed them, so nothing was saved. Re-read the files and make the edits again.`,
          );
          return done({ status: working, transcript }, [
            {
              kind: "error",
              title: `Edits not saved: ${stale
                .map((c) => c.path)
                .join(", ")
                .slice(0, 300)} changed meanwhile`,
            },
          ]);
        }
        const refused = await saveChanges(auth, row.id, row.project_id, pending.changes, { agent: codeAgentId(row), approved: true });
        const saved = pending.changes.filter((c) => !refused.some((r) => r.path === c.path));
        const blocked = refused.length ? ` Orbis Bastion refused ${refused.map((r) => `${r.path} (${r.reason})`).join("; ")} — those weren't saved.` : "";
        transcript = appendUser(transcript, `The user approved your edits; ${saved.length ? `they're saved: ${saved.map(describeChange).join("; ")}.` : "none could be saved."}${blocked}`);
        return done({ status: working, transcript, ...(saved.length ? { last_edit_at: new Date().toISOString() } : {}) }, [
          { kind: "approval", title: `You approved changes to ${pending.changes.length} file${pending.changes.length === 1 ? "" : "s"}` },
          ...saved.map((c) => ({ kind: "edit" as const, title: describeChange(c), detail: { path: c.path } })),
          ...refused.map((r) => ({ kind: "note" as const, title: `Bastion refused the change to ${r.path.slice(0, 200)}`, detail: { path: r.path, blocked: r.reason, bastion: true } })),
        ]);
      }
      if (input.decision === "reject") {
        transcript = appendUser(transcript, `The user rejected your proposed edits${text ? `: ${text}` : "."} Nothing was saved.`);
        return done({ status: working, transcript }, [{ kind: "approval", title: `You rejected the proposed edits${text ? `: ${clipText(text, 200)}` : ""}` }]);
      }
      break;
    }
    case "question": {
      if (input.decision === "answer" || input.decision === "approve") {
        if (!text) throw new ApiError("bad_request", "Type an answer.");
        transcript = appendUser(transcript, `The user's answer: ${text}`);
        return done({ status: working, transcript }, [{ kind: "answer", title: clipText(text, 380) }]);
      }
      break;
    }
    case "computer": {
      if (input.decision === "continue" || input.decision === "approve") {
        if (!(await optionalBox(auth, row.project_id))) throw new ApiError("conflict", "The project's computer isn't running yet. Press Start first.", { scope: "workspace_stopped" });
        if (pending.preview) return startApprovedPreview(auth, row, pending.command, []);
        return runApproved(auth, row, pending.command, []);
      }
      if (input.decision === "reject") {
        transcript = appendUser(
          transcript,
          `The project's computer isn't available, so \`${pending.command}\` didn't run. Continue without running commands, and tell the user what to run in your summary.`,
        );
        return done({ status: working, transcript }, [{ kind: "status", title: "You chose to continue without the computer" }]);
      }
      break;
    }
    case "limit": {
      if (input.decision === "continue" || input.decision === "approve") return continueAfterLimit(row, pending.reason ?? "steps", done, working);
      break;
    }
    case "job":
      throw new ApiError("conflict", "A command is running. Wait for it or press Stop.");
  }
  throw new ApiError("bad_request", "That answer doesn't fit what the run is waiting for.");
}

async function continueAfterLimit(row: RunRow, reason: LimitReason, done: (patch: RunPatch, events: NewEvent[]) => Promise<RunRow>, working: RunStatus): Promise<RunRow> {
  switch (reason) {
    case "steps": {
      const stepLimit = Math.min(MAX_STEP_LIMIT, row.step_limit + STEP_LIMIT_INCREMENT);
      if (stepLimit <= row.steps) throw new ApiError("bad_request", `A run can take at most ${MAX_STEP_LIMIT} steps. Start a new run to keep going.`);
      return done({ status: working, step_limit: stepLimit }, [{ kind: "status", title: `You allowed ${stepLimit - row.steps} more steps` }]);
    }
    case "tokens": {
      const budget = Math.min(MAX_TOKEN_BUDGET, row.token_budget + TOKEN_BUDGET_INCREMENT);
      if (budget <= row.token_budget) throw new ApiError("bad_request", "This run has reached the most tokens a run may use. Start a new run to keep going.");
      return done({ status: working, token_budget: budget }, [{ kind: "status", title: `You allowed ${(budget - row.token_budget).toLocaleString("en-US")} more tokens` }]);
    }
    case "time": {
      const limit = Math.min(MAX_TIME_LIMIT_MS, Number(row.time_limit_ms) + TIME_LIMIT_INCREMENT);
      if (limit <= Number(row.time_limit_ms)) throw new ApiError("bad_request", "This run has worked for as long as a run may. Start a new run to keep going.");
      return done({ status: working, time_limit_ms: limit }, [{ kind: "status", title: `You allowed ${Math.round((limit - Number(row.time_limit_ms)) / 60_000)} more minutes` }]);
    }
    case "tests": {
      const tests = row.tests ? { ...row.tests, attemptLimit: row.tests.failuresInRow + TEST_ATTEMPT_INCREMENT } : null;
      const transcript = appendUser(row.transcript ?? [], `The user lets you try ${TEST_ATTEMPT_INCREMENT} more times to make the tests pass. Look at the failure from a different angle.`);
      return done({ status: working, tests, transcript }, [{ kind: "status", title: `You allowed ${TEST_ATTEMPT_INCREMENT} more test attempts` }]);
    }
    case "repeat": {
      const transcript = appendUser(row.transcript ?? [], "The user lets you carry on. Don't repeat the same actions; try something different.");
      return done({ status: working, recent: [], transcript }, [{ kind: "status", title: "You let the agent carry on" }]);
    }
  }
}

/** Run a command the user approved, and put the result in the conversation. */
async function runApproved(auth: Authed, row: RunRow, command: string, lead: NewEvent[]): Promise<RunRow> {
  if (lead.length) await addEvents(auth, row.id, lead);
  // Like a command the agent runs itself: one still running after the wait keeps going (wait_for_command picks it up).
  const tool = isTestCommand(command) ? "run_tests" : "run_command";
  const out = await execCommand(auth, row.id, row.project_id, command, commandKeeps(row), { agent: codeAgentId(row), approved: true }, { background: { tool } });
  const test = !out.blocked && !out.running && isTestCommand(command) ? testResult({ command, ...out }) : null;
  const transcript = appendUser(row.transcript ?? [], `The user approved \`${command}\`. Result:\n${commandResultText(command, out, test)}`);
  await addEvents(auth, row.id, [commandEvent(command, out, test)]);
  // A build that ran after the user's go-ahead (or once the computer started) counts like any other.
  const decision = classifyCommand(command);
  const build = !test && !out.cancelled && !out.running && decision.kind !== "block" && decision.purpose === "build" ? { command: command.slice(0, 300), exitCode: out.exitCode, passed: out.exitCode === 0 && !out.timedOut, ranAt: new Date().toISOString() } : null;
  const patch: RunPatch = {
    transcript: capTranscript(transcript),
    pending: null,
    ...(build ? { checks: addChecks(runChecks(row), { build }) } : {}),
    ...(test ? { tests: addTests(row.tests, [test]) } : {}),
    ...(out.changed.length ? { last_edit_at: new Date().toISOString() } : {}),
  };
  if (out.cancelled) return updateRun(auth, row.id, { ...patch, locked_until: null });
  return finishStep(auth, row.id, { ...patch, status: workingStatus(row) });
}

/** Start the preview server the user approved (or the computer for it), and put the result in the conversation. */
async function startApprovedPreview(auth: Authed, row: RunRow, command: string, lead: NewEvent[]): Promise<RunRow> {
  if (lead.length) await addEvents(auth, row.id, lead);
  const box = await optionalBox(auth, row.project_id);
  if (!box) throw new ApiError("conflict", "The project's computer isn't running yet. Press Start first.", { scope: "workspace_stopped" });
  const d = await bastionGuard(gateCtx(auth, row.id, codeAgentId(row)), "preview.start", command, { approved: true });
  if (d.outcome !== "allow") {
    await addEvents(auth, row.id, [{ kind: "command", title: `Blocked by Bastion: ${command.slice(0, 200)}`, detail: { command, preview: true, blocked: d.reason, bastion: true } }]);
    const transcript = appendUser(row.transcript ?? [], `start_preview with \`${command}\` was blocked by Orbis Bastion: ${d.reason}`);
    return finishStep(auth, row.id, { transcript: capTranscript(transcript), pending: null, status: workingStatus(row) });
  }
  const project = await getProjectRow(auth, row.project_id);
  if (command !== project.runCommand) {
    await setRunCommand(auth, row.project_id, command);
    await addEvents(auth, row.id, [{ kind: "status", title: `Set the project's Run command to ${command.slice(0, 200)}`, detail: { runCommand: command } }]);
  }
  const s = await startPreview(box, command, { signal: async () => (await runStatus(auth, row.id)) === "cancelled" });
  const text = describeStart(s, command);
  await addEvents(auth, row.id, [
    {
      kind: "command",
      title: s.state === "running" ? `Started the preview: ${command.slice(0, 200)}` : `The preview didn't start: ${command.slice(0, 200)}`,
      detail: { command, preview: true, state: s.state, http: s.http, exitCode: s.exitCode, output: clipText(text, 20_000) },
    },
  ]);
  const transcript = appendUser(row.transcript ?? [], `start_preview with \`${command}\` ran after the user's go-ahead. Result:\n${text}`);
  const checks = addChecks(runChecks(row), { server: { command: command.slice(0, 300), state: s.state, http: s.http, at: new Date().toISOString() } });
  return finishStep(auth, row.id, { transcript: capTranscript(transcript), pending: null, checks, status: workingStatus(row) });
}

// ---------------------------------------------------------------- stop, revert and checkpoints

async function cancelLocked(auth: Authed, row: RunRow): Promise<RunRow> {
  await addEvents(auth, row.id, [{ kind: "status", title: "You stopped the run" }]);
  await updateRun(auth, row.id, { status: "cancelled", pending: null, locked_until: null, summary: row.summary ?? "Stopped before finishing." });
  return (await finalize(auth, row.id)) ?? getRun(auth, row.id);
}

/** Stop a run: no more steps, and a command it's running is ended. */
export async function cancelRun(auth: Authed, runId: string): Promise<RunView> {
  const row = await getRun(auth, runId);
  if (ENDED_STATUSES.includes(row.status)) return toRunView(row);
  // Leave the lock in place: a step in progress sees the status and ends itself.
  await updateRun(auth, runId, { status: "cancelled", pending: null, summary: row.summary ?? "Stopped before finishing." });
  await addEvents(auth, runId, [{ kind: "status", title: "You stopped the run" }]);
  if (row.pending?.kind === "job") {
    const box = await optionalBox(auth, row.project_id);
    if (box) await killJob(box, row.pending.jobId).catch((err) => reportError(err, { where: "code.agent.cancel.kill" }));
  }
  return toRunView((await finalize(auth, runId)) ?? (await getRun(auth, runId)));
}

/** End a command the run left running in the background, and forget it. */
async function endRunningJob(auth: Authed, row: Pick<RunRow, "id" | "project_id" | "job">): Promise<void> {
  if (!row.job) return;
  const box = await optionalBox(auth, row.project_id);
  if (box) await killJob(box, row.job.jobId).catch((err) => reportError(err, { where: "code.agent.job.kill" }));
  await updateRun(auth, row.id, { job: null });
}

export interface RevertResult {
  ok: boolean;
  reverted: string[];
  /** Files changed since the run (by you or a later run); reverting them would lose that work. */
  conflicts: string[];
}

function assertIdle(row: RunRow) {
  if (row.locked_until && Date.parse(row.locked_until) > Date.now() && WORKING_STATUSES.includes(row.status)) {
    throw new ApiError("conflict", "The agent is working on this run. Stop it or wait for the step to finish first.");
  }
}

/** Put files back as they were before the run: all of them, or one. */
export async function revertRun(auth: Authed, runId: string, opts: { path?: string; force?: boolean } = {}): Promise<RevertResult> {
  const row = await getRun(auth, runId);
  assertIdle(row);
  const changes = (await listChanges(auth, runId)).filter((c) => !c.revertedAt && c.before !== c.after && (!opts.path || c.path === opts.path));
  if (!changes.length) return { ok: true, reverted: [], conflicts: [] };
  const files: ProjectFile[] = await getFiles(auth, row.project_id);
  const current = new Map(files.map((f) => [f.path, f.content]));
  const conflicts = changes.filter((c) => (current.get(c.path) ?? null) !== c.after).map((c) => c.path);
  if (conflicts.length && !opts.force) return { ok: false, reverted: [], conflicts };
  const restore: FileChange[] = changes.map((c) => ({ path: c.path, before: current.get(c.path) ?? null, after: c.before })).filter((c) => c.before !== c.after);
  await applyFileChanges(
    auth,
    row.project_id,
    restore.map((c) => ({ path: c.path, content: c.after })),
  );
  await markReverted(
    auth,
    changes.map((c) => c.id),
  );
  await mirror(await optionalBox(auth, row.project_id), restore);
  await addEvents(auth, runId, [
    {
      kind: "revert",
      title: `Reverted ${changes.length === 1 ? changes[0]!.path : `${changes.length} files`}${conflicts.length ? " (overwriting later changes)" : ""}`,
      detail: { paths: changes.map((c) => c.path) },
    },
  ]);
  await updateRun(auth, runId, { last_edit_at: new Date().toISOString() });
  if (ENDED_STATUSES.includes(row.status)) await finalize(auth, runId);
  return { ok: true, reverted: changes.map((c) => c.path), conflicts };
}

/** Put the files this run changed back to one of its checkpoints. */
export async function restoreCheckpoint(auth: Authed, runId: string, checkpointId: string, opts: { force?: boolean } = {}): Promise<RevertResult> {
  const row = await getRun(auth, runId);
  assertIdle(row);
  const cp = (await listCheckpoints(auth, runId)).find((c) => c.id === checkpointId);
  if (!cp) throw new ApiError("not_found", "Checkpoint not found.");
  const runChanges = (await listChanges(auth, runId)).map((c) => ({ path: c.path, before: c.before, after: c.after }));
  const files = await getFiles(auth, row.project_id);
  const plan = planRestore(runChanges, cp.files, files);
  if (plan.conflicts.length && !opts.force) return { ok: false, reverted: [], conflicts: plan.conflicts };
  let changes = plan.changes;
  if (plan.conflicts.length) {
    // Confirmed: overwrite files changed since, too.
    const now = new Map(files.map((f) => [f.path, f.content]));
    const forced = runChanges
      .filter((c) => plan.conflicts.includes(c.path))
      .map((c) => ({ path: c.path, before: now.get(c.path) ?? null, after: Object.hasOwn(cp.files, c.path) ? cp.files[c.path]! : c.before }))
      .filter((c) => c.before !== c.after);
    changes = [...changes, ...forced];
  }
  await saveChanges(auth, runId, row.project_id, changes);
  await addEvents(auth, runId, [
    { kind: "revert", title: `Restored ${changes.length} file${changes.length === 1 ? "" : "s"} to checkpoint “${cp.label}”`, detail: { checkpoint: cp.id, paths: changes.map((c) => c.path) } },
  ]);
  await updateRun(auth, runId, { last_edit_at: new Date().toISOString() });
  if (ENDED_STATUSES.includes(row.status)) await finalize(auth, runId);
  return { ok: true, reverted: changes.map((c) => c.path), conflicts: plan.conflicts };
}
