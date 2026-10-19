/**
 * Server-side usage policy with a fake Supabase client (mocked; the SQL itself
 * is tested in usage-ledger.test.ts and plans-billing.test.ts): entitlements,
 * plan model access, reservations with the monthly AI budget, charging by the
 * model that actually answered, refunds and idempotency.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MODELS } from "@/lib/ai/registry";
import type { AuthContext } from "@/lib/auth";
import { ApiError } from "@/lib/http";
import { enforceLimits, planUsage, recordRun, redactSecrets } from "@/lib/usage";
import { DEFAULT_BILLING, planEconomics } from "@/lib/plans";

const haiku = DEFAULT_MODELS.find((m) => m.id === "anthropic:claude-haiku-5-5")!;
const sonnet = DEFAULT_MODELS.find((m) => m.id === "anthropic:claude-sonnet-5-5")!;
const opus = DEFAULT_MODELS.find((m) => m.id === "anthropic:claude-opus-5-5")!;
const req = () => new Request("http://x/api/chat", { headers: { "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });

// Real providers configured, so the lowest-cost available model is Claude Haiku.
beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.OPENAI_API_KEY = "test-key";
});
afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

type FakeRun = { estimated_cost: number | null; input_tokens: number | null; output_tokens: number | null };

/** The budget rules of usage_reserve_v2, over the fake's recorded runs (the SQL is tested separately). */
function fakeReserveV2(a: Record<string, unknown>, runs: FakeRun[]) {
  if (a.p_budget_usd === null) return { ok: true };
  const fin = Number(a.p_fallback_in);
  const fout = Number(a.p_fallback_out);
  const spent = runs.reduce((t, r) => t + (r.estimated_cost ?? ((r.input_tokens ?? 2000) * fin + (r.output_tokens ?? 1000) * fout) / 1e6), 0);
  const budget = Number(a.p_budget_usd);
  const est = Number(a.p_est_cost_usd);
  if (spent >= budget) return { ok: false, reason: "budget", scope: "exhausted" };
  if (spent + est > budget) return { ok: false, reason: "budget", scope: "insufficient" };
  if (a.p_premium && spent + est > budget * Number(a.p_premium_share)) return { ok: false, reason: "budget", scope: "economy" };
  return { ok: true };
}

function fakeAuth(opts: { admin?: boolean; plan?: Record<string, unknown> | null; reserve?: (a: Record<string, unknown>) => unknown; runs?: FakeRun[] } = {}) {
  const rpc: [string, Record<string, unknown>][] = [];
  const inserts: Record<string, unknown>[] = [];
  const supabase = {
    from(table: string) {
      const q = {
        select: () => q,
        eq: () => q,
        gte: () => q,
        gt: () => q,
        contains: () => q,
        limit: async () => ({ data: opts.runs ?? [], error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ count: 0, data: [], error: null }),
        maybeSingle: async () => ({ data: table === "admins" ? (opts.admin ? { user_id: "u" } : null) : (opts.plan ?? null), error: null }),
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          return { error: null };
        },
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpc.push([fn, args]);
      if (fn === "usage_reserve_v2") return { data: opts.reserve ? opts.reserve(args) : fakeReserveV2(args, opts.runs ?? []), error: null };
      if (fn === "usage_status") return { data: [{ window_used: 3, window_start: "2026-10-19T10:00:00Z", week_used: 20, week_oldest: "2026-10-15T08:00:00Z" }], error: null };
      return { data: null, error: null };
    },
  };
  const auth = { mode: "authenticated", user: { id: `u-${Math.random().toString(36).slice(2)}`, email: "u@example.com" }, supabase } as unknown as AuthContext;
  return { auth, rpc, inserts };
}

const PRO = { plan: "pro", status: "active", billing_interval: "month", current_period_start: new Date(Date.now() - 5 * 86_400_000).toISOString() };
const MAX = { ...PRO, plan: "max" };
const fail = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e) as Promise<ApiError>;

const run = (model = haiku, extra: Partial<Parameters<typeof recordRun>[1]> = {}) => ({
  model,
  prompt: "hi",
  response: "hello",
  latencyMs: 10,
  usage: { inputTokens: 5, outputTokens: 2, estimated: false },
  status: "success" as const,
  ...extra,
});

afterEach(() => {
  delete process.env.NOVA_ADMINS_UNLIMITED;
});

describe("usage policy", () => {
  it("reserves a Free user's units by model tier against the Free limits and budget", async () => {
    const { auth, rpc } = fakeAuth();
    const t = await enforceLimits(req(), auth, 1, [haiku], { requestId: "00000000-0000-4000-8000-000000000001", purpose: "chat" });
    expect(t).toMatchObject({ units: 1, entitlement: "plan:free", requestId: "00000000-0000-4000-8000-000000000001" });
    expect(rpc[0]).toEqual(["usage_reserve_v2", expect.objectContaining({ p_units: 1, p_window_limit: 10, p_week_limit: 30, p_purpose: "chat", p_budget_usd: 0.1, p_premium: false })]);
    expect(t.estCostUsd).toBeGreaterThan(0);
  });

  it("uses Pro and Max limits only for an active subscription", async () => {
    const pro = fakeAuth({ plan: PRO });
    await enforceLimits(req(), pro.auth, 1, [sonnet]);
    expect(pro.rpc[0]![1]).toMatchObject({ p_units: 20, p_window_limit: 200, p_week_limit: 1100, p_budget_usd: planEconomics(DEFAULT_BILLING, "pro").aiBudgetUsd, p_premium: true });
    const max = fakeAuth({ plan: MAX });
    await enforceLimits(req(), max.auth, 1, [opus]);
    expect(max.rpc[0]![1]).toMatchObject({ p_units: 40, p_window_limit: 600, p_budget_usd: planEconomics(DEFAULT_BILLING, "max").aiBudgetUsd });
    const lapsed = fakeAuth({ plan: { ...PRO, status: "canceled" } });
    await enforceLimits(req(), lapsed.auth, 1, [haiku]);
    expect(lapsed.rpc[0]![1]).toMatchObject({ p_window_limit: 10 });
  });

  it("refuses a model outside the plan, naming the plan and same-provider alternatives, without switching", async () => {
    const free = fakeAuth();
    const err = await fail(enforceLimits(req(), free.auth, 1, [sonnet]));
    expect(err.code).toBe("plan_required");
    expect((await import("@/lib/http")).errorResponse(err).status).toBe(403);
    expect(err.message).toMatch(/Claude Sonnet 5\.5 is included in the Pro plan/);
    expect(err.message).toMatch(/Claude Haiku 5\.5/);
    expect(err.message).not.toMatch(/GPT/); // same provider first
    expect(err.details).toMatchObject({ requiredPlan: "pro", modelId: sonnet.id });
    expect((err.details as { alternatives: string[] }).alternatives).toContain(haiku.id);
    expect(free.rpc).toHaveLength(0); // nothing reserved

    const pro = fakeAuth({ plan: PRO });
    expect((await fail(enforceLimits(req(), pro.auth, 1, [opus]))).details).toMatchObject({ requiredPlan: "max" });
  });

  it("explains a block, including what a larger model costs and the upgrade", async () => {
    const { auth } = fakeAuth({ plan: PRO, reserve: () => ({ ok: false, reason: "limit", scope: "window", used: 190, limit: 200, resets_at: "2026-10-19T15:00:00Z" }) });
    const err = await fail(enforceLimits(req(), auth, 1, [sonnet]));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("quota_exceeded");
    expect(err.message).toBe("Claude Sonnet 5.5 uses 20 units per message, but only 10 of your Pro plan's 5-hour allowance are left. Auto or a lighter model uses 1. Max gives you more.");
    expect(err.details).toMatchObject({ scope: "window", resetsAt: "2026-10-19T15:00:00.000Z", unitsNeeded: 20, unitsLeft: 10, upgradeTo: "max" });
  });

  it("refuses a duplicate submission with 409", async () => {
    const { auth } = fakeAuth({ reserve: () => ({ ok: false, reason: "duplicate" }) });
    const err = await fail(enforceLimits(req(), auth, 1, [haiku]));
    expect(err.code).toBe("conflict");
  });

  it("gives administrators no allowance or budget, enforced on the server, and records it", async () => {
    const { auth, rpc, inserts } = fakeAuth({ admin: true });
    const t = await enforceLimits(req(), auth, 1, [opus]);
    expect(t).toMatchObject({ units: 40, entitlement: "admin_unlimited" });
    // Still reserved (so duplicates are refused), but with no limit.
    expect(rpc[0]).toEqual(["usage_reserve_v2", expect.objectContaining({ p_window_limit: 1_000_000_000, p_week_limit: 1_000_000_000, p_budget_usd: null })]);
    expect(await planUsage(auth)).toBeNull();
    await recordRun(auth, run(sonnet));
    expect(inserts[0]).toMatchObject({ entitlement: "admin_unlimited", units: 20 });
  });

  it("can switch the admin exemption off", async () => {
    process.env.NOVA_ADMINS_UNLIMITED = "false";
    const { auth, rpc } = fakeAuth({ admin: true });
    await enforceLimits(req(), auth, 1, [haiku]);
    expect(rpc[0]![1]).toMatchObject({ p_window_limit: 10 });
  });

  it("charges the model that actually answered and settles the reservation", async () => {
    const { auth, rpc, inserts } = fakeAuth({ plan: PRO });
    const t = await enforceLimits(req(), auth, 1, [sonnet], { requestId: "00000000-0000-4000-8000-000000000002" });
    expect(t.units).toBe(20);
    // Sonnet failed before any text; the fallback (Haiku) answered.
    await recordRun(auth, run(haiku, { routingReason: "Fallback from Claude Sonnet 5.5.", requestedModel: "auto", tools: ["time"] }));
    expect(inserts[0]).toMatchObject({ model_id: haiku.id, units: 1, request_id: "00000000-0000-4000-8000-000000000002", requested_model: "auto", tools: ["time"], entitlement: "plan:pro" });
    expect(rpc.at(-1)).toEqual(["usage_finish", { p_request_id: "00000000-0000-4000-8000-000000000002", p_state: "settled" }]);
  });

  it("adds the cost of web searches to the recorded cost", async () => {
    const { auth, inserts } = fakeAuth({ plan: PRO });
    await enforceLimits(req(), auth, 1, [haiku]);
    await recordRun(auth, run(haiku, { tools: ["web_search", "web_search"] }));
    await recordRun(auth, run(haiku));
    expect(Number(inserts[0]!.estimated_cost) - Number(inserts[1]!.estimated_cost)).toBeCloseTo(2 * DEFAULT_BILLING.webSearchCostUsd, 6);
  });

  it("refunds a failed call that produced no output, but charges a partial reply", async () => {
    const { auth, inserts } = fakeAuth({ plan: PRO });
    await enforceLimits(req(), auth, 1, [sonnet]);
    await recordRun(auth, run(sonnet, { status: "error", response: "", error: "Upstream 500 with key sk-ant-abcdefghijklmnop" }));
    await recordRun(auth, run(sonnet, { status: "error", response: "partial" }));
    expect(inserts.map((r) => r.units)).toEqual([0, 20]);
    expect(inserts[0]!.error_code).toBe("Upstream 500 with key [redacted]");
  });

  it("reads remaining usage and reset times from the ledger", async () => {
    const { auth } = fakeAuth();
    const u = await planUsage(auth);
    expect(u).toMatchObject({ plan: "free", window: { used: 3, limit: 10, resetsAt: Date.parse("2026-10-19T15:00:00Z") }, week: { used: 20, limit: 30, resetsAt: Date.parse("2026-10-22T08:00:00Z") } });
  });

  it("redacts secrets from stored errors", () => {
    expect(redactSecrets("Bearer abc.def-123 failed for xai-1234567890abcdef")).toBe("Bearer [redacted] failed for [redacted]");
  });
});

describe("AI budget guard", () => {
  const pro = (runs: FakeRun[]) => fakeAuth({ plan: PRO, runs });
  const spend = (usd: number): FakeRun[] => [{ estimated_cost: usd, input_tokens: 1000, output_tokens: 500 }];
  const budget = planEconomics(DEFAULT_BILLING, "pro").aiBudgetUsd; // $4.66

  it("allows any included model while under the economy threshold", async () => {
    const { auth } = pro(spend(budget * 0.5));
    await expect(enforceLimits(req(), auth, 1, [sonnet])).resolves.toMatchObject({ units: 20 });
  });

  it("from 80% of the budget, allows only the lowest-cost model", async () => {
    const { auth } = pro(spend(budget * 0.82));
    const err = await fail(enforceLimits(req(), auth, 1, [sonnet]));
    expect(err.code).toBe("quota_exceeded");
    expect(err.message).toMatch(/only the lowest-cost model \(Claude Haiku 5\.5\)/);
    expect(err.details).toMatchObject({ budget: true, state: "economy", allowedModelId: haiku.id, upgradeTo: "max" });
    const ok = pro(spend(budget * 0.82));
    await expect(enforceLimits(req(), ok.auth, 1, [haiku])).resolves.toMatchObject({ units: 1 });
  });

  it("refuses a request whose worst-case cost would exceed what's left", async () => {
    const { auth } = pro(spend(budget - 0.01));
    const err = await fail(enforceLimits(req(), auth, 1, [sonnet], { inputTokens: 3000, maxOutputTokens: 2400 }));
    expect(err.details).toMatchObject({ state: "insufficient" });
  });

  it("stops AI requests when the budget is used up, until it renews", async () => {
    const { auth } = pro(spend(budget + 0.01));
    const err = await fail(enforceLimits(req(), auth, 1, [haiku]));
    expect(err.message).toMatch(/used this month's AI budget on your Pro plan/);
    expect((err.details as { resetsAt: string }).resetsAt).toBeTruthy();
  });

  it("caps Free users with their own budget", async () => {
    const { auth } = fakeAuth({ runs: spend(0.3) });
    const err = await fail(enforceLimits(req(), auth, 1, [haiku]));
    expect(err.message).toMatch(/Free plan/);
  });

  it("counts runs without a verified price at the most expensive verified price", async () => {
    // 300 unpriced runs of 2k in + 1k out tokens at the top verified price ($4 in / $20 out per 1M): $8.40.
    const runs: FakeRun[] = Array.from({ length: 300 }, () => ({ estimated_cost: null, input_tokens: 2000, output_tokens: 1000 }));
    const { auth, rpc } = pro(runs);
    await expect(enforceLimits(req(), auth, 1, [haiku])).rejects.toThrow(/AI budget/);
    expect(rpc[0]![1]).toMatchObject({ p_fallback_in: 4, p_fallback_out: 20 });
  });

  it("doesn't apply to administrators", async () => {
    const { auth } = fakeAuth({ admin: true, runs: spend(1000) });
    await expect(enforceLimits(req(), auth, 1, [sonnet])).resolves.toMatchObject({ entitlement: "admin_unlimited" });
  });
});
