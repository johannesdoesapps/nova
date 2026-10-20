import "server-only";
import { getProvider, resolveModelChoice, withTimeout } from "@/lib/ai";
import { autoIdFor } from "@/lib/ai/platform";
import type { Usage } from "@/lib/ai/types";
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
import { appendUser, capTranscript, clipText, initialMessage, parseAgentReply, resultsMessage, systemPrompt, trimTranscript, type TranscriptMessage } from "./protocol";
import { addEvents, getRun, listChanges, lockRun, markReverted, recordChanges, runOptions, runStatus, toRunView, updateRun, type NewEvent, type RunPatch, type RunRow } from "./runs";
import { commandEvent, commandResultText, describeChange, runActions, type AgentEnv, type CommandOutcome } from "./tools";
import { MAX_STEP_LIMIT, STEP_LIMIT_INCREMENT, WORKING_STATUSES, type Decision, type RunStatus, type RunView } from "./types";

/**
 * The coding agent's engine. The page drives a run one step at a time
 * (POST …/step); each step is one model call, metered like a chat message,
 * followed by the actions the model asked for. A run that needs the user
 * stops with what it's waiting for; their answer (POST …/respond) puts it
 * back to work. Only one step runs at a time per run (a lock in the row).
 */

/** How long a command may run before it's stopped. */
export const COMMAND_LIMIT_MS = 120_000;
const POLL_MS = 1_500;
const MAX_OUTPUT_KEPT = 200_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Back to work after a pause: planning until the plan is approved (when approval is on), else running. */
export function workingStatus(row: Pick<RunRow, "options" | "plan">): RunStatus {
  return runOptions(row).approvePlans && !row.plan?.approved ? "planning" : "running";
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
    await removeFromWorkspace(box, changes.filter((c) => c.after === null).map((c) => c.path));
    await writeToWorkspace(box, changes.filter((c): c is FileChange & { after: string } => c.after !== null).map((c) => ({ path: c.path, content: c.after })));
  } catch (err) {
    reportError(err, { where: "code.agent.mirror" });
  }
}

/** Save changes to the project, copy them to the running computer, and record them for the run. */
async function saveChanges(auth: Authed, runId: string, projectId: string, changes: FileChange[]) {
  if (!changes.length) return;
  await applyFileChanges(auth, projectId, changes.map((c) => ({ path: c.path, content: c.after })));
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

// ---------------------------------------------------------------- steps

export interface StepResult {
  run: RunView;
  /** Why no step ran (busy elsewhere, or the run is waiting or finished). */
  skipped?: "busy" | "not_working";
}

/** Finish a step: save the run unless the user stopped it meanwhile. */
async function finishStep(auth: Authed, runId: string, patch: RunPatch): Promise<RunRow> {
  const status = await runStatus(auth, runId);
  if (status === "cancelled") return updateRun(auth, runId, { locked_until: null, pending: null, transcript: patch.transcript, steps: patch.steps, plan: patch.plan });
  return updateRun(auth, runId, { ...patch, locked_until: null });
}

const FORMAT_RETRY = "FORMAT PROBLEM:";

/** Take one step of a run: one model call and the actions it asks for. */
export async function stepRun(req: Request, auth: Authed, runId: string): Promise<StepResult> {
  const row = await lockRun(auth, runId, WORKING_STATUSES);
  if (!row) {
    const now = await getRun(auth, runId);
    return { run: toRunView(now), skipped: WORKING_STATUSES.includes(now.status) ? "busy" : "not_working" };
  }
  try {
    return { run: toRunView(await step(req, auth, row)) };
  } catch (err) {
    await updateRun(auth, runId, { locked_until: null }).catch(() => {});
    throw err;
  }
}

async function step(req: Request, auth: Authed, row: RunRow): Promise<RunRow> {
  const opts = runOptions(row);
  const project = await getProjectRow(auth, row.project_id);

  if (row.steps >= row.step_limit) {
    await addEvents(auth, row.id, [{ kind: "status", title: `Paused after ${row.steps} steps` }]);
    return finishStep(auth, row.id, { status: "needs_input", pending: { kind: "limit", steps: row.steps } });
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

  const planApproved = !opts.approvePlans || !!row.plan?.approved;
  const maxOutputTokens = limits.maxOutputTokens;
  const system = `${systemPrompt({ planning: !planApproved, approvePlans: opts.approvePlans, reviewEdits: opts.reviewEdits, commands: opts.commands, docs, github })}
- Keep each reply under about ${(maxOutputTokens * 3).toLocaleString("en-US")} characters. Write big files in parts over several steps (write_file the first part, then edit_file to add the rest).`;
  const history = trimTranscript(transcript, Math.max(24_000, limits.historyChars));
  const messages = [{ role: "system" as const, content: system }, ...history];
  const promptChars = messages.reduce((n, m) => n + m.content.length, 0);
  await enforceLimits(req, auth, 1, [model], { purpose: "code_agent", inputTokens: Math.ceil(promptChars / 3.5) + 200, maxOutputTokens });

  const started = performance.now();
  let text: string;
  let usage: Usage;
  let servedModel: string | null = null;
  try {
    const r = await getProvider(model.provider).generate({ model, messages, maxOutputTokens, temperature: 0.2, signal: withTimeout(110_000, req.signal) });
    text = r.text;
    usage = r.usage;
    servedModel = r.servedModel ?? null;
  } catch (err) {
    await releaseUsage(auth);
    if (!req.signal.aborted) reportError(err, { where: "code.agent.model" });
    await addEvents(auth, row.id, [{ kind: "error", title: `${model.displayName} didn't answer. This step wasn't counted; it will be retried.` }]);
    throw new ApiError("upstream_error", `${model.displayName} didn't answer. This step wasn't counted. Press Continue to try again.`);
  }
  const latencyMs = performance.now() - started;
  const webSearches = { count: 0 };
  const record = (tools: string[]) =>
    recordRunLater(auth, {
      model,
      prompt: `[code agent] ${row.request.slice(0, 400)}`,
      response: text.slice(0, 2000),
      latencyMs,
      usage,
      status: "success",
      purpose: "code_agent",
      category: "coding",
      servedModel,
      requestedModel: opts.modelId ?? "auto:coding",
      routingReason: choice.routing?.reason ?? "Chosen by the user.",
      tools,
    });

  const parsed = parseAgentReply(text);
  if (!parsed.ok) {
    record([]);
    const last = transcript[transcript.length - 1];
    const repeated = last?.role === "user" && last.content.includes(FORMAT_RETRY);
    transcript = appendUser([...transcript, { role: "assistant", content: clipText(text, 8_000) }], `${FORMAT_RETRY} ${parsed.error} Answer with exactly one JSON object: {"thought": ..., "actions": [...]}.`);
    if (repeated) {
      const message = "The AI's replies couldn't be understood twice in a row, so the run stopped. Try again, perhaps with another model.";
      await addEvents(auth, row.id, [{ kind: "error", title: message }]);
      return finishStep(auth, row.id, { status: "failed", error: message, pending: null, transcript: capTranscript(transcript), steps: row.steps + 1 });
    }
    await addEvents(auth, row.id, [{ kind: "note", title: "The AI's reply wasn't in the expected format; asking it again." }]);
    return finishStep(auth, row.id, { transcript: capTranscript(transcript), steps: row.steps + 1 });
  }

  const reply = parsed.data;
  // Stopped while the model was thinking: nothing it asked for is carried out.
  if ((await runStatus(auth, row.id)) === "cancelled") {
    record([]);
    transcript = appendUser([...transcript, { role: "assistant", content: clipText(text, 60_000) }], "The user stopped the run before these actions ran. Nothing was done.");
    return finishStep(auth, row.id, { transcript: capTranscript(transcript), steps: row.steps + 1 });
  }
  const env = realEnv({ auth, run: row, project, docs, github, webSearches });
  const lead: NewEvent[] = reply.thought ? [{ kind: "note", title: clipText(reply.thought, 380) }] : [];
  if (lead.length) await addEvents(auth, row.id, lead);
  const outcome = await runActions(reply, { planApproved, approvePlans: opts.approvePlans, reviewEdits: opts.reviewEdits, commands: opts.commands }, env);
  record(webSearches.count ? ["web_search"] : []);

  transcript = appendUser([...transcript, { role: "assistant", content: clipText(text, 60_000) }], resultsMessage(outcome.results));
  const plan = outcome.plan ? outcome.plan : row.plan;
  const events = [...outcome.events];
  const patch: RunPatch = { transcript: capTranscript(transcript), steps: row.steps + 1, plan, pending: null, status: workingStatus({ options: row.options, plan }) };
  if (outcome.pause) {
    patch.status = outcome.pause.status;
    patch.pending = outcome.pause.pending;
  }
  if (!reply.actions.length) {
    // A reply with no actions: nudge once; it ends the run if it happens again.
    patch.transcript = capTranscript(appendUser(patch.transcript!, "You took no actions. Continue the work, or call finish if you're done."));
    const noActions = (row.transcript ?? []).slice(-1)[0]?.content.includes("You took no actions");
    if (noActions) {
      patch.status = "completed";
      patch.summary = reply.thought || "The agent stopped without a summary.";
      events.push({ kind: "summary", title: "Finished", detail: { summary: patch.summary } });
    }
  }
  if (outcome.summary) patch.summary = outcome.summary;
  await addEvents(auth, row.id, events);
  return finishStep(auth, row.id, patch);
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
        transcript = appendUser(transcript, `The user approved your plan${text ? ` and added: ${text}` : ""}. Go ahead.`);
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
          transcript = appendUser(transcript, `The user approved your edits, but ${stale.map((c) => c.path).join(", ")} changed since you proposed them, so nothing was saved. Re-read the files and make the edits again.`);
          return done({ status: working, transcript }, [{ kind: "error", title: `Edits not saved: ${stale.map((c) => c.path).join(", ").slice(0, 300)} changed meanwhile` }]);
        }
        await saveChanges(auth, row.id, row.project_id, pending.changes);
        transcript = appendUser(transcript, `The user approved your edits; they're saved: ${pending.changes.map(describeChange).join("; ")}.`);
        return done({ status: working, transcript }, [
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
        transcript = appendUser(transcript, `The project's computer isn't available, so \`${pending.command}\` didn't run. Continue without running commands, and tell the user what to run in your summary.`);
        return done({ status: working, transcript }, [{ kind: "status", title: "You chose to continue without the computer" }]);
      }
      break;
    }
    case "limit": {
      if (input.decision === "continue" || input.decision === "approve") {
        const stepLimit = Math.min(MAX_STEP_LIMIT, row.step_limit + STEP_LIMIT_INCREMENT);
        if (stepLimit <= row.steps) throw new ApiError("bad_request", `A run can take at most ${MAX_STEP_LIMIT} steps. Start a new run to keep going.`);
        return done({ status: working, step_limit: stepLimit }, [{ kind: "status", title: `You allowed ${stepLimit - row.steps} more steps` }]);
      }
      break;
    }
    case "job":
      throw new ApiError("conflict", "A command is running. Wait for it or press Stop.");
  }
  throw new ApiError("bad_request", "That answer doesn't fit what the run is waiting for.");
}

/** Run a command the user approved, and put the result in the conversation. */
async function runApproved(auth: Authed, row: RunRow, command: string, lead: NewEvent[]): Promise<RunRow> {
  if (lead.length) await addEvents(auth, row.id, lead);
  const out = await execCommand(auth, row.id, row.project_id, command);
  const transcript = appendUser(row.transcript ?? [], `The user approved \`${command}\`. Result:\n${commandResultText(command, out)}`);
  await addEvents(auth, row.id, [commandEvent(command, out)]);
  if (out.cancelled) return updateRun(auth, row.id, { transcript: capTranscript(transcript), pending: null, locked_until: null });
  return finishStep(auth, row.id, { status: workingStatus(row), pending: null, transcript: capTranscript(transcript) });
}

// ---------------------------------------------------------------- stop and revert

async function cancelLocked(auth: Authed, row: RunRow): Promise<RunRow> {
  await addEvents(auth, row.id, [{ kind: "status", title: "You stopped the run" }]);
  return updateRun(auth, row.id, { status: "cancelled", pending: null, locked_until: null, summary: row.summary ?? "Stopped before finishing." });
}

/** Stop a run: no more steps, and a command it's running is ended. */
export async function cancelRun(auth: Authed, runId: string): Promise<RunView> {
  const row = await getRun(auth, runId);
  if (["completed", "failed", "cancelled"].includes(row.status)) return toRunView(row);
  // Leave the lock in place: a step in progress sees the status and ends itself.
  const updated = await updateRun(auth, runId, { status: "cancelled", pending: null, summary: row.summary ?? "Stopped before finishing." });
  await addEvents(auth, runId, [{ kind: "status", title: "You stopped the run" }]);
  if (row.pending?.kind === "job") {
    const box = await optionalBox(auth, row.project_id);
    if (box) await killJob(box, row.pending.jobId).catch((err) => reportError(err, { where: "code.agent.cancel.kill" }));
  }
  return toRunView(updated);
}

export interface RevertResult {
  ok: boolean;
  reverted: string[];
  /** Files changed since the run (by you or a later run); reverting them would lose that work. */
  conflicts: string[];
}

/** Put files back as they were before the run: all of them, or one. */
export async function revertRun(auth: Authed, runId: string, opts: { path?: string; force?: boolean } = {}): Promise<RevertResult> {
  const row = await getRun(auth, runId);
  if (row.locked_until && Date.parse(row.locked_until) > Date.now() && WORKING_STATUSES.includes(row.status)) {
    throw new ApiError("conflict", "The agent is working on this run. Stop it or wait for the step to finish first.");
  }
  const changes = (await listChanges(auth, runId)).filter((c) => !c.revertedAt && c.before !== c.after && (!opts.path || c.path === opts.path));
  if (!changes.length) return { ok: true, reverted: [], conflicts: [] };
  const files: ProjectFile[] = await getFiles(auth, row.project_id);
  const current = new Map(files.map((f) => [f.path, f.content]));
  const conflicts = changes.filter((c) => (current.get(c.path) ?? null) !== c.after).map((c) => c.path);
  if (conflicts.length && !opts.force) return { ok: false, reverted: [], conflicts };
  const restore: FileChange[] = changes.map((c) => ({ path: c.path, before: current.get(c.path) ?? null, after: c.before })).filter((c) => c.before !== c.after);
  await applyFileChanges(auth, row.project_id, restore.map((c) => ({ path: c.path, content: c.after })));
  await markReverted(auth, changes.map((c) => c.id));
  await mirror(await optionalBox(auth, row.project_id), restore);
  await addEvents(auth, runId, [
    { kind: "revert", title: `Reverted ${changes.length === 1 ? changes[0]!.path : `${changes.length} files`}${conflicts.length ? " (overwriting later changes)" : ""}`, detail: { paths: changes.map((c) => c.path) } },
  ]);
  return { ok: true, reverted: changes.map((c) => c.path), conflicts };
}
