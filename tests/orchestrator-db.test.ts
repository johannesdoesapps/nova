/**
 * The orchestrator's queue in the database (the real migrations on PGlite): the global limit of three model
 * executions, dispatch, retries, cancellation, recovery of expired leases, dependencies, agent states and access
 * rules. These are the rules every worker relies on, so they're tested where they're enforced: in SQL.
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALICE, ALICE_PROJECT, ALICE_PROJECT_2, BOB, CAROL, CAROL_PROJECT, asService, asUser, orchDb, resetOrch } from "./helpers/orch-db";

let db: PGlite;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
type Claim = { attemptId: string; taskId: string; leaseId: string; slot: number; ownerId: string; attemptNo: number; agentId: string };

async function agent(owner: string, o: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await asUser(db, owner)
    .from("orch_agents")
    .insert({ name: `Agent ${Math.random().toString(36).slice(2, 7)}`, role: "backend_developer", provider: "anthropic", model_id: "claude-haiku", ...o })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}
async function task(owner: string, o: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await asUser(db, owner)
    .from("orch_tasks")
    .insert({ project_id: owner === CAROL ? CAROL_PROJECT : ALICE_PROJECT, title: "Do something", input: "Details", ...o })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}
const claim = async (worker = "w1", maxSeconds = 270) => {
  const { data, error } = await asService(db).rpc("orch_claim", { p_worker: worker, p_max_seconds: maxSeconds });
  if (error) throw new Error(error.message);
  return data as Claim | null;
};
const finish = async (c: Claim, outcome: string, o: { output?: string; error?: string; retryable?: boolean; kind?: string } = {}) => {
  const { data, error } = await asService(db).rpc("orch_finish", {
    p_attempt: c.attemptId,
    p_lease: c.leaseId,
    p_outcome: outcome,
    p_output: o.output ?? (outcome === "succeeded" ? "done" : null),
    p_error: o.error ?? (outcome === "succeeded" ? null : "boom"),
    p_error_kind: o.kind ?? null,
    p_retryable: o.retryable ?? false,
    p_usage: { modelCalls: 1, inputTokens: 10, outputTokens: 5, costUsd: 0.001 },
  });
  if (error) throw new Error(error.message);
  return data as string;
};
const status = async (id: string) => (await q<{ status: string }>("select status from public.orch_tasks where id = $1", [id]))[0]!.status;
const activeSlots = async () => Number((await q<{ n: string }>("select count(*)::text as n from public.orch_slots where lease_id is not null"))[0]!.n);
const running = async () => Number((await q<{ n: string }>("select count(*)::text as n from public.orch_attempts where status = 'running'"))[0]!.n);

beforeAll(async () => {
  db = await orchDb();
}, 120_000);
afterAll(() => db.close());
beforeEach(() => resetOrch(db));

describe("the global limit of three executions", () => {
  it("has exactly three slots, and a fourth can't be added", async () => {
    expect(await q("select slot_no from public.orch_slots order by slot_no")).toEqual([{ slot_no: 1 }, { slot_no: 2 }, { slot_no: 3 }]);
    await expect(q("insert into public.orch_slots (slot_no) values (4)")).rejects.toThrow(/check constraint/);
  });

  it("runs one execution, then three at once, and keeps a fourth queued until one ends", async () => {
    await agent(ALICE);
    const ids = [await task(ALICE), await task(ALICE), await task(ALICE), await task(ALICE)];
    const c1 = await claim();
    expect(c1).toMatchObject({ attemptNo: 1, slot: 1 });
    expect(await finish(c1!, "succeeded")).toBe("completed");
    expect(await activeSlots()).toBe(0);

    const three = [await claim("w1"), await claim("w2"), await claim("w3")];
    expect(three.every(Boolean)).toBe(true);
    expect(new Set(three.map((c) => c!.slot))).toEqual(new Set([1, 2, 3]));
    expect(await claim("w4")).toBeNull();
    expect(await running()).toBe(3);
    const queued = ids.filter((id) => !three.some((c) => c!.taskId === id) && id !== c1!.taskId);
    expect(queued).toHaveLength(0); // 4 tasks: one done, three running

    const fifth = await task(ALICE);
    expect(await claim("w5")).toBeNull();
    expect(await status(fifth)).toBe("queued");
    await finish(three[1]!, "succeeded");
    const next = await claim("w5");
    expect(next).toMatchObject({ taskId: fifth, slot: three[1]!.slot });
    expect(await running()).toBe(3);
  });

  it("is shared across projects and owners", async () => {
    await agent(ALICE);
    await agent(CAROL);
    await task(ALICE, { project_id: ALICE_PROJECT });
    await task(ALICE, { project_id: ALICE_PROJECT_2 });
    await task(CAROL);
    await task(CAROL);
    const claims = [await claim(), await claim(), await claim(), await claim()];
    expect(claims.filter(Boolean)).toHaveLength(3);
    expect(new Set(claims.filter(Boolean).map((c) => c!.ownerId)).size).toBe(2);
  });

  it("can be lowered to 1 or 2, never set outside 1–3, and only by an administrator", async () => {
    await agent(ALICE);
    for (let i = 0; i < 3; i++) await task(ALICE);
    const { error } = await asUser(db, ALICE).from("orch_settings").update({ max_concurrency: 2 }).eq("id", 1);
    expect(error).toBeNull();
    expect([await claim(), await claim(), await claim()].filter(Boolean)).toHaveLength(2);
    for (const bad of [0, 4, 10]) {
      const r = await asUser(db, ALICE).from("orch_settings").update({ max_concurrency: bad }).eq("id", 1);
      expect(r.error?.message).toMatch(/check constraint/);
    }
    const bob = await asUser(db, BOB).from("orch_settings").update({ max_concurrency: 3 }).eq("id", 1).select("max_concurrency");
    expect(bob.data).toEqual([]); // row-level security: not visible, nothing changed
    expect((await q<{ max_concurrency: number }>("select max_concurrency from public.orch_settings"))[0]!.max_concurrency).toBe(2);
  });

  it("lowering the limit while three run lets them finish and starts nothing until below the new limit", async () => {
    await agent(ALICE);
    for (let i = 0; i < 5; i++) await task(ALICE);
    const c = [await claim(), await claim(), await claim()];
    await q("update public.orch_settings set max_concurrency = 1");
    await finish(c[0]!, "succeeded");
    expect(await claim()).toBeNull(); // 2 still running, limit 1
    await finish(c[1]!, "succeeded");
    expect(await claim()).toBeNull();
    await finish(c[2]!, "succeeded");
    expect(await claim()).not.toBeNull();
  });

  it("counts executions that aren't task attempts (a live provider check) against the same limit", async () => {
    await agent(ALICE);
    for (let i = 0; i < 3; i++) await task(ALICE);
    const svc = asService(db);
    const check = (await svc.rpc("orch_acquire_slot", { p_seconds: 30, p_purpose: "provider_check", p_owner: ALICE })).data as { lease: string } | null;
    expect(check).not.toBeNull();
    expect([await claim(), await claim(), await claim()].filter(Boolean)).toHaveLength(2);
    expect((await svc.rpc("orch_acquire_slot", { p_seconds: 30, p_purpose: "provider_check", p_owner: ALICE })).data).toBeNull();
    expect((await svc.rpc("orch_release_slot", { p_lease: check!.lease })).data).toBe(true);
    expect(await claim()).not.toBeNull();
  });
});

describe("attempts: failures, retries, timeouts and cancellation", () => {
  it("frees the slot on failure and retries a retryable failure later, up to the task's limit", async () => {
    await agent(ALICE, { max_attempts: 2, retry_backoff_seconds: 30 });
    const id = await task(ALICE, { max_attempts: 2, retry_backoff_seconds: 30 });
    const c1 = await claim();
    expect(await finish(c1!, "failed", { retryable: true, error: "Provider is busy." })).toBe("queued");
    expect(await activeSlots()).toBe(0);
    const [t] = await q<{ run_after: string; attempts: number; status_reason: string }>("select run_after::text, attempts, status_reason from public.orch_tasks where id = $1", [id]);
    expect(Date.parse(t!.run_after)).toBeGreaterThan(Date.now() + 20_000); // backoff
    expect(t!.status_reason).toMatch(/Retry 2 of 2/);
    expect(await claim()).toBeNull(); // not before run_after
    await q("update public.orch_tasks set run_after = now() where id = $1", [id]);
    const c2 = await claim();
    expect(c2).toMatchObject({ attemptNo: 2 });
    expect(await finish(c2!, "timed_out", { retryable: true, error: "Timed out." })).toBe("failed");
    const [done] = await q<{ status: string; error: string; status_reason: string }>("select status, error, status_reason from public.orch_tasks where id = $1", [id]);
    expect(done).toMatchObject({ status: "failed", error: "Timed out.", status_reason: "Gave up after 2 attempts." });
    expect(await q("select attempt_no, status from public.orch_attempts where task_id = $1 order by attempt_no", [id])).toEqual([
      { attempt_no: 1, status: "failed" },
      { attempt_no: 2, status: "timed_out" },
    ]);
  });

  it("doesn't retry an error that would happen again (bad credentials)", async () => {
    await agent(ALICE);
    const id = await task(ALICE, { max_attempts: 3 });
    expect(await finish((await claim())!, "failed", { retryable: false, kind: "auth", error: "Invalid API key." })).toBe("failed");
    expect(await status(id)).toBe("failed");
  });

  it("cancels a queued task at once and a running one when its attempt ends, freeing the slot", async () => {
    await agent(ALICE);
    const a = await task(ALICE);
    const b = await task(ALICE);
    const c = await claim();
    const runningId = c!.taskId;
    const queuedId = runningId === a ? b : a;
    expect((await asUser(db, ALICE).rpc("orch_cancel", { p_task: queuedId })).data).toBe("cancelled");
    expect(await status(queuedId)).toBe("cancelled");
    expect((await asUser(db, ALICE).rpc("orch_cancel", { p_task: runningId })).data).toBe("cancelled");
    expect((await asService(db).rpc("orch_attempt_state", { p_attempt: c!.attemptId, p_lease: c!.leaseId })).data).toBe("cancelled");
    expect(await activeSlots()).toBe(1); // still executing until the worker stops
    expect(await finish(c!, "cancelled", { error: "Cancelled." })).toBe("cancelled");
    expect(await activeSlots()).toBe(0);
    expect(await status(runningId)).toBe("cancelled");
  });

  it("ignores a duplicate or late finish: the first one counts, the slot is released once", async () => {
    await agent(ALICE);
    await task(ALICE);
    await task(ALICE);
    const c = await claim();
    expect(await finish(c!, "succeeded")).toBe("completed");
    const other = await claim();
    expect(other).not.toBeNull();
    expect(await finish(c!, "failed")).toBe("stale");
    expect(await activeSlots()).toBe(1); // the other attempt's slot is untouched
    expect(await finish({ ...other!, leaseId: c!.leaseId }, "succeeded")).toBe("stale"); // wrong lease
  });
});

describe("recovery after a crash", () => {
  it("reclaims an expired lease, records the attempt as interrupted (outcome unknown) and retries the task", async () => {
    await agent(ALICE, { max_attempts: 2 });
    const id = await task(ALICE, { max_attempts: 2 });
    const c = await claim();
    await q("update public.orch_attempts set expires_at = now() - interval '1 second'");
    await q("update public.orch_slots set expires_at = now() - interval '1 second' where lease_id is not null");
    const again = await claim();
    expect(again).toMatchObject({ taskId: id, attemptNo: 2 });
    expect(await q("select status, error_kind from public.orch_attempts where id = $1", [c!.attemptId])).toEqual([{ status: "interrupted", error_kind: "interrupted" }]);
    expect(await activeSlots()).toBe(1);
    expect(await finish(c!, "succeeded")).toBe("stale"); // the crashed worker's late result is discarded
  });

  it("never runs more than the limit after a crash: expired leases are freed before new work starts", async () => {
    await agent(ALICE, { max_attempts: 3 });
    for (let i = 0; i < 6; i++) await task(ALICE, { max_attempts: 3 });
    for (let i = 0; i < 3; i++) await claim();
    await q("update public.orch_attempts set expires_at = now() - interval '1 second' where status = 'running'");
    await q("update public.orch_slots set expires_at = now() - interval '1 second' where lease_id is not null");
    const after = [await claim(), await claim(), await claim(), await claim()];
    expect(after.filter(Boolean)).toHaveLength(3);
    expect(await running()).toBe(3);
    expect(await activeSlots()).toBe(3);
    expect(Number((await q<{ n: string }>("select count(*)::text n from public.orch_attempts where status = 'interrupted'"))[0]!.n)).toBe(3);
  });

  it("keeps queued work across a restart (it's only in the database)", async () => {
    await agent(ALICE);
    const id = await task(ALICE);
    // A "restart": nothing in memory survives; the next worker finds the task in the queue.
    expect((await claim("fresh-worker"))!.taskId).toBe(id);
  });
});

describe("dependencies and lifecycle", () => {
  it("blocks a task until its dependencies complete, and fails it when one fails", async () => {
    await agent(ALICE);
    const a = await task(ALICE, { title: "A" });
    const b = await task(ALICE, { title: "B", depends_on: [a] });
    const c = await task(ALICE, { title: "C", depends_on: [b] });
    expect([await status(b), await status(c)]).toEqual(["blocked", "blocked"]);
    const ca = await claim();
    expect(ca!.taskId).toBe(a);
    expect(await claim()).toBeNull(); // b and c are blocked
    await finish(ca!, "succeeded");
    expect(await status(b)).toBe("queued");
    await finish((await claim())!, "failed", { retryable: false });
    expect(await status(c)).toBe("failed");
    expect((await q<{ error: string }>("select error from public.orch_tasks where id = $1", [c]))[0]!.error).toBe('Not run: dependency "B" failed.');
  });

  it("refuses a dependency that already failed, or one from someone else", async () => {
    await agent(ALICE);
    const a = await task(ALICE);
    await finish((await claim())!, "failed");
    await expect(task(ALICE, { depends_on: [a] })).rejects.toThrow(/has failed/);
    const carols = await task(CAROL);
    await expect(task(ALICE, { depends_on: [carols] })).rejects.toThrow(/Dependency not found/);
  });

  it("only allows lifecycle transitions that make sense", async () => {
    await agent(ALICE);
    const id = await task(ALICE);
    await expect(q("update public.orch_tasks set status = 'completed' where id = $1", [id])).rejects.toThrow(/Invalid task status change: queued → completed/);
    await asUser(db, ALICE).rpc("orch_cancel", { p_task: id });
    await expect(q("update public.orch_tasks set status = 'queued' where id = $1", [id])).rejects.toThrow(/cancelled → queued/);
    const events = await q<{ kind: string; to_status: string }>("select kind, to_status from public.orch_events where task_id = $1 order by id", [id]);
    expect(events).toEqual([
      { kind: "created", to_status: "queued" },
      { kind: "status", to_status: "cancelled" },
    ]);
  });

  it("cancelling a planning task cancels its sub-tasks", async () => {
    await agent(ALICE);
    const parent = await task(ALICE, { kind: "plan", task_type: "plan" });
    const child = await task(ALICE, { parent_id: parent });
    await asUser(db, ALICE).rpc("orch_cancel", { p_task: parent });
    expect(await status(child)).toBe("cancelled");
  });

  it("cancelling a planning task that already finished still cancels the work it planned", async () => {
    await agent(ALICE, { role: "lead_developer", task_types: ["plan"] });
    await agent(ALICE);
    const parent = await task(ALICE, { kind: "plan", task_type: "plan" });
    const c = await claim();
    const child = await task(ALICE, { parent_id: parent, depends_on: [parent] });
    expect(await finish(c!, "succeeded")).toBe("completed");
    expect(await status(child)).toBe("queued");
    const { data } = await asUser(db, ALICE).rpc("orch_cancel", { p_task: parent });
    expect(data).toBe("completed"); // the plan itself stays completed
    expect(await status(child)).toBe("cancelled");
  });
});

describe("agents", () => {
  it("gives disabled agents no new work; tasks locked to one wait, and run again once it's enabled", async () => {
    const off = await agent(ALICE, { enabled: false, name: "Off" });
    const free = await task(ALICE);
    expect(await claim()).toBeNull(); // the only agent is disabled
    expect(await status(free)).toBe("blocked");
    const locked = await task(ALICE, { agent_id: off, agent_locked: true });
    expect(await claim()).toBeNull();
    expect((await q<{ status_reason: string }>("select status_reason from public.orch_tasks where id = $1", [locked]))[0]!.status_reason).toBe('Waiting: agent "Off" is disabled.');
    await asUser(db, ALICE).from("orch_agents").update({ enabled: true }).eq("id", off);
    expect([await status(free), await status(locked)]).toEqual(["queued", "queued"]);
    expect((await claim())!.agentId).toBe(off);
  });

  it("picks an enabled agent that handles the task type, highest priority first", async () => {
    const backend = await agent(ALICE, { name: "Backend", task_types: ["backend"], priority: 40 });
    const reviewer = await agent(ALICE, { name: "Reviewer", role: "code_reviewer", task_types: ["review"], priority: 90 });
    await agent(ALICE, { name: "Generalist", priority: 10 });
    await task(ALICE, { task_type: "review" });
    expect((await claim())!.agentId).toBe(reviewer);
    await task(ALICE, { task_type: "backend" });
    expect((await claim())!.agentId).toBe(backend);
  });

  it("keeps a deleted agent's task history (what ran, with which model)", async () => {
    const id = await agent(ALICE, { name: "Temp", model_id: "claude-sonnet" });
    const t = await task(ALICE);
    await finish((await claim())!, "succeeded");
    await asUser(db, ALICE).from("orch_agents").delete().eq("id", id);
    expect(await q("select status, agent_id, agent_name, model_id from public.orch_tasks where id = $1", [t])).toEqual([{ status: "completed", agent_id: null, agent_name: "Temp", model_id: "claude-sonnet" }]);
    expect(await q("select agent_name, status from public.orch_attempts where task_id = $1", [t])).toEqual([{ agent_name: "Temp", status: "succeeded" }]);
  });

  it("rejects settings outside the allowed ranges", async () => {
    await expect(agent(ALICE, { timeout_seconds: 600 })).rejects.toThrow(/check constraint/);
    await expect(agent(ALICE, { max_attempts: 9 })).rejects.toThrow(/check constraint/);
    await expect(agent(ALICE, { role: "overlord" })).rejects.toThrow(/check constraint/);
  });
});

describe("access", () => {
  it("lets only administrators see or create profiles and tasks, each only their own", async () => {
    await agent(ALICE, { name: "Alice's" });
    await task(ALICE);
    for (const t of ["orch_agents", "orch_tasks", "orch_attempts", "orch_events", "orch_slots", "orch_settings"]) {
      expect((await asUser(db, BOB).from(t).select("*")).data).toEqual([]);
    }
    expect((await asUser(db, CAROL).from("orch_agents").select("*")).data).toEqual([]);
    expect((await asUser(db, CAROL).from("orch_tasks").select("*")).data).toEqual([]);
    const bobAgent = await asUser(db, BOB).from("orch_agents").insert({ name: "x", role: "custom", provider: "anthropic", model_id: "m" });
    expect(bobAgent.error?.message).toMatch(/row-level security/);
    const bobTask = await asUser(db, BOB).from("orch_tasks").insert({ title: "x" });
    expect(bobTask.error?.message).toMatch(/row-level security/);
  });

  it("refuses another owner's project, agent or task", async () => {
    const carolAgent = await agent(CAROL);
    await expect(task(ALICE, { project_id: CAROL_PROJECT })).rejects.toThrow(/Project not found/);
    await expect(task(ALICE, { agent_id: carolAgent })).rejects.toThrow(/Agent not found/);
    const t = await task(CAROL);
    const r = await asUser(db, ALICE).rpc("orch_cancel", { p_task: t });
    expect(r.error?.message).toMatch(/Task not found/);
  });

  it("never lets a user set a task's status, attempts or output, or call the queue functions", async () => {
    await agent(ALICE);
    const forged = await asUser(db, ALICE).from("orch_tasks").insert({ title: "x", project_id: ALICE_PROJECT, status: "completed", output: "fake" });
    expect(forged.error?.message).toMatch(/permission denied/);
    const id = await task(ALICE);
    const upd = await asUser(db, ALICE).from("orch_tasks").update({ status: "completed" }).eq("id", id);
    expect(upd.error?.message).toMatch(/permission denied/);
    for (const [fn, args] of [
      ["orch_claim", { p_worker: "me" }],
      ["orch_reconcile", {}],
      ["orch_acquire_slot", { p_seconds: 10, p_purpose: "x", p_owner: ALICE }],
    ] as const) {
      expect((await asUser(db, ALICE).rpc(fn, args)).error?.message).toMatch(/permission denied/);
    }
    expect((await asUser(db, BOB).rpc("orch_cancel", { p_task: id })).error?.message).toMatch(/Not allowed/);
  });
});
