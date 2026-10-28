/**
 * The orchestrator's HTTP API: the real route handlers and service layer against the real migrations (PGlite, with
 * row-level security), with only the signed-in user and the worker kick replaced. Covers who may call what, input
 * validation, agent profiles (create, read, update, enable/disable, delete with history kept), tasks, settings, and
 * that no credential ever appears in a response.
 *
 * No AI provider is called: provider credentials are cleared, so the live check stops at "not configured" (or at the
 * slot limit) before any request leaves the process.
 */
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALICE, ALICE_PROJECT, BOB, CAROL, CAROL_PROJECT, asService, asUser, orchDb, resetOrch } from "./helpers/orch-db";

const state = { user: null as string | null, paused: null as string | null, kicks: 0, after: [] as (() => unknown)[] };
let db: PGlite;

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => state.after.push(fn) }));
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  requireUser: async () => {
    const { ApiError } = await import("@/lib/http");
    if (!state.user) throw new ApiError("unauthorized", "Please sign in to continue.");
    return { mode: "authenticated", user: { id: state.user, email: "x@x.test" }, supabase: asUser(db, state.user) };
  },
}));
// The real limiter, fresh for each test (so one test's requests don't count against the next).
const limiters = new Map<string, import("@/lib/rate-limit").MemoryRateLimiter>();
vi.mock("@/lib/rate-limit", async (orig) => {
  const real = await orig<typeof import("@/lib/rate-limit")>();
  return { ...real, limiter: (name: string, limit: number, ms: number) => limiters.get(`${name}:${limit}`) ?? limiters.set(`${name}:${limit}`, new real.MemoryRateLimiter(limit, ms)).get(`${name}:${limit}`)! };
});
vi.mock("@/lib/supabase/admin", () => ({ serviceSupabase: () => asService(db) }));
vi.mock("@/lib/orchestrator/background", async () => {
  const { workerAuthorized } = await import("@/lib/code/agent/background");
  return {
    workerAuthorized,
    WORKER_BUDGET_MS: 285_000,
    kickOrchestrator: async () => void state.kicks++,
    orchestratorPaused: async () => state.paused,
    productionWorkerDeps: () => null,
  };
});

const agents = await import("@/app/api/orchestrator/agents/route");
const agentById = await import("@/app/api/orchestrator/agents/[id]/route");
const agentTasks = await import("@/app/api/orchestrator/agents/[id]/tasks/route");
const tasks = await import("@/app/api/orchestrator/tasks/route");
const taskById = await import("@/app/api/orchestrator/tasks/[id]/route");
const cancel = await import("@/app/api/orchestrator/tasks/[id]/cancel/route");
const settings = await import("@/app/api/orchestrator/settings/route");
const providers = await import("@/app/api/orchestrator/providers/route");
const providerCheck = await import("@/app/api/orchestrator/providers/check/route");
const worker = await import("@/app/api/orchestrator/worker/route");

const URL_ = "https://orbis.test/api/orchestrator";
const req = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${URL_}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
async function call(res: Promise<Response> | Response) {
  const r = await res;
  // Response bodies are checked field by field below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}
const as = (user: string | null) => (state.user = user);
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

const AGENT = { name: "Backend Bot", role: "backend_developer", provider: "anthropic", modelId: "anthropic:claude-haiku-5-5", taskTypes: ["backend"] };
async function makeAgent(o: Record<string, unknown> = {}) {
  const r = await call(agents.POST(req("/agents", "POST", { ...AGENT, ...o })));
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body.agent as { id: string; name: string; enabled: boolean };
}

const FAKE_KEY = "sk-ant-api03-THIS-IS-A-FAKE-TEST-KEY-0000000000000000";

beforeAll(async () => {
  db = await orchDb();
}, 120_000);
afterAll(() => db.close());
beforeEach(async () => {
  await resetOrch(db);
  await db.exec("delete from public.admin_audit");
  Object.assign(state, { user: ALICE, paused: null, kicks: 0, after: [] });
  limiters.clear();
  for (const v of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY", "HUGGINGFACE_API_KEY"]) vi.stubEnv(v, "");
});

describe("who may call the orchestrator", () => {
  const routes: [string, () => Promise<Response>][] = [
    ["GET agents", () => agents.GET()],
    ["POST agents", () => agents.POST(req("/agents", "POST", AGENT))],
    ["GET agent", () => agentById.GET(req("/agents/x"), ctx("00000000-0000-4000-8000-000000000001"))],
    ["PATCH agent", () => agentById.PATCH(req("/agents/x", "PATCH", { enabled: false }), ctx("00000000-0000-4000-8000-000000000001"))],
    ["DELETE agent", () => agentById.DELETE(req("/agents/x", "DELETE"), ctx("00000000-0000-4000-8000-000000000001"))],
    ["GET agent tasks", () => agentTasks.GET(req("/agents/x/tasks"), ctx("00000000-0000-4000-8000-000000000001"))],
    ["GET tasks", () => tasks.GET(req("/tasks"))],
    ["POST tasks", () => tasks.POST(req("/tasks", "POST", { projectId: ALICE_PROJECT, title: "t" }))],
    ["GET task", () => taskById.GET(req("/tasks/x"), ctx("00000000-0000-4000-8000-000000000001"))],
    ["cancel task", () => cancel.POST(req("/tasks/x/cancel", "POST"), ctx("00000000-0000-4000-8000-000000000001"))],
    ["GET settings", () => settings.GET()],
    ["PATCH settings", () => settings.PATCH(req("/settings", "PATCH", { maxConcurrency: 1 }))],
    ["GET providers", () => providers.GET()],
    ["POST provider check", () => providerCheck.POST(req("/providers/check", "POST", { provider: "anthropic", modelId: "anthropic:claude-haiku-5-5" }))],
  ];

  it("refuses every route when signed out (401)", async () => {
    as(null);
    for (const [name, fn] of routes) expect([name, (await fn()).status]).toEqual([name, 401]);
  });

  it("refuses every route to a signed-in user who isn't an administrator (403)", async () => {
    as(BOB);
    for (const [name, fn] of routes) expect([name, (await fn()).status]).toEqual([name, 403]);
    expect(await q("select * from public.orch_agents")).toEqual([]);
    expect(await q("select * from public.orch_tasks")).toEqual([]);
  });

  it("rate-limits each administrator (30 agent creations a minute)", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await agents.POST(req("/agents", "POST", { ...AGENT, name: `A${i}` }))).status);
    expect(codes.slice(0, 30).every((c) => c === 201)).toBe(true);
    expect(codes[30]).toBe(429);
  });

  it("only lets the worker route run with the worker secret", async () => {
    vi.stubEnv("CRON_SECRET", "worker-secret-for-tests-0123456789");
    expect((await worker.POST(req("/worker", "POST", {}))).status).toBe(401);
    expect((await worker.POST(req("/worker", "POST", {}, { authorization: "Bearer wrong" }))).status).toBe(401);
    as(ALICE); // a signed-in administrator is not enough either
    expect((await worker.POST(req("/worker", "POST", {}))).status).toBe(401);
    // With the secret it gets past authorization (and reports that the worker isn't configured in this test).
    expect((await worker.POST(req("/worker", "POST", {}, { authorization: "Bearer worker-secret-for-tests-0123456789" }))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "");
    expect((await worker.POST(req("/worker", "POST", {}, { authorization: "Bearer " }))).status).toBe(401);
  });
});

describe("agent profiles", () => {
  it("creates a profile, reports missing credentials as a warning, and records it in the admin audit log", async () => {
    const r = await call(agents.POST(req("/agents", "POST", { ...AGENT, systemInstructions: "Be careful.", allowedTools: ["read_project"], priority: 80, timeoutSeconds: 90, maxAttempts: 3, retryBackoffSeconds: 10 })));
    expect(r.status).toBe(201);
    expect(r.body.agent).toMatchObject({ name: "Backend Bot", role: "backend_developer", provider: "anthropic", modelId: "anthropic:claude-haiku-5-5", enabled: true, allowedTools: ["read_project"], taskTypes: ["backend"], priority: 80, timeoutSeconds: 90, maxAttempts: 3, retryBackoffSeconds: 10 });
    expect(r.body.agent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.body.agent.createdAt).toBeTruthy();
    expect(r.body.warnings.join(" ")).toMatch(/ANTHROPIC_API_KEY/);
    expect(await q("select action, target from public.admin_audit")).toEqual([{ action: "orchestrator.agent.create", target: "Backend Bot" }]);
  });

  it("refuses unknown providers, unregistered models, unknown fields, out-of-range limits and tools that don't exist yet", async () => {
    const bad = async (o: Record<string, unknown>) => (await call(agents.POST(req("/agents", "POST", { ...AGENT, ...o })))).status;
    expect(await bad({ provider: "acme" })).toBe(400);
    expect(await bad({ modelId: "anthropic:claude-nonexistent-9" })).toBe(400);
    expect(await bad({ ownerId: BOB })).toBe(400);
    expect(await bad({ timeoutSeconds: 9999 })).toBe(400);
    expect(await bad({ maxAttempts: 50 })).toBe(400);
    expect(await bad({ role: "god_mode" })).toBe(400);
    const r = await call(agents.POST(req("/agents", "POST", { ...AGENT, allowedTools: ["run_commands"] })));
    expect(r.status).toBe(400);
    expect(r.body.error.message ?? JSON.stringify(r.body)).toMatch(/run_commands/);
    expect(await q("select * from public.orch_agents")).toEqual([]);
  });

  it("has no limit on the number of profiles, and names are unique per administrator", async () => {
    for (let i = 0; i < 25; i++) await makeAgent({ name: `Agent ${i}` });
    expect((await call(agents.GET())).body.agents).toHaveLength(25);
    expect((await call(agents.POST(req("/agents", "POST", { ...AGENT, name: "Agent 3" })))).status).toBe(409);
    as(CAROL); // another administrator may use the same name
    expect((await call(agents.POST(req("/agents", "POST", { ...AGENT, name: "Agent 3" })))).status).toBe(201);
  });

  it("updates a profile in place: switches the model, disables and re-enables it", async () => {
    const a = await makeAgent();
    const m = await call(agentById.PATCH(req("/agents/x", "PATCH", { provider: "openai", modelId: "openai:gpt-5.6-luna" }), ctx(a.id)));
    expect(m.status).toBe(200);
    expect(m.body.agent).toMatchObject({ id: a.id, provider: "openai", modelId: "openai:gpt-5.6-luna" });
    expect((await call(agentById.PATCH(req("/agents/x", "PATCH", { modelId: "not-a-model" }), ctx(a.id)))).status).toBe(400);
    expect((await call(agentById.PATCH(req("/agents/x", "PATCH", {}), ctx(a.id)))).status).toBe(400);
    expect((await call(agentById.PATCH(req("/agents/x", "PATCH", { enabled: false }), ctx(a.id)))).body.agent.enabled).toBe(false);
    expect((await call(agentById.GET(req("/agents/x"), ctx(a.id)))).body.agent.enabled).toBe(false);
    expect((await call(agentById.PATCH(req("/agents/x", "PATCH", { enabled: true }), ctx(a.id)))).body.agent.enabled).toBe(true);
    expect((await q<{ action: string }>("select action from public.admin_audit order by created_at")).map((r) => r.action)).toEqual([
      "orchestrator.agent.create",
      "orchestrator.agent.update",
      "orchestrator.agent.disable",
      "orchestrator.agent.enable",
    ]);
  });

  it("won't assign a new task to a disabled agent", async () => {
    const a = await makeAgent();
    await call(agentById.PATCH(req("/agents/x", "PATCH", { enabled: false }), ctx(a.id)));
    const r = await call(tasks.POST(req("/tasks", "POST", { projectId: ALICE_PROJECT, title: "Fix it", agentId: a.id })));
    expect(r.status).toBe(409);
    expect(await q("select * from public.orch_tasks")).toEqual([]);
  });

  it("deletes a profile but keeps its task history, and lists an agent's tasks", async () => {
    const a = await makeAgent();
    const t = (await call(tasks.POST(req("/tasks", "POST", { projectId: ALICE_PROJECT, title: "Fix it", agentId: a.id })))).body.task;
    expect((await call(agentTasks.GET(req("/agents/x/tasks"), ctx(a.id)))).body.tasks.map((x: { id: string }) => x.id)).toEqual([t.id]);
    // Run it to completion through the queue so there's history.
    const { data: claim } = await asService(db).rpc("orch_claim", { p_worker: "w", p_max_seconds: 270 });
    // Can't delete while it runs.
    expect((await call(agentById.DELETE(req("/agents/x", "DELETE"), ctx(a.id)))).status).toBe(409);
    const c = claim as { attemptId: string; leaseId: string };
    await asService(db).rpc("orch_finish", { p_attempt: c.attemptId, p_lease: c.leaseId, p_outcome: "succeeded", p_output: "ok", p_error: null, p_error_kind: null, p_retryable: false, p_usage: {} });
    expect((await call(agentById.DELETE(req("/agents/x", "DELETE"), ctx(a.id)))).body).toEqual({ deleted: true });
    expect((await call(agentById.GET(req("/agents/x"), ctx(a.id)))).status).toBe(404);
    const detail = await call(taskById.GET(req("/tasks/x"), ctx(t.id)));
    expect(detail.body.task).toMatchObject({ status: "completed", output: "ok", agentName: "Backend Bot", modelId: "anthropic:claude-haiku-5-5" });
    expect(detail.body.attempts).toHaveLength(1);
    expect(detail.body.attempts[0]).toMatchObject({ agentName: "Backend Bot", status: "succeeded" });
  });

  it("keeps each administrator's agents private", async () => {
    const a = await makeAgent();
    as(CAROL);
    expect((await call(agents.GET())).body.agents).toEqual([]);
    expect((await call(agentById.GET(req("/agents/x"), ctx(a.id)))).status).toBe(404);
    expect((await call(agentById.PATCH(req("/agents/x", "PATCH", { enabled: false }), ctx(a.id)))).status).toBe(404);
    expect((await call(agentById.DELETE(req("/agents/x", "DELETE"), ctx(a.id)))).status).toBe(404);
    expect((await call(tasks.POST(req("/tasks", "POST", { projectId: CAROL_PROJECT, title: "x", agentId: a.id })))).status).toBe(404);
    as(ALICE);
    expect((await call(agentById.GET(req("/agents/x"), ctx(a.id)))).body.agent.enabled).toBe(true);
  });
});

describe("tasks", () => {
  it("queues a task (not running it) and asks for a worker", async () => {
    await makeAgent();
    // Creating an enabled agent also asks for a worker (tasks waiting for one are queued again).
    expect(state.after).toHaveLength(1);
    state.after.length = 0;
    const r = await call(tasks.POST(req("/tasks", "POST", { projectId: ALICE_PROJECT, title: "Add input validation", input: "In src/app.ts", taskType: "backend" })));
    expect(r.status).toBe(201);
    expect(r.body.task).toMatchObject({ status: "queued", title: "Add input validation", taskType: "backend", attempts: 0 });
    expect(state.after).toHaveLength(1);
    await state.after[0]!();
    expect(state.kicks).toBe(1);
    expect(await q("select count(*)::int as n from public.orch_slots where lease_id is not null")).toEqual([{ n: 0 }]);
  });

  it("validates task input and refuses someone else's project", async () => {
    expect((await call(tasks.POST(req("/tasks", "POST", { projectId: "nope", title: "x" })))).status).toBe(400);
    expect((await call(tasks.POST(req("/tasks", "POST", { projectId: ALICE_PROJECT, title: "" })))).status).toBe(400);
    expect((await call(tasks.POST(req("/tasks", "POST", { projectId: ALICE_PROJECT, title: "x", status: "completed" })))).status).toBe(400);
    expect((await call(tasks.POST(req("/tasks", "POST", { projectId: ALICE_PROJECT, title: "x", kind: "deploy" })))).status).toBe(400);
    const r = await call(tasks.POST(req("/tasks", "POST", { projectId: CAROL_PROJECT, title: "x" })));
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(await q("select * from public.orch_tasks")).toEqual([]);
  });

  it("lists with filters, shows details and cancels", async () => {
    await makeAgent();
    const t1 = (await call(tasks.POST(req("/tasks", "POST", { projectId: ALICE_PROJECT, title: "One" })))).body.task;
    const t2 = (await call(tasks.POST(req("/tasks", "POST", { projectId: ALICE_PROJECT, title: "Two", dependsOn: [t1.id] })))).body.task;
    expect(t2.status).toBe("blocked");
    expect((await call(tasks.GET(req("/tasks?status=blocked")))).body.tasks.map((t: { id: string }) => t.id)).toEqual([t2.id]);
    expect((await call(tasks.GET(req("/tasks?status=bogus")))).status).toBe(400);
    const c = await call(cancel.POST(req("/tasks/x/cancel", "POST"), ctx(t1.id)));
    expect(c.body).toEqual({ status: "cancelled" });
    // Its dependent can never run now.
    const d = await call(taskById.GET(req("/tasks/x"), ctx(t2.id)));
    expect(d.body.task).toMatchObject({ status: "failed", error: expect.stringMatching(/Not run: dependency "One" cancelled/) });
    expect(d.body.events.length).toBeGreaterThan(0);
    as(CAROL);
    expect((await call(taskById.GET(req("/tasks/x"), ctx(t1.id)))).status).toBe(404);
    expect((await call(tasks.GET(req("/tasks")))).body.tasks).toEqual([]);
  });
});

describe("settings, providers and secrets", () => {
  it("shows the three slots and accepts a limit of 1–3 only", async () => {
    const s = await call(settings.GET());
    expect(s.body).toMatchObject({ maxConcurrency: 3, hardLimit: 3 });
    expect(s.body.slots).toHaveLength(3);
    for (const v of [0, 4, 10, 2.5, "3"]) expect((await call(settings.PATCH(req("/settings", "PATCH", { maxConcurrency: v })))).status).toBe(400);
    expect((await call(settings.PATCH(req("/settings", "PATCH", { maxConcurrency: 2 })))).body.maxConcurrency).toBe(2);
    expect(await q("select max_concurrency from public.orch_settings")).toEqual([{ max_concurrency: 2 }]);
    expect(await q("select action from public.admin_audit")).toEqual([{ action: "orchestrator.settings" }]);
  });

  it("lists providers with their configuration state and never a credential", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", FAKE_KEY);
    const r = await call(providers.GET());
    expect(r.status).toBe(200);
    const anthropic = r.body.providers.find((p: { id: string }) => p.id === "anthropic");
    expect(anthropic).toMatchObject({ configured: true, credentialEnvVar: "ANTHROPIC_API_KEY" });
    expect(r.body.providers.find((p: { id: string }) => p.id === "openai")).toMatchObject({ configured: false, credentialEnvVar: "OPENAI_API_KEY" });
    expect(JSON.stringify(r.body)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(r.body)).not.toContain("FAKE-TEST-KEY");
  });

  it("reports missing credentials from a live check without calling anyone, and frees its slot", async () => {
    const r = await call(providerCheck.POST(req("/providers/check", "POST", { provider: "anthropic", modelId: "anthropic:claude-haiku-5-5" })));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: false, errorKind: "not_configured" });
    expect(r.body.error).toMatch(/ANTHROPIC_API_KEY/);
    expect(await q("select count(*)::int as n from public.orch_slots where lease_id is not null")).toEqual([{ n: 0 }]);
  });

  it("refuses a live check when all execution slots are busy, or while dispatch is paused", async () => {
    for (let i = 0; i < 3; i++) await asService(db).rpc("orch_acquire_slot", { p_seconds: 60, p_purpose: "task", p_owner: CAROL });
    expect((await call(providerCheck.POST(req("/providers/check", "POST", { provider: "anthropic", modelId: "anthropic:claude-haiku-5-5" })))).status).toBe(429);
    await resetOrch(db);
    state.paused = "Orbis Bastion is in lockdown.";
    expect((await call(providerCheck.POST(req("/providers/check", "POST", { provider: "anthropic", modelId: "anthropic:claude-haiku-5-5" })))).status).toBe(403);
  });

  it("doesn't show another administrator's task in the slot list", async () => {
    await asService(db).rpc("orch_acquire_slot", { p_seconds: 60, p_purpose: "task", p_owner: CAROL });
    const s = await call(settings.GET());
    const busy = s.body.slots.filter((x: { busy: boolean }) => x.busy);
    expect(busy).toHaveLength(1);
    expect(busy[0].taskId).toBeNull();
  });
});
