/**
 * The orchestrator's workers end to end, on the real migrations (PGlite): claiming slots, running attempts through
 * the executor, recording results, retries, timeouts, cancellation, lost leases, planning tasks and tool permissions.
 *
 * MOCKED: every model call here goes to MockGateway below — a deterministic stand-in written for these tests. No
 * AI provider is called and nothing here shows that a real provider works (see docs/ORCHESTRATION.md, "Tests").
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolMessage } from "@/lib/ai/types";
import type { Authed } from "@/lib/code/server";
import type { ProjectFile } from "@/lib/code/projects";
import { ApiError } from "@/lib/http";
import { executeAttempt, type Claim } from "@/lib/orchestrator/executor";
import type { ModelCall, ModelGateway, ModelReply, ResolvedModel } from "@/lib/orchestrator/providers";
import { runWorker, type WorkerDeps } from "@/lib/orchestrator/worker";
import { ALICE, ALICE_PROJECT, asService, asUser, orchDb, resetOrch } from "./helpers/orch-db";

let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const n = async (sql: string) => Number((await q<{ n: string }>(sql))[0]!.n);
const activeSlots = () => n("select count(*)::text as n from public.orch_slots where lease_id is not null");
const runningAttempts = () => n("select count(*)::text as n from public.orch_attempts where status = 'running'");
const statusOf = async (id: string) => (await q<{ status: string }>("select status from public.orch_tasks where id = $1", [id]))[0]!.status;

// ---------------------------------------------------------------- MOCK provider gateway (no real model calls)

type Script = (req: ModelCall, n: number) => Promise<Partial<ModelReply>> | Partial<ModelReply>;

class MockGateway implements ModelGateway {
  calls: ModelCall[] = [];
  inFlight = 0;
  peak = 0;
  toolCalling = true;
  constructor(public script: Script = () => ({ text: "Done." })) {}
  async resolve(provider: string, modelId: string): Promise<ResolvedModel> {
    return { id: modelId, provider, name: `Mock ${modelId}`, capabilities: { toolCalling: this.toolCalling, vision: false, reasoning: false, longContext: false, priced: true }, info: {} as ResolvedModel["info"] };
  }
  async call(_owner: Authed, _model: ResolvedModel, req: ModelCall): Promise<ModelReply> {
    this.calls.push(req);
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      const r = await this.script(req, this.calls.length);
      return { text: "", calls: [], usage: { inputTokens: 100, outputTokens: 20, estimated: false }, costUsd: 0.001, stop: r.calls?.length ? "tool_use" : "end_turn", servedModel: null, ...r };
    } finally {
      this.inFlight--;
    }
  }
}

/** A promise the test resolves itself (to hold a mock model call open). */
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
async function until(cond: () => boolean | Promise<boolean>, ms = 10_000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const owner = (): Authed => ({ mode: "authenticated", user: { id: ALICE }, supabase: asUser(db, ALICE) }) as unknown as Authed;
const projectFiles = async (_o: Authed, projectId: string) => (await q<ProjectFile>("select path, content from public.code_files where project_id = $1 order by path", [projectId])) as ProjectFile[];

function deps(gateway: ModelGateway, o: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    db: asService(db) as unknown as WorkerDeps["db"],
    gateway,
    openOwner: async () => ({ auth: owner(), end: async () => undefined }),
    projectFiles,
    ...o,
  };
}
const work = (d: WorkerDeps, id = "w1") => runWorker(d, { workerId: id, budgetMs: 200_000 });

async function agent(o: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await asUser(db, ALICE)
    .from("orch_agents")
    .insert({ name: `Agent ${Math.random().toString(36).slice(2, 7)}`, role: "backend_developer", provider: "anthropic", model_id: "claude-haiku", ...o })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}
async function task(o: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await asUser(db, ALICE)
    .from("orch_tasks")
    .insert({ project_id: ALICE_PROJECT, title: "Do something", input: "Details", ...o })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

beforeAll(async () => {
  db = await orchDb();
}, 120_000);
afterAll(() => db.close());
beforeEach(() => resetOrch(db));

describe("workers and the limit of three executions (mock gateway)", () => {
  it("runs three attempts at once, holds the rest queued, and starts the next as soon as one ends", async () => {
    await agent();
    const ids = await Promise.all(Array.from({ length: 6 }, () => task()));
    const gates: ReturnType<typeof gate>[] = [];
    const gw = new MockGateway(async () => {
      const g = gate();
      gates.push(g);
      await g.p;
      return { text: "Finished." };
    });
    // Six workers compete (as six function calls would); the database lets three run.
    const workers = Array.from({ length: 6 }, (_, i) => work(deps(gw), `w${i}`));
    await until(() => gw.inFlight === 3);
    await new Promise((r) => setTimeout(r, 200)); // give a fourth every chance to start
    expect(gw.inFlight).toBe(3);
    expect(await activeSlots()).toBe(3);
    expect(await runningAttempts()).toBe(3);
    expect(await n("select count(*)::text as n from public.orch_tasks where status = 'queued'")).toBe(3);

    // One ends: its slot is released and a queued task starts.
    gates[0]!.open();
    await until(() => gates.length === 4);
    await until(() => gw.inFlight === 3);
    expect(await n("select count(*)::text as n from public.orch_tasks where status = 'completed'")).toBe(1);

    // Let everything finish.
    const drain = setInterval(() => gates.forEach((g) => g.open()), 5);
    const reports = await Promise.all(workers);
    clearInterval(drain);
    expect(gw.peak).toBe(3);
    expect(await activeSlots()).toBe(0);
    for (const id of ids) expect(await statusOf(id)).toBe("completed");
    expect(reports.flatMap((r) => r.ran)).toHaveLength(6);
    expect(await n("select count(*)::text as n from public.orch_attempts")).toBe(6);
  });

  it("follows a lowered limit: with max 1, one runs at a time", async () => {
    await agent();
    await q("update public.orch_settings set max_concurrency = 1");
    await Promise.all(Array.from({ length: 3 }, () => task()));
    const gw = new MockGateway(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { text: "ok" };
    });
    await Promise.all(Array.from({ length: 4 }, (_, i) => work(deps(gw), `w${i}`)));
    expect(gw.peak).toBe(1);
    expect(await n("select count(*)::text as n from public.orch_tasks where status = 'completed'")).toBe(3);
  });

  it("does nothing while dispatch is paused (Bastion lockdown)", async () => {
    await agent();
    const id = await task();
    const gw = new MockGateway();
    const r = await work(deps(gw, { paused: async () => "Orbis Bastion is in lockdown." }));
    expect(r.stopped).toBe("paused");
    expect(gw.calls).toHaveLength(0);
    expect(await statusOf(id)).toBe("queued");
    expect(await activeSlots()).toBe(0);
  });
});

describe("failures, retries, timeouts and cancellation (mock gateway)", () => {
  it("releases the slot after a failure and retries after the agent's backoff, up to its attempt limit", async () => {
    await agent({ max_attempts: 2, retry_backoff_seconds: 5 });
    const id = await task();
    const gw = new MockGateway(() => {
      throw new ApiError("rate_limited", "Provider rate limit.");
    });
    const waits: { ms: number; slots: number; status: string; notBefore: number }[] = [];
    // The worker waits for the retry; the test checks what it's waiting for, then lets the time pass.
    const sleep = async (ms: number) => {
      const [row] = await q<{ wait: number }>("select extract(epoch from run_after - now())::float as wait from public.orch_tasks where id = $1", [id]);
      waits.push({ ms, slots: await activeSlots(), status: await statusOf(id), notBefore: row!.wait });
      await q("update public.orch_tasks set run_after = now() where id = $1", [id]);
    };
    const r = await work(deps(gw, { sleep }));
    expect(r.ran).toEqual([
      { taskId: id, attemptNo: 1, outcome: "failed", taskStatus: "queued" },
      { taskId: id, attemptNo: 2, outcome: "failed", taskStatus: "failed" },
    ]);
    // Between the attempts: no slot held, the task queued and not due for the agent's 5 s backoff.
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({ slots: 0, status: "queued" });
    expect(waits[0]!.notBefore).toBeGreaterThan(3);
    expect(waits[0]!.ms).toBeGreaterThan(3000);
    expect(await statusOf(id)).toBe("failed");
    expect(await activeSlots()).toBe(0);
    const attempts = await q<{ status: string; error_kind: string }>("select status, error_kind from public.orch_attempts where task_id = $1 order by attempt_no", [id]);
    expect(attempts).toEqual([
      { status: "failed", error_kind: "rate_limit" },
      { status: "failed", error_kind: "rate_limit" },
    ]);
  });

  it("uses the task's own attempt limit when it sets one", async () => {
    await agent({ max_attempts: 4 });
    const id = await task({ max_attempts: 1, policy_from_agent: false });
    const gw = new MockGateway(() => {
      throw new ApiError("rate_limited", "Provider rate limit.");
    });
    await work(deps(gw));
    expect(gw.calls).toHaveLength(1);
    expect(await statusOf(id)).toBe("failed");
  });

  it("doesn't retry an error that can't succeed (missing credentials)", async () => {
    await agent({ max_attempts: 3 });
    const id = await task();
    const gw = new MockGateway(() => {
      throw new ApiError("not_configured", "ANTHROPIC_API_KEY is not set.");
    });
    const r = await work(deps(gw));
    expect(r.ran).toHaveLength(1);
    expect(await statusOf(id)).toBe("failed");
    const [t] = await q<{ attempts: number; error: string }>("select attempts, error from public.orch_tasks where id = $1", [id]);
    expect(t!.attempts).toBe(1);
    expect(t!.error).toMatch(/not set/);
  });

  it("cuts an attempt off at its time limit, records it as timed out and frees the slot", async () => {
    await agent({ max_attempts: 1 });
    const id = await task();
    const { data } = await asService(db).rpc("orch_claim", { p_worker: "w1", p_max_seconds: 270 });
    const claim = { ...(data as Claim), timeoutSeconds: 0.3 }; // shortened for the test
    const gw = new MockGateway(
      (req) =>
        new Promise((_, reject) => {
          req.signal.addEventListener("abort", () => reject(req.signal.reason));
        }),
    );
    const r = await executeAttempt(claim, { db: asService(db) as unknown as WorkerDeps["db"], gateway: gw, owner: owner(), projectFiles });
    expect(r.outcome).toBe("timed_out");
    expect(r.retryable).toBe(true);
    const { data: st } = await asService(db).rpc("orch_finish", { p_attempt: claim.attemptId, p_lease: claim.leaseId, p_outcome: r.outcome, p_output: r.output, p_error: r.error, p_error_kind: r.errorKind, p_retryable: r.retryable, p_usage: r.usage });
    expect(st).toBe("failed"); // one attempt allowed
    expect(await statusOf(id)).toBe("failed");
    expect(await activeSlots()).toBe(0);
    expect((await q<{ status: string }>("select status from public.orch_attempts where task_id = $1", [id]))[0]!.status).toBe("timed_out");
  });

  it("stops a cancelled task before its next model call and frees the slot", async () => {
    await agent({ allowed_tools: ["read_project"] });
    const id = await task();
    const g = gate();
    const gw = new MockGateway(async (_req, i) => {
      if (i === 1) {
        await g.p;
        return { text: "", calls: [{ id: "c1", name: "list_files", args: {} }] };
      }
      return { text: "should not be reached" };
    });
    const running = work(deps(gw));
    await until(() => gw.inFlight === 1);
    const { data, error } = await asUser(db, ALICE).rpc("orch_cancel", { p_task: id });
    expect(error).toBeNull();
    expect(data).toBe("cancelled");
    g.open();
    const r = await running;
    expect(gw.calls).toHaveLength(1);
    expect(r.ran[0]).toMatchObject({ outcome: "cancelled" });
    expect(await statusOf(id)).toBe("cancelled");
    expect(await activeSlots()).toBe(0);
  });

  it("records nothing from a worker whose lease was reclaimed, and the task is retried", async () => {
    await agent({ max_attempts: 3 });
    const id = await task();
    const g = gate();
    const gw = new MockGateway(async (_req, i) => {
      if (i === 1) await g.p;
      return { text: `answer ${i}` };
    });
    const slow = work(deps(gw), "w-slow");
    await until(() => gw.inFlight === 1);
    // The worker looks dead: its lease expires and the queue reclaims the slot.
    await q("update public.orch_slots set expires_at = now() - interval '1 second' where lease_id is not null");
    await q("update public.orch_attempts set expires_at = now() - interval '1 second' where status = 'running'");
    await asService(db).rpc("orch_reconcile", {});
    expect(await activeSlots()).toBe(0);
    expect(await statusOf(id)).toBe("queued");
    g.open();
    const r = await slow;
    // Its late result wasn't recorded as the task's result.
    expect(r.ran[0]).toMatchObject({ attemptNo: 1, taskStatus: "stale" });
    const attempts = await q<{ attempt_no: number; status: string }>("select attempt_no, status from public.orch_attempts where task_id = $1 order by attempt_no", [id]);
    expect(attempts[0]).toEqual({ attempt_no: 1, status: "interrupted" });
    // The same worker (or another) then ran it again, once.
    expect(attempts.length).toBe(2);
    expect(attempts[1]).toEqual({ attempt_no: 2, status: "succeeded" });
    expect(await statusOf(id)).toBe("completed");
    expect((await q<{ output: string }>("select output from public.orch_tasks where id = $1", [id]))[0]!.output).toBe("answer 2");
  });

  it("fails an attempt (retryably) when the owner's session can't be opened, and frees the slot", async () => {
    await agent({ max_attempts: 1 });
    const id = await task();
    const gw = new MockGateway();
    const r = await work(deps(gw, { openOwner: async () => null }));
    expect(r.ran[0]).toMatchObject({ outcome: "failed" });
    expect(gw.calls).toHaveLength(0);
    expect(await statusOf(id)).toBe("failed");
    expect(await activeSlots()).toBe(0);
  });
});

describe("planning tasks (mock gateway)", () => {
  const plan = JSON.stringify({
    summary: "Fix the add function, then test it.",
    subtasks: [
      { title: "Fix add()", instructions: "Make add return a + b.", type: "backend", dependsOn: [] },
      { title: "Test add()", instructions: "Write tests for add.", type: "tests", dependsOn: [0] },
    ],
  });

  it("breaks a task into sub-tasks that run in dependency order, each in its own slot", async () => {
    await agent({ role: "lead_developer", task_types: ["plan"], name: "Lead" });
    await agent({ name: "Generalist" });
    const id = await task({ kind: "plan", task_type: "plan", title: "Fix add" });
    const order: string[] = [];
    const gw = new MockGateway((req) => {
      const text = (req.messages[0] as ToolMessage & { text: string }).text;
      if (req.system.includes("sub-tasks")) return { text: plan };
      order.push(text.includes("Write tests for add") ? "test" : "fix");
      return { text: `Result for ${order.at(-1)}` };
    });
    const r = await work(deps(gw));
    expect(r.ran.map((x) => x.taskStatus)).toEqual(["completed", "completed", "completed"]);
    expect(order).toEqual(["fix", "test"]);
    expect(await statusOf(id)).toBe("completed");
    const children = await q<{ title: string; status: string; depends_on: string[] }>("select title, status, depends_on from public.orch_tasks where parent_id = $1 order by created_at", [id]);
    expect(children.map((c) => [c.title, c.status])).toEqual([
      ["Fix add()", "completed"],
      ["Test add()", "completed"],
    ]);
    expect(children[1]!.depends_on).toContain(id);
    // Every attempt (the plan's too) held a slot, and the test task saw the fix's result.
    expect(await n("select count(*)::text as n from public.orch_attempts where slot_no is null")).toBe(0);
    expect(JSON.stringify(gw.calls.at(-1)!.messages)).toContain("Result for fix");
    expect(await activeSlots()).toBe(0);
  });

  it("rejects an invalid plan (a dependency on a later sub-task) after one correction, creating nothing", async () => {
    await agent({ role: "lead_developer", task_types: ["plan"], max_attempts: 1 });
    const id = await task({ kind: "plan", task_type: "plan" });
    const bad = JSON.stringify({ summary: "x", subtasks: [{ title: "a", instructions: "a", type: "backend", dependsOn: [1] }, { title: "b", instructions: "b", type: "backend", dependsOn: [] }] });
    const gw = new MockGateway(() => ({ text: bad }));
    await work(deps(gw));
    expect(gw.calls).toHaveLength(2);
    expect(await statusOf(id)).toBe("failed");
    expect(await n(`select count(*)::text as n from public.orch_tasks where parent_id = '${id}'`)).toBe(0);
  });
});

describe("tool permissions and secrets (mock gateway)", () => {
  it("offers no tools to an agent without read_project", async () => {
    await agent({ allowed_tools: [] });
    await task();
    const gw = new MockGateway(() => ({ text: "No tools needed." }));
    await work(deps(gw));
    expect(gw.calls[0]!.tools).toEqual([]);
  });

  it("lets a read_project agent read code but never a .env file, and redacts secrets from the output", async () => {
    await agent({ allowed_tools: ["read_project"] });
    const id = await task();
    const gw = new MockGateway((_req, i) => {
      if (i === 1) return { text: "", calls: [{ id: "r1", name: "read_files", args: { paths: ["src/app.ts", ".env"] } }, { id: "r2", name: "run_command", args: { command: "rm -rf /" } }] };
      return { text: "The bug is in add(). Also found sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 somewhere." };
    });
    await work(deps(gw));
    expect(gw.calls[0]!.tools.map((t) => t.name)).toEqual(["list_files", "search_code", "read_files"]);
    const results = (gw.calls[1]!.messages.at(-1) as { results: { id: string; ok: boolean; text: string }[] }).results;
    expect(results[0]!.text).toContain("a - b");
    expect(results[0]!.text).toContain("withheld");
    expect(results[0]!.text).not.toContain("sk-ant-");
    expect(results[1]).toMatchObject({ ok: false, text: expect.stringMatching(/Not allowed/) });
    const [t] = await q<{ output: string; status: string }>("select output, status from public.orch_tasks where id = $1", [id]);
    expect(t!.status).toBe("completed");
    expect(t!.output).not.toContain("sk-ant-abcdefghijklmnop");
  });

  it("answers without tools (and says so) when the model can't call tools", async () => {
    await agent({ allowed_tools: ["read_project"] });
    const id = await task();
    const gw = new MockGateway(() => ({ text: "Answer from the task text." }));
    gw.toolCalling = false;
    await work(deps(gw));
    expect(gw.calls[0]!.tools).toEqual([]);
    expect((await q<{ output: string }>("select output from public.orch_tasks where id = $1", [id]))[0]!.output).toMatch(/can't call tools/);
  });
});
