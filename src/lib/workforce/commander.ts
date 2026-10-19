import { AGENTS, agentById, agentVersions } from "./agents";
import { executorFor, failureSignature, noUsage, type ExecContext, type ExecResult, type Usage } from "./executors";
import type { ModelRunner } from "./models";
import { PROMPT_VERSION } from "./prompts";
import { redact } from "./redact";
import { buildReport } from "./report";
import { AUTONOMY_RANK, type WorkforceSettings } from "./settings";
import type { NewStep, NewTask, WorkforceStore } from "./store";
import { ACTIVE_STATUSES, TERMINAL_STATUSES, type Autonomy, type CheckResult, type Step, type Task, type TaskStatus } from "./types";
import type { WorkspaceFactory } from "./workspace";

/**
 * Nova Commander — the orchestrator. Tasks advance in bounded "ticks" under a
 * lease, so a task survives function restarts and is never run by two
 * workers at once. All state lives in the store; nothing depends on chat
 * history or memory of a previous request.
 */
export interface Runtime {
  store: WorkforceStore;
  models: ModelRunner;
  workspaces: WorkspaceFactory;
}

export class WorkforceError extends Error {
  constructor(
    message: string,
    readonly code: "bad_request" | "not_found" | "forbidden" | "conflict" = "bad_request",
  ) {
    super(message);
  }
}

const MODEL_AGENTS = new Set(AGENTS.filter((a) => a.kind !== "deterministic").map((a) => a.id));
const isoNow = () => new Date().toISOString();

/* ------------------------------------------------------------ creation */

export interface CreateTaskInput {
  projectId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  priority: Task["priority"];
  autonomy: Autonomy;
  budgetUsd?: number;
  tokenBudget?: number;
  benchmark?: string | null;
}

export async function createTask(rt: Runtime, input: CreateTaskInput): Promise<Task> {
  const settings = await rt.store.getSettings();
  const project = await rt.store.getProject(input.projectId);
  if (!project) throw new WorkforceError("Project not found.", "not_found");
  if (AUTONOMY_RANK[input.autonomy] > AUTONOMY_RANK[settings.maxAutonomy]) throw new WorkforceError(`Autonomy "${input.autonomy}" is above the allowed maximum ("${settings.maxAutonomy}") in Workforce settings.`, "forbidden");
  const budget = input.budgetUsd ?? settings.defaultBudgetUsd;
  if (budget > settings.maxBudgetUsd) throw new WorkforceError(`Budget is above the maximum of $${settings.maxBudgetUsd}.`);
  if (!project.checks.some((c) => c.required) && input.autonomy !== "assist") throw new WorkforceError("This project has no required checks, so changes couldn't be verified. Add checks in the project settings, or use Assist mode.");
  const t: NewTask = {
    project_id: project.id,
    title: input.title,
    objective: input.objective,
    acceptance_criteria: input.acceptanceCriteria,
    priority: input.priority,
    risk: "medium",
    autonomy: input.autonomy,
    budget_usd: budget,
    token_budget: input.tokenBudget ?? settings.defaultTokenBudget,
    benchmark: input.benchmark ?? null,
    versions: { ...agentVersions(), prompts: PROMPT_VERSION },
  };
  const task = await rt.store.createTask(t);
  await rt.store.addEvent({ task_id: task.id, level: "audit", type: "task.created", message: `Task created (${input.autonomy} mode, budget $${budget.toFixed(2)})`, data: { autonomy: input.autonomy } });
  return task;
}

/* ----------------------------------------------------------------- tick */

export interface TickResult {
  task: Task;
  steps: Step[];
  ran: string[];
  note: string | null;
}

export async function advance(rt: Runtime, taskId: string, opts: { budgetMs?: number; signal?: AbortSignal } = {}): Promise<TickResult> {
  const budgetMs = opts.budgetMs ?? 240_000;
  const started = Date.now();
  const leaseId = crypto.randomUUID();
  const settings = await rt.store.getSettings();
  let task = await rt.store.getTask(taskId);
  if (!task) throw new WorkforceError("Task not found.", "not_found");
  const view = async (note: string | null, ran: string[] = []): Promise<TickResult> => ({ task: (await rt.store.getTask(taskId))!, steps: await rt.store.listSteps(taskId), ran, note });

  if (TERMINAL_STATUSES.includes(task.status) && !task.cancel_requested) return view(null);
  if (settings.emergencyStop && !task.cancel_requested) return view("Emergency stop is on. No agent work runs until an operator turns it off.");
  if (!(await rt.store.acquireLease(taskId, leaseId, budgetMs + 50_000))) return view("Another worker is advancing this task.");

  const log = (type: string, message: string, data: Record<string, unknown> = {}, level: "info" | "warn" | "error" | "audit" = "info", stepKey: string | null = null) =>
    rt.store.addEvent({ task_id: taskId, step_key: stepKey, level, type, message: redact(message), data });

  const ran: string[] = [];
  try {
    task = (await rt.store.getTask(taskId))!;
    const project = await rt.store.getProject(task.project_id);
    if (!project) throw new WorkforceError("The task's project no longer exists.", "not_found");

    if (task.cancel_requested && task.status !== "cancelled") {
      await cancelNow(rt, task, "Cancelled by the operator.");
      return view("Cancelled.");
    }
    if (["paused", "awaiting_approval", "needs_attention", "failed", "completed", "cancelled", "blocked"].includes(task.status) && !(await hasActionableWork(rt, task))) return view(null);

    if (task.status === "created") {
      const active = await rt.store.listTasks({ statuses: ACTIVE_STATUSES.filter((s) => s !== "created") });
      if (active.filter((t) => t.id !== task!.id).length >= settings.maxConcurrentTasks) {
        await rt.store.updateTask(taskId, { status_reason: `Queued: ${settings.maxConcurrentTasks} task(s) already running.` });
        return view("Queued behind other running tasks.");
      }
      const avail = rt.workspaces.available();
      if (!avail.ok) {
        await setStatus(rt, task, "blocked", avail.reason);
        await log("workspace.unavailable", avail.reason, {}, "error");
        return view(avail.reason);
      }
      const v = agentVersions();
      const phase1: NewStep[] = [
        step(taskId, "prepare", "devops", "Prepare isolated workspace", [], { max: 2 }, v),
        step(taskId, "map", "archaeologist", "Map relevant code", ["prepare"], {}, v),
        step(taskId, "plan", "architect", "Plan the change", ["map"], {}, v),
      ];
      if (task.autonomy !== "assist") phase1.push(step(taskId, "baseline", "qa_hunter", "Baseline checks before changes", ["prepare"], { max: 1 }, v), step(taskId, "gate-plan", "commander", "Plan approval", ["plan"], { max: 1 }, v));
      await rt.store.createSteps(phase1);
      task = (await rt.store.updateTask(taskId, { status: "analyzing", status_reason: null, started_at: isoNow(), sandbox_name: task.sandbox_name ?? `wf-${taskId.slice(0, 8)}-1` }))!;
      await log("task.started", `Commander started the task: ${phase1.map((s) => s.key).join(", ")}`, {}, "audit");
    }

    // Main loop: run ready steps until nothing is ready or the tick budget is spent.
    for (let round = 0; round < 25; round++) {
      if (opts.signal?.aborted) break;
      task = (await rt.store.getTask(taskId))!;
      if (task.cancel_requested) {
        await cancelNow(rt, task, "Cancelled by the operator.");
        return view("Cancelled.", ran);
      }
      const steps = await rt.store.listSteps(taskId);
      const remaining = budgetMs - (Date.now() - started);
      if (remaining < 8_000) break;

      const ready = steps.filter((s) => (s.status === "pending" || s.status === "running") && depsDone(s, steps));
      if (!ready.length) break;
      // At most one model-using step at a time so budget checks stay exact; checks can run alongside.
      const batch: Step[] = [];
      let modelStep = false;
      for (const s of ready.sort((a, b) => order(a) - order(b))) {
        if (batch.length >= settings.maxParallelSteps) break;
        if (MODEL_AGENTS.has(s.agent) && s.key !== "gate-plan") {
          if (modelStep) continue;
          if (remaining < 60_000 && s.status === "pending") continue; // don't start a long model call at the end of a tick
          modelStep = true;
        }
        batch.push(s);
      }
      if (!batch.length) break;

      const disabled = batch.find((s) => settings.disabledAgents.includes(s.agent));
      if (disabled) {
        await rt.store.updateStep(disabled.id, { status: "blocked", error: `${agentById(disabled.agent)?.name} is disabled in Workforce settings.` });
        await setStatus(rt, task, "needs_attention", `${agentById(disabled.agent)?.name} is disabled. Enable it, then Retry.`);
        await log("agent.disabled", `Step ${disabled.key} needs ${disabled.agent}, which is disabled`, {}, "warn", disabled.key);
        return view("Blocked by a disabled agent.", ran);
      }

      // Workspace health: recover a lost sandbox by re-preparing it with the stored diff.
      const ws = rt.workspaces(task.sandbox_name ?? `wf-${taskId.slice(0, 8)}-1`);
      const prepared = steps.find((s) => s.key === "prepare")?.status === "succeeded";
      if (prepared && batch.some((s) => s.key !== "gate-plan" && s.key !== "verify") && !(await ws.healthy())) {
        const n = Number((task.sandbox_name ?? "-1").split("-").pop()) + 1;
        const prep = steps.find((s) => s.key === "prepare")!;
        await rt.store.updateStep(prep.id, { status: "pending", attempt: 0, output: null, state: {}, error: null });
        for (const s of batch) if (s.status === "running") await rt.store.updateStep(s.id, { status: "pending", state: {} });
        await rt.store.updateTask(taskId, { sandbox_name: `wf-${taskId.slice(0, 8)}-${n}` });
        await log("workspace.lost", "The workspace was lost (timeout or restart). Recreating it and restoring the changes made so far.", { attempt: n }, "warn");
        continue;
      }

      const results = await Promise.all(batch.map((s) => runStep(rt, task!, s, steps, project, settings, ws, log, () => budgetMs - (Date.now() - started), opts.signal)));
      ran.push(...batch.map((s) => s.key));
      // Apply usage sequentially so the ledger stays consistent.
      for (const r of results) await applyUsage(rt, taskId, r.step, r.usage);
      for (const r of results) await afterStep(rt, taskId, r.step.key, r.result, settings, log);
      if (results.every((r) => r.result.status === "running" || r.result.status === "waiting")) break;
    }

    await deriveStatus(rt, taskId, settings, log);
    await rt.store.updateTask(taskId, { ticks: (task?.ticks ?? 0) + 1 });
    return view(null, ran);
  } finally {
    await rt.store.releaseLease(taskId, leaseId);
  }
}

function step(taskId: string, key: string, agent: Step["agent"], title: string, deps: string[], o: { max?: number; input?: Record<string, unknown> }, v: Record<string, string>): NewStep {
  return { task_id: taskId, key, agent, agent_version: v[agent] ?? "1.0.0", title, depends_on: deps, max_attempts: o.max ?? (agentById(agent)?.limits.maxAttempts ?? 2), input: o.input ?? {} };
}

const ORDER = ["prepare", "baseline", "map", "plan", "gate-plan", "build", "test", "repair", "security", "buildcheck", "review", "verify"];
const order = (s: Step) => ORDER.indexOf(s.key.replace(/-\d+$/, ""));

function depsDone(s: Step, steps: Step[]) {
  return s.depends_on.every((d) => {
    const dep = steps.find((x) => x.key === d);
    return dep && (dep.status === "succeeded" || dep.status === "skipped");
  });
}

async function hasActionableWork(rt: Runtime, task: Task) {
  if (task.status === "awaiting_approval") {
    const gate = (await rt.store.listSteps(task.id)).find((s) => s.key === "gate-plan");
    const approvals = await rt.store.listApprovals({ taskId: task.id });
    return approvals.some((a) => a.kind === "plan" && a.payload_hash === task.plan_hash && a.status !== "pending") || gate?.status === "pending";
  }
  return false;
}

async function runStep(
  rt: Runtime,
  task: Task,
  s: Step,
  steps: Step[],
  project: NonNullable<Awaited<ReturnType<WorkforceStore["getProject"]>>>,
  settings: WorkforceSettings,
  ws: ReturnType<WorkspaceFactory>,
  log: (type: string, message: string, data?: Record<string, unknown>, level?: "info" | "warn" | "error" | "audit", stepKey?: string | null) => Promise<void>,
  remainingMs: () => number,
  signal?: AbortSignal,
): Promise<{ step: Step; result: ExecResult; usage: Usage }> {
  const exec = executorFor(s.key);
  const agent = agentById(s.agent);
  let current = s;
  if (s.status === "pending") {
    current = (await rt.store.updateStep(s.id, { status: "running", attempt: s.attempt + 1, started_at: isoNow(), error: null }))!;
    await log("step.started", `${agent?.name ?? s.agent} started: ${s.title}${s.attempt ? ` (attempt ${s.attempt + 1})` : ""}`, { agent: s.agent, version: s.agent_version }, "info", s.key);
  }
  const timeout = agent?.limits.timeoutMs ? Math.min(agent.limits.timeoutMs, settings.stepTimeoutMs) : settings.stepTimeoutMs;
  if (current.started_at && Date.now() - new Date(current.started_at).getTime() > timeout + (s.key.match(/^(baseline|test|buildcheck|prepare)/) ? settings.stepTimeoutMs : 0)) {
    return { step: current, result: { status: "failed", error: `Timed out after ${Math.round(timeout / 1000)}s.`, retryable: true }, usage: noUsage() };
  }
  if (!exec) return { step: current, result: { status: "failed", error: `No executor for ${s.key}.`, retryable: false }, usage: noUsage() };
  const ctx: ExecContext = { store: rt.store, task, step: current, steps, project, settings, ws, models: rt.models, signal: signal ?? new AbortController().signal, log: (t, m, d, l) => log(t, m, d, l, s.key), remainingMs };
  let result: ExecResult;
  try {
    result = await exec(ctx);
  } catch (err) {
    const msg = redact((err as Error).message ?? String(err)).slice(0, 1500);
    result = { status: "failed", error: msg, retryable: !/no longer exists/.test(msg) };
  }
  const usage = "usage" in result && result.usage ? result.usage : noUsage();
  return { step: current, result, usage };
}

async function applyUsage(rt: Runtime, taskId: string, s: Step, u: Usage) {
  if (!u.calls && !u.inputTokens && !u.outputTokens) return;
  const t = (await rt.store.getTask(taskId))!;
  const fresh = (await rt.store.listSteps(taskId)).find((x) => x.id === s.id)!;
  const tokens = u.inputTokens + u.outputTokens;
  await rt.store.updateStep(s.id, { tokens: fresh.tokens + tokens, cost_usd: u.costUsd === null ? fresh.cost_usd : Number(fresh.cost_usd ?? 0) + u.costUsd, model_id: u.modelId ?? fresh.model_id });
  await rt.store.updateTask(taskId, { tokens_used: t.tokens_used + tokens, spent_usd: Number(t.spent_usd) + (u.costUsd ?? 0), spent_unpriced_calls: t.spent_unpriced_calls + (u.costUsd === null ? u.calls : 0) });
  await rt.store.addEvent({ task_id: taskId, step_key: s.key, type: "model.call", message: `${u.calls} model call(s) on ${u.modelId}: ${tokens.toLocaleString("en-US")} tokens${u.costUsd !== null ? `, ≈ $${u.costUsd.toFixed(4)}` : ", cost unknown"}`, data: { ...u } });
}

/** Record a step's result and extend the graph according to it. */
async function afterStep(rt: Runtime, taskId: string, key: string, r: ExecResult, settings: WorkforceSettings, log: (type: string, message: string, data?: Record<string, unknown>, level?: "info" | "warn" | "error" | "audit", stepKey?: string | null) => Promise<void>) {
  const steps = await rt.store.listSteps(taskId);
  const s = steps.find((x) => x.key === key)!;
  const task = (await rt.store.getTask(taskId))!;
  const v = agentVersions();
  const agentName = agentById(s.agent)?.name ?? s.agent;

  if (r.status === "running") {
    await rt.store.updateStep(s.id, { state: r.state });
    return;
  }
  if (r.status === "waiting") {
    if (r.approval) {
      await rt.store.createApproval({ ...r.approval, task_id: taskId });
      await log("approval.requested", `Approval requested: ${r.approval.title}`, { kind: r.approval.kind, risk: r.approval.risk }, "audit", key);
    }
    await rt.store.updateStep(s.id, { status: "pending", attempt: Math.max(0, s.attempt - 1), state: { ...s.state, waiting: r.reason } });
    return;
  }
  if (r.status === "blocked") {
    await rt.store.updateStep(s.id, { status: "blocked", error: r.reason, attempt: Math.max(0, s.attempt - 1) });
    if (r.approval) {
      const existing = (await rt.store.listApprovals({ taskId })).find((a) => a.payload_hash === r.approval!.payload_hash);
      if (!existing) await rt.store.createApproval({ ...r.approval, task_id: taskId });
    }
    await log("step.blocked", `${agentName} blocked: ${r.reason}`, {}, "warn", key);
    return;
  }
  if (r.status === "skipped") {
    await rt.store.updateStep(s.id, { status: "skipped", error: r.reason, finished_at: isoNow() });
    await log("step.skipped", `${agentName} skipped: ${r.reason}`, {}, "info", key);
  } else if (r.status === "failed") {
    if (r.retryable && s.attempt < s.max_attempts) {
      await rt.store.updateStep(s.id, { status: "pending", error: r.error, state: { feedback: r.error } });
      await log("step.retry", `${agentName} failed (attempt ${s.attempt}/${s.max_attempts}); retrying: ${r.error}`, {}, "warn", key);
      return;
    }
    await rt.store.updateStep(s.id, { status: "failed", error: r.error, finished_at: isoNow() });
    await log("step.failed", `${agentName} failed: ${r.error}`, {}, "error", key);
    if (key === "gate-plan") return; // handled by deriveStatus (rejected plan)
    return;
  } else {
    await rt.store.updateStep(s.id, { status: "succeeded", output: r.output, finished_at: isoNow(), error: null, state: {} });
    if (r.taskPatch) await rt.store.updateTask(taskId, r.taskPatch);
    await log("step.succeeded", `${agentName} finished: ${s.title}`, {}, "info", key);
  }

  // Graph extension.
  const ensure = async (key2: string, agent: Step["agent"], title: string, deps: string[]) => {
    const existing = steps.find((x) => x.key === key2);
    if (!existing) await rt.store.createSteps([step(taskId, key2, agent, title, deps, {}, v)]);
    else await rt.store.updateStep(existing.id, { status: "pending", depends_on: deps, attempt: 0, output: null, state: {}, error: null, started_at: null, finished_at: null });
  };
  const nextN = (prefix: string) => Math.max(0, ...steps.filter((x) => x.key.startsWith(`${prefix}-`)).map((x) => Number(x.key.split("-")[1]) || 0)) + 1;
  const base = key.replace(/-\d+$/, "");

  if (key === "plan" && task.autonomy === "assist" && r.status === "succeeded") return; // finalised in deriveStatus
  if (key === "gate-plan" && r.status === "succeeded") await ensure("build", "builder", "Implement the plan", ["gate-plan", "baseline"]);
  if (key === "build" && r.status === "succeeded") {
    const n = nextN("test");
    await ensure(`test-${n}`, "qa_hunter", `Run checks (round ${n})`, ["build"]);
    await ensure("security", "sentinel", "Security review of the change", ["build"]);
  }
  if (base === "repair") {
    const n = nextN("test");
    await ensure(`test-${n}`, "qa_hunter", `Run checks (round ${n})`, [key]);
  }
  if (base === "test" && r.status === "succeeded") {
    const out = r.output as { newFailures: string[]; results: CheckResult[]; signature: string };
    const repairsUsed = steps.filter((x) => x.key.startsWith("repair-")).length;
    const prevTest = steps.filter((x) => x.key.startsWith("test-") && x.key !== key && x.status === "succeeded").sort((a, b) => Number(b.key.slice(5)) - Number(a.key.slice(5)))[0];
    const sameAsBefore = prevTest && (prevTest.output as { signature?: string } | null)?.signature === out.signature;
    if (out.newFailures.length) {
      if (sameAsBefore) await log("repair.stopped", "Self-Heal stopped: the same failure repeated after a repair attempt.", {}, "warn", key);
      else if (repairsUsed >= settings.maxRepairAttempts) await log("repair.stopped", `Self-Heal stopped: repair limit (${settings.maxRepairAttempts}) reached.`, {}, "warn", key);
      else if (settings.disabledAgents.includes("self_heal")) await log("repair.stopped", "Self-Heal is disabled.", {}, "warn", key);
      else {
        const n = Number(key.split("-")[1]);
        await ensure(`repair-${n}`, "self_heal", `Repair failures from round ${n}`, [key]);
        return;
      }
    }
    await ensure("review", "reviewer", "Independent review", [key, "security"]);
    const deps = ["review", "security"];
    if (settings.runBuildCheck && !out.newFailures.length) {
      await ensure("buildcheck", "devops", "Production build check", [key]);
      deps.push("buildcheck");
    } else {
      const bc = steps.find((x) => x.key === "buildcheck");
      if (bc) await rt.store.updateStep(bc.id, { status: "skipped", error: out.newFailures.length ? "Skipped: required checks are failing." : "Build check disabled." });
    }
    await ensure("verify", "commander", "Verify against acceptance criteria", deps);
  }
}

/** Decide the task's status from its steps, and finalise when done. */
async function deriveStatus(rt: Runtime, taskId: string, settings: WorkforceSettings, log: (type: string, message: string, data?: Record<string, unknown>, level?: "info" | "warn" | "error" | "audit", stepKey?: string | null) => Promise<void>) {
  const task = (await rt.store.getTask(taskId))!;
  if (TERMINAL_STATUSES.includes(task.status) || task.status === "paused") return;
  const steps = await rt.store.listSteps(taskId);
  const get = (k: string) => steps.find((s) => s.key === k);

  const failed = steps.find((s) => s.status === "failed");
  if (failed) {
    if (failed.key === "gate-plan") {
      await setStatus(rt, task, "cancelled", failed.error ?? "Plan rejected.");
      await finalize(rt, task.id, { stop: true });
      return;
    }
    await setStatus(rt, task, "failed", `${agentById(failed.agent)?.name ?? failed.agent} failed on "${failed.title}": ${failed.error}`);
    await finalize(rt, task.id, { stop: true });
    return;
  }
  const blocked = steps.find((s) => s.status === "blocked");
  if (blocked) {
    await setStatus(rt, task, "needs_attention", blocked.error ?? "A step is blocked.");
    return;
  }
  if (task.autonomy === "assist" && get("plan")?.status === "succeeded") {
    await rt.store.updateTask(taskId, { report: buildReport(task, steps, null, { analysisOnly: true }) });
    await setStatus(rt, task, "completed", "Analysis and plan complete (Assist mode makes no changes).");
    await finalize(rt, task.id, { stop: true, memory: true });
    return;
  }
  const verifyStep = get("verify");
  if (verifyStep?.status === "succeeded") {
    const v = task.verification;
    await rt.store.updateTask(taskId, { report: buildReport(task, steps, v) });
    if (v?.verdict === "verified") await setStatus(rt, task, "completed", "Verified: all required checks, the review and the security gate passed.");
    else await setStatus(rt, task, "needs_attention", `Not verified: ${v?.reasons.join(" ") ?? "verification incomplete."}`);
    await finalize(rt, task.id, { stop: true, memory: true });
    await log("task.finished", `Task finished: ${v?.verdict ?? "unknown"}`, { verdict: v?.verdict }, "audit");
    return;
  }
  const gate = get("gate-plan");
  if (gate?.status === "pending" && gate.state.waiting) return void (await setStatus(rt, task, "awaiting_approval", String(gate.state.waiting)));
  if (verifyStep && (verifyStep.status === "running" || (verifyStep.status === "pending" && depsDone(verifyStep, steps)))) return void (await setStatus(rt, task, "verifying", null));
  const phase2 = gate?.status === "succeeded";
  const anyOpen = steps.some((s) => s.status === "pending" || s.status === "running");
  if (!anyOpen) {
    await setStatus(rt, task, "needs_attention", "No step can run. Check the graph or Retry.");
    return;
  }
  await setStatus(rt, task, phase2 ? "running" : get("plan")?.status === "succeeded" ? "planned" : "analyzing", null);
}

async function setStatus(rt: Runtime, task: Task, status: TaskStatus, reason: string | null) {
  if (task.status === status && task.status_reason === reason) return;
  await rt.store.updateTask(task.id, { status, status_reason: reason, ...(TERMINAL_STATUSES.includes(status) ? { finished_at: isoNow() } : {}) });
  if (task.status !== status) await rt.store.addEvent({ task_id: task.id, level: "audit", type: "task.status", message: `Status: ${task.status} → ${status}${reason ? ` (${reason})` : ""}`, data: { from: task.status, to: status } });
}

async function finalize(rt: Runtime, taskId: string, o: { stop?: boolean; memory?: boolean }) {
  const task = (await rt.store.getTask(taskId))!;
  if (o.memory) {
    const verified = task.verification?.verdict === "verified";
    const content = [`${task.title}: ${task.plan?.summary ?? task.objective.slice(0, 300)}`, task.changed_files.length ? `Files changed: ${task.changed_files.slice(0, 12).join(", ")}` : "", `Outcome: ${task.status === "completed" ? (verified ? "verified" : "analysis only") : "not verified"}`].filter(Boolean).join("\n");
    await rt.store.addMemory({ project_id: task.project_id, task_id: task.id, kind: "project_knowledge", content: content.slice(0, 8000), source: `workforce task ${task.id.slice(0, 8)}`, verified, expires_at: null });
  }
  if (o.stop && task.sandbox_name) {
    try {
      const r = await rt.workspaces(task.sandbox_name).stop();
      await rt.store.updateTask(taskId, { sandbox_ms: Number(task.sandbox_ms) + (r.activeMs ?? 0) });
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------- operator actions */

export async function cancelNow(rt: Runtime, task: Task, reason: string) {
  const steps = await rt.store.listSteps(task.id);
  const ws = task.sandbox_name ? rt.workspaces(task.sandbox_name) : null;
  for (const s of steps.filter((x) => x.status === "running" || x.status === "pending" || x.status === "blocked")) {
    const handle = (s.state as { handle?: string | null }).handle;
    if (handle && ws) await ws.killCheck(handle).catch(() => {});
    await rt.store.updateStep(s.id, { status: "cancelled", finished_at: isoNow() });
  }
  for (const a of await rt.store.listApprovals({ taskId: task.id, status: "pending" })) await rt.store.updateApproval(a.id, { status: "expired" });
  await setStatus(rt, task, "cancelled", reason);
  await rt.store.updateTask(task.id, { cancel_requested: false });
  await finalize(rt, task.id, { stop: true });
}

export async function requestCancel(rt: Runtime, taskId: string) {
  const t = await rt.store.getTask(taskId);
  if (!t) throw new WorkforceError("Task not found.", "not_found");
  if (TERMINAL_STATUSES.includes(t.status)) throw new WorkforceError("The task has already finished.");
  await rt.store.updateTask(taskId, { cancel_requested: true });
  await rt.store.addEvent({ task_id: taskId, level: "audit", type: "task.cancel_requested", message: "Cancellation requested. Running checks are stopped; a model call already in progress finishes but its result is discarded." });
  // If no worker holds the lease, cancel right away.
  const leaseId = crypto.randomUUID();
  if (await rt.store.acquireLease(taskId, leaseId, 30_000)) {
    try {
      await cancelNow(rt, (await rt.store.getTask(taskId))!, "Cancelled by the operator.");
    } finally {
      await rt.store.releaseLease(taskId, leaseId);
    }
  }
}

export async function decideApproval(rt: Runtime, approvalId: string, decision: "approved" | "rejected", note: string | null, expectedHash: string) {
  const approval = (await rt.store.listApprovals()).find((a) => a.id === approvalId);
  if (!approval) throw new WorkforceError("Approval not found.", "not_found");
  if (approval.status !== "pending") throw new WorkforceError(`This approval was already ${approval.status}.`, "conflict");
  if (approval.payload_hash !== expectedHash) throw new WorkforceError("The request changed since you viewed it. Reload and review it again.", "conflict");
  const task = (await rt.store.getTask(approval.task_id))!;
  if (approval.kind === "plan" && task.plan_hash !== approval.payload_hash) {
    await rt.store.updateApproval(approval.id, { status: "expired" });
    throw new WorkforceError("This plan is out of date; a newer plan replaced it.", "conflict");
  }
  await rt.store.updateApproval(approval.id, { status: decision, decided_at: isoNow(), decision_note: note });
  await rt.store.addEvent({ task_id: task.id, level: "audit", type: `approval.${decision}`, message: `${approval.title}: ${decision}${note ? ` — ${note}` : ""}`, data: { approvalId, kind: approval.kind, hash: approval.payload_hash } });
  const steps = await rt.store.listSteps(task.id);
  if (approval.kind === "budget" && decision === "approved") {
    const p = approval.payload as { budgetUsd: number; tokenBudget: number };
    const settings = await rt.store.getSettings();
    await rt.store.updateTask(task.id, { budget_usd: Math.min(p.budgetUsd, settings.maxBudgetUsd), token_budget: p.tokenBudget });
    for (const s of steps.filter((x) => x.status === "blocked")) await rt.store.updateStep(s.id, { status: "pending", error: null });
    await setStatus(rt, task, "running", null);
  }
  if (approval.kind === "plan" && decision === "rejected" && note) {
    // Rejection with feedback means "re-plan": the architect tries again with the note.
    const plan = steps.find((s) => s.key === "plan")!;
    const gate = steps.find((s) => s.key === "gate-plan")!;
    await rt.store.updateStep(plan.id, { status: "pending", attempt: 0, output: null, state: { feedback: note } });
    await rt.store.updateStep(gate.id, { status: "pending", attempt: 0, state: {} });
    await rt.store.updateTask(task.id, { plan: null, plan_hash: null });
    await setStatus(rt, task, "analyzing", "Re-planning with the operator's feedback.");
  }
  return approval;
}

/** Retry failed/blocked steps (within new attempt allowances). */
export async function retryTask(rt: Runtime, taskId: string) {
  const task = await rt.store.getTask(taskId);
  if (!task) throw new WorkforceError("Task not found.", "not_found");
  if (!["failed", "needs_attention", "blocked"].includes(task.status)) throw new WorkforceError("Only failed, blocked or attention-needed tasks can be retried.");
  const steps = await rt.store.listSteps(taskId);
  const retryable = steps.filter((s) => s.status === "failed" || s.status === "blocked");
  if (!retryable.length && task.status !== "blocked") throw new WorkforceError("Nothing to retry. Use Rework to send the change back to the builder.");
  for (const s of retryable) await rt.store.updateStep(s.id, { status: "pending", attempt: 0, error: null, state: {} });
  const prep = steps.find((s) => s.key === "prepare");
  if (prep?.status === "succeeded" && task.status !== "blocked") {
    // Stop the old workspace (a blocked task keeps it running) and recreate it from the stored diff.
    await rt.store.updateStep(prep.id, { status: "pending", attempt: 0, output: null, state: {} });
    await finalize(rt, taskId, { stop: true });
    const n = Number((task.sandbox_name ?? "-1").split("-").pop()) + 1;
    await rt.store.updateTask(taskId, { sandbox_name: `wf-${taskId.slice(0, 8)}-${n}` });
  }
  await rt.store.updateTask(taskId, { status: task.status === "blocked" ? "created" : "running", status_reason: null, finished_at: null });
  await rt.store.addEvent({ task_id: taskId, level: "audit", type: "task.retry", message: `Retry requested for ${retryable.map((s) => s.key).join(", ") || "task start"}` });
}

/** Send the change back to the builder with review feedback (after verification). */
export async function reworkTask(rt: Runtime, taskId: string, note: string) {
  const task = await rt.store.getTask(taskId);
  if (!task) throw new WorkforceError("Task not found.", "not_found");
  if (!["needs_attention", "completed"].includes(task.status) || !task.plan) throw new WorkforceError("Rework is available after verification.");
  const steps = await rt.store.listSteps(taskId);
  const review = steps.find((s) => s.key === "review")?.output as { findings?: { severity: string; issue: string }[] } | undefined;
  const feedback = [note && `Operator: ${note}`, task.verification?.reasons.length ? `Verification problems: ${task.verification.reasons.join(" ")}` : "", review?.findings?.length ? `Review findings: ${review.findings.map((f) => `[${f.severity}] ${f.issue}`).join("; ")}` : ""].filter(Boolean).join("\n");
  for (const s of steps.filter((x) => ["review", "security", "buildcheck", "verify"].includes(x.key))) await rt.store.updateStep(s.id, { status: "skipped", error: "Superseded by rework." });
  const build = steps.find((s) => s.key === "build")!;
  await rt.store.updateStep(build.id, { status: "pending", attempt: 0, output: null, state: { feedback } });
  const prep = steps.find((s) => s.key === "prepare")!;
  await rt.store.updateStep(prep.id, { status: "pending", attempt: 0, output: null, state: {} });
  await finalize(rt, taskId, { stop: true });
  const n = Number((task.sandbox_name ?? "-1").split("-").pop()) + 1;
  await rt.store.updateTask(taskId, { status: "running", status_reason: null, verification: null, report: null, finished_at: null, sandbox_name: `wf-${taskId.slice(0, 8)}-${n}` });
  await rt.store.addEvent({ task_id: taskId, level: "audit", type: "task.rework", message: `Rework requested${note ? `: ${note}` : ""}` });
}

export async function setPaused(rt: Runtime, taskId: string, paused: boolean) {
  const task = await rt.store.getTask(taskId);
  if (!task) throw new WorkforceError("Task not found.", "not_found");
  if (paused) {
    if (!["created", "analyzing", "planned", "running", "verifying"].includes(task.status)) throw new WorkforceError("Only active tasks can be paused.");
    await rt.store.updateTask(taskId, { status: "paused", status_reason: `Paused (was ${task.status}). Running checks continue in the workspace until they finish; no new steps start.` });
  } else {
    if (task.status !== "paused") throw new WorkforceError("The task isn't paused.");
    await rt.store.updateTask(taskId, { status: "running", status_reason: null });
    await deriveStatus(rt, taskId, await rt.store.getSettings(), async () => {});
  }
  await rt.store.addEvent({ task_id: taskId, level: "audit", type: paused ? "task.paused" : "task.resumed", message: paused ? "Paused by the operator." : "Resumed by the operator." });
}

export { failureSignature };
