import "server-only";
import { getProvider, resolveModelChoice, withTimeout } from "@/lib/ai";
import { estimateCost } from "@/lib/ai/cost";
import { autoIdFor } from "@/lib/ai/platform";
import type { ModelInfo, Usage } from "@/lib/ai/types";
import { getConnection, runTool, usable } from "@/lib/connectors/runtime";
import { connector } from "@/lib/connectors/registry";
import { serverEnv } from "@/lib/env";
import { ApiError } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { webSearch } from "@/lib/search/web";
import { enforceLimits, planLimits, recordRunLater, releaseUsage } from "@/lib/usage";
import type { FileChange, ProjectFile, ProjectSummary } from "../projects";
import { applyFileChanges, getFiles, getProjectRow, optionalBox, syncBack, type Authed } from "../server";
import { claimSync, killJob, readJob, removeFromWorkspace, startJob, writeToWorkspace, type WorkspaceBox } from "../workspace";
import {
  appendStep,
  appendUser,
  capTranscript,
  clipText,
  initialMessage,
  messageSize,
  parseAgentReply,
  systemPrompt,
  toJsonChat,
  toToolMessages,
  trimTranscript,
  type AgentReply,
  type TranscriptMessage,
} from "./protocol";
import { buildReport } from "./report";
import {
  addEvents,
  createCheckpoint,
  getRun,
  listChanges,
  listCheckpoints,
  listEvents,
  lockRun,
  markReverted,
  recordChanges,
  runOptions,
  runStatus,
  runUsage,
  toRunView,
  updateRun,
  type NewEvent,
  type RunPatch,
  type RunRow,
} from "./runs";
import { isTestCommand, testResult, type TestResult } from "./test-results";
import { toolSchemas, type ToolContext } from "./tool-specs";
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
  type RunStatus,
  type RunTests,
  type RunUsage,
  type RunView,
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

/** How long a command may run before it's stopped. */
export const COMMAND_LIMIT_MS = 120_000;
const MODEL_TIMEOUT_MS = 110_000;
/** One request keeps taking steps while it has been working for less than this. */
const MULTI_STEP_MS = 45_000;
const POLL_MS = 1_500;
const MAX_OUTPUT_KEPT = 200_000;
const TOKEN_BUDGET_INCREMENT = 300_000;
const TIME_LIMIT_INCREMENT = 15 * 60_000;
const TEST_ATTEMPT_INCREMENT = 2;
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

/** A step's actions as one comparable string (ids left out). */
export function actionSignature(reply: Pick<AgentReply, "actions">): string {
  return JSON.stringify(reply.actions.map((a) => [a.tool, a.args]));
}

// ---------------------------------------------------------------- the real environment

interface EnvContext {
  auth: Authed;
  run: RunRow;
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

/** Save changes to the project, copy them to the running computer, and record them for the run. */
async function saveChanges(auth: Authed, runId: string, projectId: string, changes: FileChange[]) {
  if (!changes.length) return;
  await applyFileChanges(
    auth,
    projectId,
    changes.map((c) => ({ path: c.path, content: c.after })),
  );
  await recordChanges(auth, runId, changes);
  await mirror(await optionalBox(auth, projectId), changes);
}

/** Run a command in the project's computer, wait for it, and copy back the files it changed. */
async function execCommand(auth: Authed, runId: string, projectId: string, command: string): Promise<CommandOutcome> {
  const box = await optionalBox(auth, projectId);
  if (!box) throw new ApiError("conflict", "The project's computer isn't running.", { scope: "workspace_stopped" });
  const before = await getFiles(auth, projectId);
  const jobId = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  await updateRun(auth, runId, { pending: { kind: "job", jobId, command } });
  await startJob(box, jobId, command);

  let output = "";
  let offset = 0;
  let exitCode: number | null = null;
  let done = false;
  let cancelled = false;
  let startedAt = started;
  let polls = 0;
  let more = false;
  while (Date.now() - started < COMMAND_LIMIT_MS) {
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
    } catch (err) {
      reportError(err, { where: "code.agent.sync" });
      skipped = ["(files changed by this command couldn't be copied back)"];
    }
  }
  return { exitCode, output, durationMs: Date.now() - started, timedOut, cancelled, changed, skipped };
}

function realEnv(c: EnvContext): AgentEnv {
  const { auth, run, project } = c;
  const env: AgentEnv = {
    files: () => getFiles(auth, project.id),
    save: (changes) => saveChanges(auth, run.id, project.id, changes),
    computer: async () => Boolean(await optionalBox(auth, project.id)),
    exec: (command) => execCommand(auth, run.id, project.id, command),
    changes: async () => (await listChanges(auth, run.id)).map((ch) => ({ path: ch.path, before: ch.before, after: ch.after })),
    checkpoints: { list: () => listCheckpoints(auth, run.id), create: (label, files) => createCheckpoint(auth, run.id, label, files) },
    project: { runCommand: project.runCommand },
    emit: (events) => addEvents(auth, run.id, events),
  };
  if (c.docs) {
    env.lookupDocs = async (query) => {
      const e = serverEnv();
      c.webSearches.count++;
      const r = await webSearch(query, { provider: e.searchProvider, apiKey: e.searchKey }, withTimeout(15_000));
      return r.sources.slice(0, 6).map((s) => ({ title: s.title, url: s.url, snippet: s.snippet }));
    };
  }
  if (c.github) {
    env.github = async (tool, args) => {
      const r = await runTool(auth, tool, args);
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
async function finalize(auth: Authed, runId: string, unresolved: string[] = []): Promise<RunRow | null> {
  try {
    const row = await getRun(auth, runId);
    const [changes, files, events, checkpoints] = await Promise.all([listChanges(auth, runId), getFiles(auth, row.project_id), listEvents(auth, runId), listCheckpoints(auth, runId)]);
    const report = buildReport({
      status: row.status,
      summary: row.summary,
      unresolved: unresolved.length ? unresolved : (row.report?.unresolved ?? []),
      changes,
      current: new Map(files.map((f) => [f.path, f.content])),
      events,
      tests: row.tests,
      lastEditAt: row.last_edit_at,
      usage: runUsage(row),
      steps: row.steps,
      activeMs: Number(row.active_ms),
      checkpoints: checkpoints.length,
    });
    return await updateRun(auth, runId, { report });
  } catch (err) {
    reportError(err, { where: "code.agent.report" });
    return null;
  }
}

// ---------------------------------------------------------------- steps

export interface StepResult {
  run: RunView;
  /** Why no step ran: busy elsewhere, the run is waiting or finished, or the step asked for already ran. */
  skipped?: "busy" | "not_working" | "stale";
}

/** Finish a step: save the run unless the user stopped it meanwhile, and write the report when it ended. */
async function finishStep(auth: Authed, runId: string, patch: RunPatch, unresolved: string[] = []): Promise<RunRow> {
  const status = await runStatus(auth, runId);
  let row: RunRow;
  if (status === "cancelled") {
    // The user's stop stands: the step's records are kept, its status and summary aren't.
    const kept: RunPatch = { ...patch };
    delete kept.status;
    delete kept.summary;
    row = await updateRun(auth, runId, { ...kept, locked_until: null, pending: null });
  } else {
    row = await updateRun(auth, runId, { ...patch, locked_until: null });
  }
  if (ENDED_STATUSES.includes(row.status)) return (await finalize(auth, runId, unresolved)) ?? row;
  return row;
}

const pauseFor = (reason: LimitReason, steps: number, detail: string): RunPatch => ({ status: "needs_input", pending: { kind: "limit", steps, reason, detail } });

const FORMAT_RETRY = "FORMAT PROBLEM:";

/**
 * Take the run's next step, and keep going while it's working and the request
 * is young. `expectStep` is the step count the caller last saw: when the run
 * has moved on since (a retried request), nothing runs.
 */
export async function stepRun(req: Request, auth: Authed, runId: string, opts: { expectStep?: number } = {}): Promise<StepResult> {
  const started = Date.now();
  let latest: RunView | null = null;
  for (let n = 0; ; n++) {
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
      latest = toRunView(await step(req, auth, row));
    } catch (err) {
      await updateRun(auth, runId, { locked_until: null }).catch(() => {});
      // The first step's failure goes back to the caller; a later one has been logged, so report where the run is.
      if (n === 0) throw err;
      return { run: toRunView(await getRun(auth, runId)) };
    }
    if (!WORKING_STATUSES.includes(latest.status) || Date.now() - started > MULTI_STEP_MS) return { run: latest };
  }
}

async function step(req: Request, auth: Authed, row: RunRow): Promise<RunRow> {
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
  const choice = await resolveModelChoice(opts.modelId ?? autoIdFor("coding"), { prompt: row.request, mode: "coding", tiers: limits.tiers });
  const model = choice.model;
  if (model.provider === "demo") {
    const message = "No AI model is set up on this site, so the agent can't run.";
    await addEvents(auth, row.id, [{ kind: "error", title: message }]);
    return finishStep(auth, row.id, { status: "failed", error: message, pending: null });
  }

  const e = serverEnv();
  const docs = Boolean(e.searchKey) && ["tavily", "brave"].includes(e.searchProvider) && limits.webSearchesLeft !== 0;
  const github = await githubUsable(auth);
  let transcript: TranscriptMessage[] = row.transcript ?? [];
  if (!transcript.length) {
    const files = await getFiles(auth, project.id);
    const computer = Boolean(await optionalBox(auth, project.id));
    transcript = [{ role: "user", content: initialMessage(row.request, files, { projectName: project.name, runCommand: project.runCommand, computer }) }];
    await addEvents(auth, row.id, [{ kind: "status", title: `Started with ${model.displayName}`, detail: { model: model.displayName, routing: choice.routing?.reason ?? null } }]);
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

  const planApproved = !opts.approvePlans || !!row.plan?.approved;
  const ctx: ToolContext = { commands: opts.commands, docs, github, approvePlans: opts.approvePlans };
  const native = usesNativeTools(model);
  const maxOutputTokens = limits.maxOutputTokens;
  const system = `${systemPrompt({ ...ctx, planning: !planApproved, reviewEdits: opts.reviewEdits, native })}
- Keep each reply under about ${(maxOutputTokens * 3).toLocaleString("en-US")} characters. Write big files in parts over several steps (write_file the first part, then edit_file to add the rest).`;
  const history = trimTranscript(transcript, Math.max(24_000, limits.historyChars));
  const promptChars = system.length + history.reduce((n, m) => n + messageSize(m), 0);
  await enforceLimits(req, auth, 1, [model], { purpose: "code_agent", inputTokens: Math.ceil(promptChars / 3.5) + 200, maxOutputTokens });

  // The model call isn't tied to the browser's request: a closed tab doesn't cut a step off half way.
  const started = performance.now();
  let reply: AgentReply;
  let raw = "";
  let callUsage: Usage;
  let servedModel: string | null = null;
  let stop: "tool_use" | "end_turn" | "max_tokens" | "refusal" | "other" | "json" = "json";
  try {
    if (native) {
      const r = await getProvider(model.provider).toolTurn!({ model, system, messages: toToolMessages(history), tools: toolSchemas(ctx), maxOutputTokens, signal: withTimeout(MODEL_TIMEOUT_MS) });
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
        signal: withTimeout(MODEL_TIMEOUT_MS),
      });
      raw = r.text;
      callUsage = r.usage;
      servedModel = r.servedModel ?? null;
      const parsed = parseAgentReply(r.text);
      reply = parsed.ok ? { ...parsed.data, actions: parsed.data.actions.map((a, i) => ({ ...a, id: `s${row.steps}a${i}` })) } : { thought: "", actions: [] };
      if (!parsed.ok) {
        usage = addUsage(usage, model, callUsage, promptChars, raw.length);
        return formatProblem(auth, row, transcript, raw, parsed.error, usage, stepStarted);
      }
    }
  } catch (err) {
    await releaseUsage(auth);
    reportError(err, { where: "code.agent.model" });
    await addEvents(auth, row.id, [{ kind: "error", title: `${model.displayName} didn't answer. This step wasn't counted; it can be retried.` }]);
    throw new ApiError("upstream_error", `${model.displayName} didn't answer. This step wasn't counted. Press Continue to try again.`);
  }
  const latencyMs = performance.now() - started;
  usage = addUsage(usage, model, callUsage, promptChars, raw.length);
  const webSearches = { count: 0 };
  const record = (tools: string[]) =>
    recordRunLater(auth, {
      model,
      prompt: `[code agent] ${row.request.slice(0, 400)}`,
      response: raw.slice(0, 2000),
      latencyMs,
      usage: callUsage,
      status: "success",
      purpose: "code_agent",
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
    return finishStep(auth, row.id, { status: "failed", error: message, pending: null, usage, steps: row.steps + 1, active_ms: Number(row.active_ms) + (Date.now() - stepStarted) });
  }

  const assistant: TranscriptMessage = { role: "assistant", content: reply.thought, ...(reply.actions.length ? { calls: reply.actions.map((a) => ({ id: a.id!, tool: a.tool, args: a.args })) } : {}) };
  const base = { steps: row.steps + 1, usage, active_ms: Number(row.active_ms) + (Date.now() - stepStarted) };

  // The reply was cut off at the output limit: none of its actions are trusted.
  if (stop === "max_tokens") {
    record([]);
    const results = reply.actions.map((a) => ({ id: a.id, tool: a.tool, ok: false, text: "Not run: your reply was cut off at the output limit." }));
    const next = assistant.calls ? appendStep(transcript, assistant, results) : [...transcript, assistant];
    const t = appendUser(next, `Your reply was cut off at the output limit (${maxOutputTokens.toLocaleString("en-US")} tokens). Do less per step: write big files in parts.`);
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

  const env = realEnv({ auth, run: row, project, docs, github, webSearches });
  if (reply.thought) await addEvents(auth, row.id, [{ kind: "note", title: clipText(reply.thought, 380) }]);
  const outcome = await runActions(reply, { planApproved, approvePlans: opts.approvePlans, reviewEdits: opts.reviewEdits, commands: opts.commands, lastTests: row.tests?.last ?? null }, env);
  record(webSearches.count ? ["web_search"] : []);

  const tests = outcome.tests.length ? addTests(row.tests, outcome.tests) : row.tests;
  const plan = outcome.plan ? outcome.plan : row.plan;
  const patch: RunPatch = {
    ...base,
    active_ms: Number(row.active_ms) + (Date.now() - stepStarted),
    recent,
    tests,
    transcript: capTranscript(reply.actions.length ? appendStep(withAssistant, assistant, outcome.results) : withAssistant),
    plan,
    pending: null,
    status: workingStatus({ options: row.options, plan }),
    ...(outcome.edited ? { last_edit_at: new Date().toISOString() } : {}),
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
  return finishStep(auth, row.id, patch, outcome.unresolved);
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
    return finishStep(auth, row.id, { ...base, status: "failed", error: message, pending: null });
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
  if (!pending) throw new ApiError("conflict", "This run isn't waiting for an answer.");
  let transcript = row.transcript ?? [];
  const working = workingStatus(row);
  const done = async (patch: RunPatch, events: NewEvent[]) => {
    await addEvents(auth, row.id, events);
    return updateRun(auth, row.id, { pending: null, ...patch, locked_until: null });
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
        await saveChanges(auth, row.id, row.project_id, pending.changes);
        transcript = appendUser(transcript, `The user approved your edits; they're saved: ${pending.changes.map(describeChange).join("; ")}.`);
        return done({ status: working, transcript, last_edit_at: new Date().toISOString() }, [
          { kind: "approval", title: `You approved changes to ${pending.changes.length} file${pending.changes.length === 1 ? "" : "s"}` },
          ...pending.changes.map((c) => ({ kind: "edit" as const, title: describeChange(c), detail: { path: c.path } })),
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
  const out = await execCommand(auth, row.id, row.project_id, command);
  const test = isTestCommand(command) ? testResult({ command, ...out }) : null;
  const transcript = appendUser(row.transcript ?? [], `The user approved \`${command}\`. Result:\n${commandResultText(command, out, test)}`);
  await addEvents(auth, row.id, [commandEvent(command, out, test)]);
  const patch: RunPatch = {
    transcript: capTranscript(transcript),
    pending: null,
    ...(test ? { tests: addTests(row.tests, [test]) } : {}),
    ...(out.changed.length ? { last_edit_at: new Date().toISOString() } : {}),
  };
  if (out.cancelled) return updateRun(auth, row.id, { ...patch, locked_until: null });
  return finishStep(auth, row.id, { ...patch, status: workingStatus(row) });
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
