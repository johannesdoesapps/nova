import "server-only";
import { getProvider, resolveModelChoice, withTimeout } from "@/lib/ai";
import { autoIdFor } from "@/lib/ai/platform";
import type { ModelInfo, Usage } from "@/lib/ai/types";
import { ApiError } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { enforceLimits, planLimits, recordRunLater, releaseUsage } from "@/lib/usage";
import { byteLength, MAX_FILE_BYTES, validProjectPath, type FileChange } from "../projects";
import { getFiles, getProjectRow, optionalBox, setRunCommand, type Authed } from "../server";
import { AGENT_OUTPUT_TOKENS, MAX_MODEL_FAILURES, addTests, addUsage, codeAgentId, execCommand, finishStep, modelTimeoutFor, pauseFor, saveChanges } from "../agent/engine";
import { commandOp } from "../../bastion/guards";
import { guard as bastionGuard } from "../../bastion/server";
import { classifyCommand } from "../agent/policy";
import { addEvents, createCheckpoint, listEvents, runOptions, runStatus, runUsage, updateRun, updateRunIfNotCancelled, type RunPatch, type RunRow } from "../agent/runs";
import { testResult } from "../agent/test-results";
import { commandEvent, isSecretPath } from "../agent/tools";
import type { FailureKind, RunUsage } from "../agent/types";
import {
  PHASE_AGENT,
  afterReview,
  applyResponses,
  applyReview,
  askText,
  checkPaths,
  codeSchema,
  finalSchema,
  messagesFor,
  newPairState,
  openFindings,
  parseReply,
  planSchema,
  reviewSchema,
  DEFAULT_ROUNDS,
  type Agent,
  type PairPhase,
  type PairState,
  type PairTestRun,
} from "./protocol";

/**
 * Pair coding's steps on the server. Each step is one move: an agent's model call (streamed; its text
 * is saved as it arrives so the page can show it), or running the tests in the project's computer.
 * Files are changed only through the same path as the coding agent (recorded before and after, a
 * checkpoint first, so every change can be reviewed and undone); commands go through the same policy
 * (anything not clearly safe waits for the user). Runs on the existing task lifecycle: one step at a
 * time per task (the lock), Stop, limits, billing and the final report.
 */

const LIVE_EVERY_MS = 1_500;
const LIVE_CHARS = 4_000;
const AGENT_LABEL: Record<Agent, string> = { architect: "Architect", reviewer: "Reviewer" };

/** Instructions the user sent while the task worked (kept as activity events, so a step can't overwrite them). */
async function newNotes(auth: Authed, row: RunRow, s: PairState): Promise<{ notes: PairState["notes"]; lastSeq: number }> {
  const after = s.noteSeq ?? 0;
  const evs = await listEvents(auth, row.id, after);
  const notes = evs
    .filter((e) => e.kind === "answer" && (e.detail as { pairNote?: boolean } | null)?.pairNote)
    .map((e) => ({ at: e.createdAt, text: String((e.detail as { text?: string }).text ?? e.title), used: false }));
  return { notes: [...s.notes, ...notes], lastSeq: evs.at(-1)?.seq ?? after };
}

export async function pairStep(req: Request, auth: Authed, row: RunRow, deadline: number, clock: () => number = Date.now): Promise<RunRow> {
  const stepStarted = Date.now();
  const opts = runOptions(row);
  let s: PairState = row.pair ?? newPairState(opts.pair ?? { architect: null, reviewer: null, maxRounds: DEFAULT_ROUNDS, approvePlan: false, runTests: true });
  let usage: RunUsage = runUsage(row);
  const base = () => ({ steps: row.steps + 1, active_ms: Number(row.active_ms) + (Date.now() - stepStarted) });

  if (row.steps >= row.step_limit) return finishStep(auth, row.id, pauseFor("steps", row.steps, `The two agents have taken ${row.steps} steps.`));
  if (usage.inputTokens + usage.outputTokens >= row.token_budget)
    return finishStep(
      auth,
      row.id,
      pauseFor("tokens", row.steps, `The agents have used ${(usage.inputTokens + usage.outputTokens).toLocaleString("en-US")} tokens of ${row.token_budget.toLocaleString("en-US")}.`),
    );
  if (Number(row.active_ms) >= Number(row.time_limit_ms))
    return finishStep(auth, row.id, pauseFor("time", row.steps, `The agents have worked for ${Math.round(Number(row.active_ms) / 60_000)} minutes.`));

  const project = await getProjectRow(auth, row.project_id);
  if (s.phase === "done") return finishStep(auth, row.id, { status: "completed", pending: null, pair: { ...s, live: null } });
  if (s.phase === "test") return testStep(auth, row, s);

  const phase = s.phase as Exclude<PairPhase, "test" | "done">;
  const agent = PHASE_AGENT[phase];
  const limits = await planLimits(auth);
  const choice = await resolveModelChoice(s.settings[agent] ?? autoIdFor("coding"), { prompt: row.request, mode: "coding", tiers: limits.tiers });
  const model = choice.model;
  if (model.provider === "demo") {
    const message = "No AI model is set up on this site, so the agents can't run.";
    await addEvents(auth, row.id, [{ kind: "error", title: message }]);
    return finishStep(auth, row.id, { status: "failed", error: message, pending: null }, [], [], "no_model");
  }
  if (row.steps === 0) {
    const other = await resolveModelChoice(s.settings.reviewer ?? autoIdFor("coding"), { prompt: row.request, mode: "coding", tiers: limits.tiers }).catch(() => null);
    await addEvents(auth, row.id, [
      {
        kind: "status",
        title: `Pair session started — Architect: ${model.displayName}; Reviewer: ${other?.model.displayName ?? "Auto"}; up to ${s.settings.maxRounds} review round${s.settings.maxRounds === 1 ? "" : "s"}`,
        detail: { pair: { architect: model.displayName, reviewer: other?.model.displayName ?? null } },
      },
    ]);
  }

  // Instructions the user sent meanwhile go to this call.
  const n = await newNotes(auth, row, s);
  s = { ...s, notes: n.notes, noteSeq: n.lastSeq, models: { ...s.models, [agent]: model.displayName } };

  const files = await getFiles(auth, project.id);
  const messages = messagesFor(phase, s, { request: row.request, projectName: project.name, files, isSecret: isSecretPath });
  const promptChars = messages.reduce((x, m) => x + m.content.length, 0);
  const maxOutputTokens = Math.max(limits.maxOutputTokens, AGENT_OUTPUT_TOKENS);
  await enforceLimits(req, auth, 1, [model], { purpose: "pair_coding", inputTokens: Math.ceil(promptChars / 3.5) + 200, maxOutputTokens });

  // The call, streamed: what the agent writes is saved every second or so for the page to show.
  const started = performance.now();
  let raw = "";
  let callUsage: Usage = { inputTokens: null, outputTokens: null, estimated: true } as unknown as Usage;
  let servedModel: string | null = null;
  let cutOff = false;
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, withTimeout(modelTimeoutFor(deadline, clock()))]);
  let lastFlush = Date.now();
  let flushes = 0;
  try {
    for await (const ev of getProvider(model.provider).stream({ model, messages, maxOutputTokens, temperature: 0.2, signal })) {
      if (ev.type === "delta") raw += ev.text;
      else if (ev.type === "usage") callUsage = ev.usage;
      else if (ev.type === "served") servedModel = ev.servedModel;
      else if (ev.type === "stop") cutOff = ev.reason === "length";
      if (Date.now() - lastFlush > LIVE_EVERY_MS) {
        lastFlush = Date.now();
        const saved = await updateRunIfNotCancelled(auth, row.id, { pair: { ...s, live: { agent, phase, text: raw.slice(-LIVE_CHARS), at: new Date().toISOString() } } }).catch(() => undefined);
        // Stopped by the user: end the call now rather than finishing an answer nobody will use.
        if (saved === null || (++flushes % 4 === 0 && (await runStatus(auth, row.id)) === "cancelled")) {
          abort.abort();
          break;
        }
      }
    }
  } catch (err) {
    if (abort.signal.aborted) return finishStep(auth, row.id, { pair: { ...s, live: null } });
    await releaseUsage(auth);
    reportError(err, { where: "code.pair.model" });
    const reason = err instanceof ApiError ? err.message : `${model.displayName} didn't answer.`;
    const failures = (usage.modelFailuresInRow ?? 0) + 1;
    usage = { ...usage, retries: (usage.retries ?? 0) + 1 };
    const permanent = err instanceof ApiError && (err.code === "bad_request" || err.code === "not_configured");
    if (permanent || failures >= MAX_MODEL_FAILURES) {
      const message = permanent
        ? `${reason} The ${AGENT_LABEL[agent]} couldn't continue; try another model for it.`
        : `The ${AGENT_LABEL[agent]} (${model.displayName}) failed ${failures} times in a row (${reason}), so the task stopped. Try again later or with another model.`;
      await addEvents(auth, row.id, [{ kind: "error", title: message.slice(0, 380), detail: { pair: { agent, phase } } }]);
      const kind: FailureKind = !permanent ? "provider_unavailable" : (err as ApiError).code === "not_configured" ? "provider_not_configured" : "provider_rejected";
      return finishStep(auth, row.id, { status: "failed", error: message.slice(0, 2000), pending: null, usage: { ...usage, modelFailuresInRow: failures }, pair: { ...s, live: null } }, [], [], kind);
    }
    await updateRun(auth, row.id, { usage: { ...usage, modelFailuresInRow: failures }, pair: { ...s, live: null } });
    await addEvents(auth, row.id, [{ kind: "error", title: `${reason} This step wasn't counted; it can be retried.`.slice(0, 380), detail: { pair: { agent, phase } } }]);
    throw new ApiError("upstream_error", `${reason} This step wasn't counted. Press Continue to try again.`);
  }
  if (abort.signal.aborted) return finishStep(auth, row.id, { pair: { ...s, live: null } });

  usage = { ...addUsage(usage, model, callUsage, promptChars, raw.length), modelFailuresInRow: 0 };
  recordRunLater(auth, {
    model,
    prompt: `[pair ${agent}] ${row.request.slice(0, 400)}`,
    response: raw.slice(0, 2000),
    latencyMs: performance.now() - started,
    usage: callUsage,
    status: "success",
    purpose: "pair_coding",
    category: "coding",
    servedModel,
    requestedModel: s.settings[agent] ?? "auto:coding",
    routingReason: choice.routing?.reason ?? "Chosen by the user.",
    tools: [],
  });
  s = { ...s, live: null, notes: s.notes.map((x) => ({ ...x, used: true })) };
  // Stopped while the reply was arriving: its files aren't written and nothing it asked for runs.
  if ((await runStatus(auth, row.id)) === "cancelled") return finishStep(auth, row.id, { ...base(), usage, pair: s });

  const schema = phase === "plan" ? planSchema : phase === "review" ? reviewSchema : phase === "final" ? finalSchema : codeSchema;
  const parsed = cutOff ? ({ ok: false, error: "The reply was cut off at the output limit." } as const) : parseReply(schema as typeof planSchema, raw);
  if (!parsed.ok) {
    const failures = s.formatFailures + 1;
    s = { ...s, formatFailures: failures };
    if (failures >= 2) {
      const message = `The ${AGENT_LABEL[agent]}'s replies couldn't be used twice in a row (${parsed.error}), so the task stopped. Try again, perhaps with another model for the ${AGENT_LABEL[agent]}.`;
      await addEvents(auth, row.id, [{ kind: "error", title: message.slice(0, 380), detail: { pair: { agent, phase } } }]);
      return finishStep(auth, row.id, { ...base(), usage, status: "failed", error: message.slice(0, 2000), pending: null, pair: s }, [], [], "unreadable_replies");
    }
    await addEvents(auth, row.id, [
      { kind: "note", title: `The ${AGENT_LABEL[agent]}'s reply wasn't in the expected format (${parsed.error}); asking again.`.slice(0, 380), detail: { pair: { agent, phase } } },
    ]);
    return finishStep(auth, row.id, { ...base(), usage, pair: s });
  }
  s = { ...s, formatFailures: 0 };
  return handleReply(auth, row, project, s, phase, parsed.data, { ...base(), usage }, model);
}

type Project = Awaited<ReturnType<typeof getProjectRow>>;

async function handleReply(auth: Authed, row: RunRow, project: Project, s: PairState, phase: Exclude<PairPhase, "test" | "done">, data: unknown, patch: RunPatch, model: ModelInfo): Promise<RunRow> {
  const ev = (agent: Agent, extra: Record<string, unknown> = {}) => ({ pair: { agent, phase, round: s.round, model: model.displayName, ...extra } });

  if (phase === "plan") {
    const plan = planSchema.parse(data);
    s = { ...s, plan, phase: "implement" };
    await addEvents(auth, row.id, [
      { kind: "plan", title: `Architect's plan: ${plan.summary}`.slice(0, 380), detail: ev("architect", { plan }) },
      ...plan.decisions.slice(0, 6).map((d) => ({ kind: "note" as const, title: `Decision: ${d.decision} — ${d.why}`.slice(0, 380), detail: ev("architect") })),
    ]);
    const steps = plan.tasks.length ? plan.tasks : plan.files.map((f) => `${f.path}: ${f.purpose}`);
    if (s.settings.approvePlan) {
      await addEvents(auth, row.id, [{ kind: "status", title: "Waiting for you to approve the plan" }]);
      return finishStep(auth, row.id, { ...patch, pair: s, plan: { summary: plan.summary, steps: steps.slice(0, 20), approved: false }, status: "awaiting_approval", pending: { kind: "plan" } });
    }
    return finishStep(auth, row.id, { ...patch, pair: s, plan: { summary: plan.summary, steps: steps.slice(0, 20), approved: true }, status: "running" });
  }

  if (phase === "implement" || phase === "revise") {
    const code = codeSchema.parse(data);
    if (phase === "revise") s = applyResponses(s, code.responses);
    const applied = await applyCode(auth, row, code, phase === "implement" ? "Before the Architect's first version" : `Before the Architect's revision ${s.round}`);
    s = { ...s, changed: [...s.changed, applied.paths].slice(-10), phase: s.settings.runTests && s.plan?.testCommand ? "test" : "review" };
    const accepted = code.responses.filter((r) => r.decision === "accept").length;
    const rejected = code.responses.filter((r) => r.decision === "reject");
    await addEvents(auth, row.id, [
      {
        kind: "edit",
        title: applied.paths.length
          ? `Architect ${phase === "implement" ? "wrote" : "revised"} ${applied.paths.length} file${applied.paths.length === 1 ? "" : "s"}: ${applied.paths.join(", ")}`.slice(0, 380)
          : "Architect changed no files",
        detail: ev("architect", { files: applied.paths, notes: code.notes.slice(0, 3000), rejectedPaths: applied.rejected }),
      },
      ...(phase === "revise" && code.responses.length
        ? [
            {
              kind: "answer" as const,
              title: `Architect answered the review: ${accepted} accepted, ${rejected.length} rejected${rejected.length ? ` (${rejected.map((r) => r.id).join(", ")})` : ""}`,
              detail: ev("architect", { responses: code.responses }),
            },
          ]
        : []),
      ...applied.rejected.map((r) => ({ kind: "error" as const, title: `Not written: ${r.path} — ${r.why}`.slice(0, 380), detail: ev("architect") })),
    ]);
    return finishStep(auth, row.id, { ...patch, pair: s, ...(applied.paths.length ? { last_edit_at: applied.at } : {}), status: "running" });
  }

  if (phase === "review") {
    const review = reviewSchema.parse(data);
    const r = applyReview(s, review);
    s = r.state;
    const next = afterReview(s, review.verdict);
    await addEvents(auth, row.id, [
      {
        kind: "inspect",
        title: `Reviewer, round ${r.round.round}: ${review.verdict === "approve" ? "approved" : "changes requested"} — ${r.round.raised} new finding${r.round.raised === 1 ? "" : "s"}, ${r.round.resolved} resolved, ${r.round.open} open`,
        detail: ev("reviewer", {
          round: r.round.round,
          verdict: review.verdict,
          summary: review.summary,
          findings: s.findings.filter((f) => f.round === r.round.round),
          testAssessment: review.testAssessment,
        }),
      },
    ]);
    if (next.next === "final") return finishStep(auth, row.id, { ...patch, pair: { ...s, phase: "final" }, status: "running" });
    if (next.next === "revise") return finishStep(auth, row.id, { ...patch, pair: { ...s, phase: "revise" }, status: "running" });
    const q = askText(s, next.why);
    await addEvents(auth, row.id, [{ kind: "question", title: q.question.slice(0, 380), detail: { pair: { why: next.why } } }]);
    return finishStep(auth, row.id, { ...patch, pair: { ...s, phase: "revise" }, status: "needs_input", pending: { kind: "question", question: q.question, options: q.options } });
  }

  // final
  const fin = finalSchema.parse(data);
  s = { ...s, final: fin, phase: "done" };
  if (fin.runCommand && !project.runCommand.trim()) await setRunCommand(auth, project.id, fin.runCommand).catch(() => {});
  const open = openFindings(s);
  await addEvents(auth, row.id, [{ kind: "summary", title: `Architect's summary: ${fin.summary}`.slice(0, 380), detail: ev("architect", { final: fin }) }]);
  return finishStep(
    auth,
    row.id,
    { ...patch, pair: s, status: "completed", pending: null, summary: fin.summary },
    open.map((f) => `${f.id} [${f.severity}] ${f.title}`),
  );
}

/** Apply the Architect's files through the controlled path: checked paths and sizes, a checkpoint first, changes recorded. */
async function applyCode(auth: Authed, row: RunRow, code: { files: { path: string; content: string }[]; delete: string[] }, label: string) {
  const current = new Map((await getFiles(auth, row.project_id)).map((f) => [f.path, f.content]));
  const { ok, rejected } = checkPaths([...code.files.map((f) => f.path), ...code.delete], validProjectPath, isSecretPath);
  const allowed = new Set(ok);
  const changes: FileChange[] = [];
  for (const f of code.files) {
    if (!allowed.has(f.path)) continue;
    if (byteLength(f.content) > MAX_FILE_BYTES) {
      rejected.push({ path: f.path, why: "over 200 KB" });
      continue;
    }
    if (current.get(f.path) === f.content) continue;
    changes.push({ path: f.path, before: current.get(f.path) ?? null, after: f.content });
  }
  for (const p of code.delete) if (allowed.has(p) && current.has(p)) changes.push({ path: p, before: current.get(p)!, after: null });
  if (changes.length) {
    await createCheckpoint(auth, row.id, label.slice(0, 120), Object.fromEntries(changes.map((c) => [c.path, c.before])));
    for (const r of await saveChanges(auth, row.id, row.project_id, changes, { agent: codeAgentId(row) })) rejected.push({ path: r.path, why: `blocked by Orbis Bastion: ${r.reason}` });
  }
  return { paths: changes.map((c) => c.path), rejected, at: new Date().toISOString() };
}

/** Run the plan's test command in the project's computer when it's on and the command is safe; anything else waits or is skipped, with the reason. */
async function testStep(auth: Authed, row: RunRow, s: PairState): Promise<RunRow> {
  const command = s.plan?.testCommand?.trim() ?? "";
  const skip = async (why: string) => {
    const t: PairTestRun = { command, round: s.round + 1, exitCode: null, passed: null, outputTail: "", ranAt: new Date().toISOString(), skipped: why };
    await addEvents(auth, row.id, [{ kind: "status", title: `Tests not run: ${why}`.slice(0, 380), detail: { pair: { phase: "test" } } }]);
    return finishStep(auth, row.id, { steps: row.steps + 1, pair: { ...s, tests: [...s.tests, t].slice(-20), phase: "review" }, status: "running" });
  };
  if (!command) return skip("the plan has no test command");
  if (!(await optionalBox(auth, row.project_id))) return skip("the project's computer is off (start it to let the agents run tests)");
  const decision = classifyCommand(command);
  if (decision.kind === "block") return skip(`Orbis won't run it: ${decision.reason}`);
  const g = await bastionGuard({ db: auth.supabase, userId: auth.user.id, kind: "agent", agent: codeAgentId(row), runId: row.id }, commandOp(command), command);
  if (g.outcome === "deny") return skip(`blocked by Orbis Bastion: ${g.reason}`);
  if (decision.kind === "ask" || g.outcome === "needs_approval") {
    const reason = decision.kind === "ask" ? decision.reason : `${g.reason} (Orbis Bastion)`;
    await addEvents(auth, row.id, [{ kind: "approval", title: `Waiting for your approval to run the tests: ${command}`.slice(0, 380), detail: { command, reason } }]);
    return finishStep(auth, row.id, { pair: s, status: "awaiting_approval", pending: { kind: "command", command, reason } });
  }
  return runTests(auth, row, s, command);
}

async function runTests(auth: Authed, row: RunRow, s: PairState, command: string, steps = row.steps + 1, approved = false): Promise<RunRow> {
  const out = await execCommand(auth, row.id, row.project_id, command, undefined, { agent: codeAgentId(row), approved });
  if (out.blocked) {
    const t: PairTestRun = { command, round: s.round + 1, exitCode: null, passed: null, outputTail: "", ranAt: new Date().toISOString(), skipped: `blocked by Orbis Bastion: ${out.blocked}`.slice(0, 300) };
    await addEvents(auth, row.id, [commandEvent(command, out)]);
    return finishStep(auth, row.id, { steps, pair: { ...s, tests: [...s.tests, t].slice(-20), phase: "review" }, status: "running", pending: null });
  }
  const test = testResult({ command, ...out });
  const t: PairTestRun = {
    command,
    round: s.round + 1,
    exitCode: out.exitCode,
    passed: test.verdict === "passed",
    outputTail: out.output.slice(-3_000),
    ranAt: new Date().toISOString(),
    ...(out.cancelled ? { skipped: "stopped" } : {}),
  };
  await addEvents(auth, row.id, [commandEvent(command, out, test)]);
  return finishStep(auth, row.id, { steps, pair: { ...s, tests: [...s.tests, t].slice(-20), phase: "review" }, tests: addTests(row.tests, [test]), status: "running", pending: null });
}

/**
 * The user's answer while a pair task waits: approve or change the plan, approve or decline running the
 * tests, or decide what happens when the rounds are used up (accept, one more round, or instructions).
 */
export async function pairRespond(auth: Authed, row: RunRow, input: { decision: string; text?: string }): Promise<RunRow> {
  const s = row.pair!;
  const text = input.text?.trim() ?? "";
  const pending = row.pending;
  const done = async (patch: RunPatch, events: Parameters<typeof addEvents>[2]) => {
    await addEvents(auth, row.id, events);
    return finishStep(auth, row.id, { pending: null, ...patch });
  };
  if (pending?.kind === "plan") {
    if (input.decision === "approve")
      return done(
        {
          status: "running",
          plan: row.plan ? { ...row.plan, approved: true } : null,
          pair: { ...s, phase: "implement", notes: text ? [...s.notes, { at: new Date().toISOString(), text, used: false }] : s.notes },
        },
        [{ kind: "approval", title: "You approved the plan" }],
      );
    if (input.decision === "reject") {
      if (!text) throw new ApiError("bad_request", "Say what should change in the plan.");
      return done({ status: "planning", pair: { ...s, phase: "plan", notes: [...s.notes, { at: new Date().toISOString(), text: `Change the plan: ${text}`, used: false }] } }, [
        { kind: "answer", title: `You asked for plan changes: ${text.slice(0, 300)}` },
      ]);
    }
  }
  if (pending?.kind === "command") {
    if (input.decision === "approve") {
      await addEvents(auth, row.id, [{ kind: "approval", title: `You approved running the tests: ${pending.command.slice(0, 200)}` }]);
      if (!(await optionalBox(auth, row.project_id))) throw new ApiError("conflict", "The project's computer isn't running. Start it first.", { scope: "workspace_stopped" });
      // Approving isn't a step of its own: the test run is counted with the step that asked.
      return runTests(auth, row, s, pending.command, row.steps, true);
    }
    if (input.decision === "reject") {
      const t: PairTestRun = { command: pending.command, round: s.round + 1, exitCode: null, passed: null, outputTail: "", ranAt: new Date().toISOString(), skipped: "you declined to run it" };
      return done({ status: "running", pair: { ...s, tests: [...s.tests, t], phase: "review" } }, [{ kind: "approval", title: `You declined running the tests: ${pending.command.slice(0, 200)}` }]);
    }
  }
  if (pending?.kind === "question") {
    if (/^accept the result/i.test(text)) return done({ status: "running", pair: { ...s, phase: "final" } }, [{ kind: "answer", title: "You accepted the result as it is" }]);
    if (/^one more round/i.test(text))
      return done({ status: "running", pair: { ...s, phase: "revise", stalled: 0, settings: { ...s.settings, maxRounds: s.round + 1 } } }, [{ kind: "answer", title: "You allowed one more round" }]);
    if (text)
      return done(
        {
          status: "running",
          pair: { ...s, phase: "revise", stalled: 0, settings: { ...s.settings, maxRounds: s.round + 1 }, notes: [...s.notes, { at: new Date().toISOString(), text, used: false }] },
        },
        [{ kind: "answer", title: `Your instructions for the Architect: ${text.slice(0, 300)}` }],
      );
    throw new ApiError("bad_request", "Choose an option or type instructions.");
  }
  if (pending?.kind === "limit" && input.decision === "continue") {
    return done({ status: "running", step_limit: row.step_limit + 20, token_budget: row.token_budget + 300_000, time_limit_ms: Number(row.time_limit_ms) + 900_000 }, [
      { kind: "approval", title: "You let the agents keep going" },
    ]);
  }
  throw new ApiError("conflict", "This task isn't waiting for that answer.");
}

/** Instructions sent while the agents work: kept in the activity log and given to the next agent call. */
export async function addPairNote(auth: Authed, row: RunRow, text: string): Promise<void> {
  await addEvents(auth, row.id, [{ kind: "answer", title: `Your instructions: ${text.slice(0, 300)}`, detail: { pairNote: true, text: text.slice(0, 4000) } }]);
}
