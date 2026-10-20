import { runCodeRules } from "../security/code-rules";
import { agentById, type AgentDef } from "./agents";
import { highRiskPath, protectedPath } from "./checks";
import { addedLineNumbers, addedLines, keywords, pathsInOutput, planEdits } from "./edits";
import { BudgetError, ModelUnavailableError, OutputInvalidError, structuredCall, type CallResult, type ModelRunner } from "./models";
import { archaeologistMessages, architectMessages, builderMessages, repairMessages, reviewerMessages, securityMessages } from "./prompts";
import { redact, tail } from "./redact";
import { archaeologyOut, editsOut, planOut, repairOut, reviewOut, securityOut, type ArchaeologyOut, type ReviewOut } from "./schemas";
import type { WorkforceSettings } from "./settings";
import type { NewApproval, WorkforceStore } from "./store";
import type { CheckDef, CheckResult, Plan, Project, Step, Task } from "./types";
import type { Workspace } from "./workspace";

/** Everything an executor may use. There is no other way to reach the outside world. */
export interface ExecContext {
  store: WorkforceStore;
  task: Task;
  step: Step;
  steps: Step[];
  project: Project;
  settings: WorkforceSettings;
  ws: Workspace;
  models: ModelRunner;
  signal: AbortSignal;
  log: (type: string, message: string, data?: Record<string, unknown>, level?: "info" | "warn" | "error" | "audit") => Promise<void>;
  /** Milliseconds left in this tick. */
  remainingMs: () => number;
}

export interface Usage {
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  calls: number;
}

export type ExecResult =
  | { status: "succeeded"; output: Record<string, unknown>; usage?: Usage; taskPatch?: Partial<Task> }
  | { status: "running"; state: Record<string, unknown>; detail?: string; usage?: Usage }
  | { status: "failed"; error: string; retryable: boolean; usage?: Usage }
  | { status: "blocked"; reason: string; approval?: Omit<NewApproval, "task_id">; usage?: Usage }
  | { status: "waiting"; reason: string; approval?: Omit<NewApproval, "task_id"> }
  | { status: "skipped"; reason: string };

const noUsage = (): Usage => ({ modelId: null, inputTokens: 0, outputTokens: 0, costUsd: null, calls: 0 });
const fromCall = (r: CallResult<unknown>): Usage => ({ modelId: r.modelId, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, calls: r.calls });

export function sha256Hex(s: string): Promise<string> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)).then((b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""));
}

function modelChoice(ctx: ExecContext, agent: AgentDef): string {
  return ctx.settings.models[agent.id] ?? agent.defaultModel ?? "auto";
}

/** Run a model call and translate budget/model problems into blocked/failed results. */
async function guardModel<T>(ctx: ExecContext, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; result: ExecResult }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof BudgetError) {
      const raise = Math.min(ctx.settings.maxBudgetUsd, Math.max(ctx.task.budget_usd * 2, ctx.task.budget_usd + 1));
      return {
        ok: false,
        result: {
          status: "blocked",
          reason: err.message,
          approval:
            err.kind === "unpriced"
              ? undefined
              : {
                  kind: "budget",
                  title: `Raise budget to $${raise.toFixed(2)} and ${(ctx.task.token_budget * 2).toLocaleString("en-US")} tokens`,
                  reason: err.message,
                  risk: "medium",
                  payload: { budgetUsd: raise, tokenBudget: Math.min(ctx.task.token_budget * 2, 20_000_000) },
                  payload_hash: await sha256Hex(`${ctx.task.id}:budget:${raise}:${ctx.task.token_budget * 2}`),
                },
        },
      };
    }
    if (err instanceof ModelUnavailableError) return { ok: false, result: { status: "blocked", reason: err.message } };
    if (err instanceof OutputInvalidError) {
      const u = (err as unknown as { usage?: Usage }).usage;
      return { ok: false, result: { status: "failed", error: err.message, retryable: true, usage: u ? { ...u, calls: 2 } : undefined } };
    }
    if (ctx.signal.aborted) throw err;
    return { ok: false, result: { status: "failed", error: `Model call failed: ${redact((err as Error).message ?? String(err)).slice(0, 500)}`, retryable: true } };
  }
}

const ledger = (ctx: ExecContext) => ({ spentUsd: ctx.task.spent_usd, budgetUsd: ctx.task.budget_usd, tokensUsed: ctx.task.tokens_used, tokenBudget: ctx.task.token_budget, allowUnpriced: ctx.settings.allowUnpricedModels });

async function readFiles(ws: Workspace, paths: string[], maxFiles = 12, maxTotal = 70_000, perFile = 16_000) {
  const out: { path: string; content: string }[] = [];
  let total = 0;
  for (const p of paths.slice(0, maxFiles)) {
    const c = await ws.readFile(p);
    if (c === null) continue;
    const content = c.length > perFile ? `${c.slice(0, perFile)}\n…(truncated, ${c.length - perFile} more characters)` : c;
    if (total + content.length > maxTotal) break;
    total += content.length;
    out.push({ path: p, content: redact(content) });
  }
  return out;
}

const stepOutput = <T>(steps: Step[], key: string) => steps.find((s) => s.key === key && s.status === "succeeded")?.output as T | undefined;

export function latestTest(steps: Step[]): Step | undefined {
  return steps.filter((s) => /^test-\d+$/.test(s.key) && s.status === "succeeded").sort((a, b) => Number(b.key.slice(5)) - Number(a.key.slice(5)))[0];
}

/* --------------------------------------------------------------- checks */

async function runChecks(ctx: ExecContext, checks: CheckDef[]): Promise<ExecResult> {
  const st = { idx: 0, handle: null as string | null, startedAt: 0, results: [] as CheckResult[], ...(ctx.step.state as object) } as { idx: number; handle: string | null; startedAt: number; results: CheckResult[] };
  while (ctx.remainingMs() > 5_000) {
    if (ctx.signal.aborted) throw new Error("aborted");
    if (st.handle) {
      const check = checks[st.idx]!;
      const r = await ctx.ws.pollCheck(st.handle);
      if (!r.done) {
        const limit = (check.timeoutMs ?? 600_000) + 60_000;
        if (Date.now() - st.startedAt > limit) {
          await ctx.ws.killCheck(st.handle);
          st.results.push({ id: check.id, label: check.label, required: check.required, exitCode: null, passed: false, durationMs: Date.now() - st.startedAt, outputTail: "Timed out.", timedOut: true });
          await ctx.log("check.timeout", `${check.label} timed out`, { check: check.id }, "warn");
          st.idx++;
          st.handle = null;
          continue;
        }
        // Still running: report progress and let the next tick poll again.
        return { status: "running", state: st, detail: `Running ${check.label}` };
      }
      const result: CheckResult = { id: check.id, label: check.label, required: check.required, exitCode: r.exitCode, passed: r.exitCode === 0, durationMs: Date.now() - st.startedAt, outputTail: tail(r.output), timedOut: r.exitCode === 124 };
      st.results.push(result);
      await ctx.log("check.finished", `${check.label}: ${result.passed ? "passed" : `failed (exit ${r.exitCode})`}`, { check: check.id, exitCode: r.exitCode, durationMs: result.durationMs }, result.passed ? "info" : "warn");
      st.idx++;
      st.handle = null;
      continue;
    }
    if (st.idx >= checks.length) return { status: "succeeded", output: { results: st.results } };
    const check = checks[st.idx]!;
    st.handle = await ctx.ws.startCheck(check);
    st.startedAt = Date.now();
    await ctx.log("tool.run", `Running ${check.label}: ${check.commands.map((c) => c.join(" ")).join(" && ")}`, { check: check.id, network: check.network ?? [] });
  }
  return { status: "running", state: st, detail: st.idx < checks.length ? `Running ${checks[st.idx]!.label}` : undefined };
}

/* ------------------------------------------------------------ executors */

type Executor = (ctx: ExecContext) => Promise<ExecResult>;

const prepare: Executor = async (ctx) => {
  const r = await ctx.ws.prepare({ repo: ctx.project.repo, branch: ctx.project.branch, restoreDiff: ctx.task.diff });
  if (!r.ready) return { status: "running", state: { ...ctx.step.state, polls: Number(ctx.step.state.polls ?? 0) + 1 }, detail: r.detail };
  await ctx.log("workspace.ready", `Workspace ready at ${r.baseSha.slice(0, 10)}${ctx.task.diff ? " (earlier changes restored)" : ""}`, { baseSha: r.baseSha });
  return { status: "succeeded", output: { baseSha: r.baseSha, restored: Boolean(ctx.task.diff) } };
};

const map: Executor = async (ctx) => {
  const agent = agentById("archaeologist")!;
  const files = await ctx.ws.listFiles();
  const terms = keywords(`${ctx.task.title} ${ctx.task.objective} ${ctx.task.acceptance_criteria.join(" ")}`);
  const hits = await ctx.ws.grep(terms);
  await ctx.log("tool.run", `Listed ${files.length} files; searched for ${terms.join(", ") || "(no terms)"}`);
  const memory = (await ctx.store.listMemory(ctx.project.id, 8)).map((m) => `[${m.verified ? "verified" : "unverified"} · ${m.created_at.slice(0, 10)} · ${m.source}] ${m.content}`).join("\n");
  const known = new Set(files);
  const call = await guardModel(ctx, () =>
    structuredCall(ctx.models, {
      choice: modelChoice(ctx, agent),
      messages: archaeologistMessages(ctx.task.objective, files.slice(0, 1500), redact(hits), memory),
      schema: archaeologyOut,
      maxOutputTokens: agent.limits.maxOutputTokens,
      ledger: ledger(ctx),
      signal: ctx.signal,
      purpose: "archaeologist",
      validate: (d) => {
        const bad = d.relevantFiles.filter((f) => !known.has(f.path)).map((f) => f.path);
        return bad.length ? `These paths aren't in the file list: ${bad.slice(0, 5).join(", ")}. Only use paths from the list.` : null;
      },
    }),
  );
  if (!call.ok) return call.result;
  return { status: "succeeded", output: { ...call.value.data, fileCount: files.length, searchTerms: terms }, usage: fromCall(call.value) };
};

const plan: Executor = async (ctx) => {
  const agent = agentById("architect")!;
  const map = stepOutput<ArchaeologyOut>(ctx.steps, "map");
  const files = await ctx.ws.listFiles();
  const known = new Set(files);
  const read = await readFiles(ctx.ws, (map?.relevantFiles ?? []).map((f) => f.path));
  const feedback = typeof ctx.step.state.feedback === "string" ? `\n\nOperator feedback on the previous plan: ${ctx.step.state.feedback}` : "";
  const call = await guardModel(ctx, () =>
    structuredCall(ctx.models, {
      choice: modelChoice(ctx, agent),
      messages: architectMessages(ctx.task.objective + feedback, ctx.task.acceptance_criteria, JSON.stringify(map ?? {}, null, 2), read, { allowDependencyChanges: ctx.settings.allowDependencyChanges }),
      schema: planOut,
      maxOutputTokens: agent.limits.maxOutputTokens,
      ledger: ledger(ctx),
      signal: ctx.signal,
      purpose: "architect",
      validate: (d) => {
        const problems: string[] = [];
        for (const c of d.changes) {
          const prot = protectedPath(c.path, ctx.settings.allowDependencyChanges);
          if (prot) problems.push(`${c.path} touches ${prot}`);
          else if (c.action === "modify" && !known.has(c.path)) problems.push(`${c.path} doesn't exist (use "create" for new files)`);
          else if (c.action === "create" && known.has(c.path)) problems.push(`${c.path} already exists (use "modify")`);
        }
        return problems.length ? `Fix the plan: ${problems.join("; ")}.` : null;
      },
    }),
  );
  if (!call.ok) return call.result;
  const p = call.value.data;
  const risk = p.changes.some((c) => highRiskPath(c.path)) ? "high" : p.risk;
  const criteria = [...ctx.task.acceptance_criteria];
  for (const c of p.acceptanceCriteria) if (!criteria.some((x) => x.toLowerCase() === c.toLowerCase())) criteria.push(c);
  const finalPlan: Plan = { ...p, risk, acceptanceCriteria: criteria.slice(0, 20) };
  const hash = await sha256Hex(JSON.stringify(finalPlan));
  await ctx.log("plan.created", `Plan: ${finalPlan.changes.length} file(s), risk ${risk}`, { risk, files: finalPlan.changes.map((c) => c.path) });
  return { status: "succeeded", output: { plan: finalPlan }, usage: fromCall(call.value), taskPatch: { plan: finalPlan, plan_hash: hash, risk, acceptance_criteria: criteria.slice(0, 20) } };
};

const gatePlan: Executor = async (ctx) => {
  const t = ctx.task;
  if (!t.plan || !t.plan_hash) return { status: "failed", error: "No plan to approve.", retryable: false };
  const approvals = await ctx.store.listApprovals({ taskId: t.id });
  const match = approvals.find((a) => a.kind === "plan" && a.payload_hash === t.plan_hash && a.status !== "expired");
  if (match?.status === "approved") return { status: "succeeded", output: { approvedBy: "operator", approvalId: match.id, at: match.decided_at } };
  if (match?.status === "rejected") return { status: "failed", error: `Plan rejected by the operator${match.decision_note ? `: ${match.decision_note}` : "."}`, retryable: false };
  // High-risk plans always need a person, whatever the autonomy mode.
  const needsHuman = t.autonomy !== "execute" || t.plan.risk === "high";
  if (!needsHuman) {
    await ctx.log("approval.auto", `Plan approved automatically by policy (Execute mode, ${t.plan.risk} risk)`, { planHash: t.plan_hash }, "audit");
    return { status: "succeeded", output: { approvedBy: "policy" } };
  }
  if (match?.status === "pending") return { status: "waiting", reason: "Waiting for plan approval." };
  return {
    status: "waiting",
    reason: "Waiting for plan approval.",
    approval: {
      kind: "plan",
      title: `Approve plan: ${t.title}`.slice(0, 200),
      reason: `${t.plan.summary}\n\nThe builder will change ${t.plan.changes.length} file(s) in an isolated workspace. Nothing is pushed or deployed.`,
      risk: t.plan.risk,
      payload: { plan: t.plan },
      payload_hash: t.plan_hash,
    },
  };
};

const baseline: Executor = async (ctx) => runChecks(ctx, ctx.project.checks.filter((c) => c.required));

function editContext(ctx: ExecContext) {
  return async (paths: string[]) => {
    const files = await ctx.ws.listFiles();
    const current = new Map<string, string | null>();
    for (const p of paths) current.set(p, await ctx.ws.readFile(p));
    return { existing: new Set(files), current };
  };
}

async function applyAndCheckpoint(ctx: ExecContext, files: Map<string, string>, label: string, baseSha: string) {
  for (const [p, c] of files) await ctx.ws.writeFile(p, c);
  const cp = await ctx.ws.checkpoint(`orbis: ${label}`);
  const d = await ctx.ws.diff(baseSha);
  await ctx.log("workspace.changed", `${label}: ${files.size} file(s) written${cp ? `, checkpoint ${cp.slice(0, 10)}` : ""}`, { files: [...files.keys()], checkpoint: cp });
  return { checkpoint: cp, diff: d.diff, changed: d.files };
}

const build: Executor = async (ctx) => {
  const agent = agentById("builder")!;
  const t = ctx.task;
  if (!t.plan) return { status: "failed", error: "No approved plan.", retryable: false };
  const baseSha = stepOutput<{ baseSha: string }>(ctx.steps, "prepare")?.baseSha ?? "HEAD";
  const paths = t.plan.changes.map((c) => c.path);
  const { existing, current } = await editContext(ctx)(paths);
  const files = paths.filter((p) => current.get(p) !== null).map((p) => ({ path: p, content: redact(current.get(p)!) }));
  const feedback = typeof ctx.step.state.feedback === "string" ? ctx.step.state.feedback : null;
  const policy = { allowed: new Set(paths), existing, allowDependencyChanges: ctx.settings.allowDependencyChanges };
  let planned: Map<string, string> | null = null;
  const call = await guardModel(ctx, () =>
    structuredCall(ctx.models, {
      choice: modelChoice(ctx, agent),
      messages: builderMessages(t.objective, t.plan!, files, feedback),
      schema: editsOut,
      maxOutputTokens: agent.limits.maxOutputTokens,
      ledger: ledger(ctx),
      signal: ctx.signal,
      purpose: "builder",
      validate: (d) => {
        const r = planEdits(d.edits, current, policy);
        if (!r.ok) return r.errors.join(" ");
        planned = r.files;
        return null;
      },
    }),
  );
  if (!call.ok) return call.result;
  const out = await applyAndCheckpoint(ctx, planned!, "builder", baseSha);
  if (!out.changed.length) return { status: "failed", error: "The edits produced no changes.", retryable: true, usage: fromCall(call.value) };
  return { status: "succeeded", output: { notes: call.value.data.notes, files: [...planned!.keys()], checkpoint: out.checkpoint }, usage: fromCall(call.value), taskPatch: { diff: out.diff.slice(0, 400_000), changed_files: out.changed } };
};

export function failureSignature(results: CheckResult[]): string {
  return results
    .filter((r) => !r.passed && r.required)
    .map((r) => `${r.id}:${(r.outputTail.match(/(error|fail|✗|×)[^\n]{0,120}/gi) ?? []).slice(0, 3).join("|").replace(/\d+(\.\d+)?m?s/g, "")}`)
    .sort()
    .join(";");
}

const test: Executor = async (ctx) => {
  const r = await runChecks(ctx, ctx.project.checks.filter((c) => c.required));
  if (r.status !== "succeeded") return r;
  const results = r.output.results as CheckResult[];
  const base = (stepOutput<{ results: CheckResult[] }>(ctx.steps, "baseline")?.results ?? []) as CheckResult[];
  const newFailures = results.filter((x) => !x.passed && (base.find((b) => b.id === x.id)?.passed ?? true)).map((x) => x.id);
  const preexisting = results.filter((x) => !x.passed && base.find((b) => b.id === x.id)?.passed === false).map((x) => x.id);
  return { status: "succeeded", output: { results, newFailures, preexisting, signature: failureSignature(results) } };
};

const repair: Executor = async (ctx) => {
  const agent = agentById("self_heal")!;
  const t = ctx.task;
  const n = Number(ctx.step.key.split("-")[1]);
  const prevTest = ctx.steps.find((s) => s.key === `test-${n}`)?.output as { results: CheckResult[] } | undefined;
  const failures = (prevTest?.results ?? []).filter((r) => !r.passed && r.required);
  if (!failures.length) return { status: "skipped", reason: "Nothing failed." };
  const baseSha = stepOutput<{ baseSha: string }>(ctx.steps, "prepare")?.baseSha ?? "HEAD";
  const all = await ctx.ws.listFiles();
  const known = new Set(all);
  const referenced = pathsInOutput(failures.map((f) => f.outputTail).join("\n"), known);
  const paths = [...new Set([...t.changed_files, ...referenced, ...(t.plan?.changes.map((c) => c.path) ?? [])])].slice(0, 10);
  const { existing, current } = await editContext(ctx)(paths);
  const files = paths.filter((p) => current.get(p) !== null).map((p) => ({ path: p, content: redact(current.get(p)!) }));
  const history = ctx.steps
    .filter((s) => s.key.startsWith("repair-") && s.status === "succeeded")
    .map((s) => `${s.key}: ${(s.output as { rootCause?: string }).rootCause ?? ""}`)
    .join("\n");
  const policy = { allowed: new Set(paths), existing, allowDependencyChanges: ctx.settings.allowDependencyChanges };
  let planned: Map<string, string> | null = null;
  const call = await guardModel(ctx, () =>
    structuredCall(ctx.models, {
      choice: modelChoice(ctx, agent),
      messages: repairMessages(t.objective, failures, t.diff ?? "", files, history),
      schema: repairOut,
      maxOutputTokens: agent.limits.maxOutputTokens,
      ledger: ledger(ctx),
      signal: ctx.signal,
      purpose: "self_heal",
      validate: (d) => {
        const r = planEdits(d.edits, current, policy);
        if (!r.ok) return r.errors.join(" ");
        planned = r.files;
        return null;
      },
    }),
  );
  if (!call.ok) return call.result;
  const out = await applyAndCheckpoint(ctx, planned!, `self-heal ${n}`, baseSha);
  return { status: "succeeded", output: { rootCause: call.value.data.rootCause, notes: call.value.data.notes, files: [...planned!.keys()], checkpoint: out.checkpoint }, usage: fromCall(call.value), taskPatch: { diff: out.diff.slice(0, 400_000), changed_files: out.changed } };
};

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

const security: Executor = async (ctx) => {
  const agent = agentById("sentinel")!;
  const t = ctx.task;
  const added = addedLines(t.diff ?? "");
  const addedNums = addedLineNumbers(t.diff ?? "");
  const files = await readFiles(ctx.ws, t.changed_files, 30, 400_000, 200_000);
  // Only report problems on lines this change added, not pre-existing ones in the same files.
  const rules = runCodeRules(files, ctx.project.repo).findings.filter((f) =>
    f.evidence.some((e) => {
      const m = /^(.*):(\d+)$/.exec(e.source);
      return !!m && (addedNums.get(m[1]!)?.has(Number(m[2])) ?? false);
    }),
  );
  const findings: { severity: keyof typeof SEV_RANK; source: string; file: string; issue: string; evidence: string; remediation: string }[] = rules.map((f) => ({
    severity: (f.severity === "info" ? "low" : f.severity) as keyof typeof SEV_RANK,
    source: `rules:${f.ruleId}`,
    file: f.location ?? "",
    issue: f.title,
    evidence: f.evidence[0]?.detail ?? "",
    remediation: f.remediation,
  }));
  let usage: Usage | undefined;
  if (ctx.settings.aiSecurityReview && t.diff) {
    const allAdded = new Set([...added.values()].flat().map((l) => l.trim()).filter(Boolean));
    const call = await guardModel(ctx, () =>
      structuredCall(ctx.models, { choice: modelChoice(ctx, agent), messages: securityMessages(redact(t.diff!)), schema: securityOut, maxOutputTokens: agent.limits.maxOutputTokens, ledger: ledger(ctx), signal: ctx.signal, purpose: "sentinel" }),
    );
    if (!call.ok) return call.result;
    usage = fromCall(call.value);
    let dropped = 0;
    for (const f of call.value.data.findings) {
      if (!allAdded.has(f.quote.trim())) {
        dropped++;
        continue;
      }
      findings.push({ severity: f.severity, source: "ai-review", file: f.file, issue: f.issue, evidence: f.quote, remediation: f.remediation });
    }
    if (dropped) await ctx.log("output.rejected", `Dropped ${dropped} AI security finding(s) whose quoted line isn't in the diff`, {}, "warn");
  }
  findings.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const threshold = ctx.settings.blockOnSecurity;
  const blocking = threshold === "never" ? [] : findings.filter((f) => SEV_RANK[f.severity] <= SEV_RANK[threshold]);
  return { status: "succeeded", output: { findings, blocking: blocking.length, threshold, aiReview: ctx.settings.aiSecurityReview }, usage };
};

const review: Executor = async (ctx) => {
  const agent = agentById("reviewer")!;
  const t = ctx.task;
  const last = latestTest(ctx.steps)?.output as { results: CheckResult[] } | undefined;
  const notes = ctx.steps.filter((s) => (s.key === "build" || s.key.startsWith("repair-")) && s.status === "succeeded").map((s) => String((s.output as { notes?: string }).notes ?? "")).join("\n");
  const call = await guardModel(ctx, () =>
    structuredCall(ctx.models, {
      choice: modelChoice(ctx, agent),
      messages: reviewerMessages(t.objective, t.acceptance_criteria, redact(t.diff ?? ""), last?.results ?? [], notes),
      schema: reviewOut,
      maxOutputTokens: agent.limits.maxOutputTokens,
      ledger: ledger(ctx),
      signal: ctx.signal,
      purpose: "reviewer",
      validate: (d) => (t.acceptance_criteria.length && d.criteria.length < Math.min(t.acceptance_criteria.length, 20) ? `Assess every acceptance criterion (${t.acceptance_criteria.length}).` : null),
    }),
  );
  if (!call.ok) return call.result;
  return { status: "succeeded", output: call.value.data as unknown as Record<string, unknown>, usage: fromCall(call.value) };
};

const buildCheck: Executor = async (ctx) => {
  const check = ctx.project.checks.find((c) => c.id === "build");
  if (!check) return { status: "skipped", reason: "The project has no build script." };
  return runChecks(ctx, [check]);
};

/* --------------------------------------------------------- verification */

export function verify(task: Task, steps: Step[], settings: WorkforceSettings): { verdict: "verified" | "not_verified"; checks: { name: string; passed: boolean; evidence: string }[]; criteria: { criterion: string; status: "met" | "not_met" | "unclear"; evidence: string; judgedBy: "reviewer-model" }[]; reasons: string[] } {
  const checks: { name: string; passed: boolean; evidence: string }[] = [];
  const reasons: string[] = [];
  const last = latestTest(steps);
  const results = ((last?.output as { results?: CheckResult[] } | undefined)?.results ?? []) as CheckResult[];
  if (!last) reasons.push("No test run completed after the change.");
  for (const r of results.filter((x) => x.required)) {
    checks.push({ name: r.label, passed: r.passed, evidence: `${last!.key}: exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}` });
    if (!r.passed) reasons.push(`${r.label} failed (exit ${r.exitCode}).`);
  }
  const bc = steps.find((s) => s.key === "buildcheck");
  if (bc?.status === "succeeded") {
    const r = ((bc.output as { results?: CheckResult[] }).results ?? [])[0];
    if (r) {
      checks.push({ name: r.label, passed: r.passed, evidence: `buildcheck: exit ${r.exitCode}` });
      if (!r.passed) reasons.push(`${r.label} failed (exit ${r.exitCode}).`);
    }
  } else if (settings.runBuildCheck && bc?.status !== "skipped") reasons.push("The build check did not complete.");
  const sec = steps.find((s) => s.key === "security");
  const secOut = sec?.output as { blocking?: number; findings?: unknown[] } | undefined;
  if (sec?.status === "succeeded") {
    checks.push({ name: "Security review", passed: !secOut?.blocking, evidence: `${secOut?.findings?.length ?? 0} finding(s), ${secOut?.blocking ?? 0} at or above "${settings.blockOnSecurity}"` });
    if (secOut?.blocking) reasons.push(`${secOut.blocking} security finding(s) at or above the blocking threshold.`);
  } else reasons.push("The security review did not complete.");
  const rev = steps.find((s) => s.key === "review");
  const revOut = rev?.output as ReviewOut | undefined;
  if (rev?.status === "succeeded" && revOut) {
    checks.push({ name: "Independent review", passed: revOut.recommendation === "approve", evidence: `recommendation: ${revOut.recommendation}; ${revOut.findings.length} finding(s)` });
    if (revOut.recommendation !== "approve") reasons.push(`Reviewer recommends "${revOut.recommendation}".`);
    const serious = revOut.findings.filter((f) => f.severity === "critical" || f.severity === "high");
    if (serious.length) reasons.push(`${serious.length} critical/high review finding(s).`);
  } else reasons.push("The independent review did not complete.");
  const criteria = (revOut?.criteria ?? []).map((c) => ({ ...c, judgedBy: "reviewer-model" as const }));
  for (const c of task.acceptance_criteria) if (!criteria.some((x) => x.criterion.trim().toLowerCase() === c.trim().toLowerCase())) criteria.push({ criterion: c, status: "unclear", evidence: "Not assessed by the reviewer.", judgedBy: "reviewer-model" });
  const notMet = criteria.filter((c) => c.status !== "met");
  if (notMet.length) reasons.push(`${notMet.length} acceptance criterion/criteria not confirmed as met.`);
  if (!task.diff?.trim()) reasons.push("No changes were produced.");
  return { verdict: reasons.length ? "not_verified" : "verified", checks, criteria, reasons };
}

const verifyStep: Executor = async (ctx) => {
  const v = verify(ctx.task, ctx.steps, ctx.settings);
  await ctx.log("verification", v.verdict === "verified" ? "Verified: all required checks, review and security gates passed" : `Not verified: ${v.reasons.join(" ")}`, { verdict: v.verdict }, "audit");
  return { status: "succeeded", output: v as unknown as Record<string, unknown>, taskPatch: { verification: v } };
};

export const EXECUTORS: Record<string, Executor> = { prepare, map, plan, "gate-plan": gatePlan, baseline, build, test, repair, security, review, buildcheck: buildCheck, verify: verifyStep };

export function executorFor(key: string): Executor | undefined {
  return EXECUTORS[key] ?? EXECUTORS[key.replace(/-\d+$/, "")];
}

export { noUsage };
