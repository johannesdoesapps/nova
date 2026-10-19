/**
 * Server-side usage policy with a fake Supabase client (mocked; the SQL itself
 * is tested in usage-ledger.test.ts): entitlements, reservations, charging by
 * the model that actually answered, refunds and idempotency.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MODELS } from "@/lib/ai/registry";
import type { AuthContext } from "@/lib/auth";
import { ApiError } from "@/lib/http";
import { enforceLimits, planUsage, recordRun, redactSecrets } from "@/lib/usage";
import { PLANS, TARGET_MARGIN, proAiBudgetUsd } from "@/lib/plans";

const haiku = DEFAULT_MODELS.find((m) => m.id === "anthropic:claude-haiku-5-5")!;
const sonnet = DEFAULT_MODELS.find((m) => m.id === "anthropic:claude-sonnet-5-5")!;
const req = () => new Request("http://x/api/chat", { headers: { "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });

type FakeRun = { estimated_cost: number | null; input_tokens: number | null; output_tokens: number | null };
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
        limit: async () => ({ data: opts.runs ?? [], error: null }),
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
      if (fn === "usage_reserve") return { data: opts.reserve ? opts.reserve(args) : { ok: true }, error: null };
      if (fn === "usage_status") return { data: [{ window_used: 3, window_start: "2026-10-19T10:00:00Z", week_used: 40, week_oldest: "2026-10-15T08:00:00Z" }], error: null };
      return { data: null, error: null };
    },
  };
  const auth = { mode: "authenticated", user: { id: "u", email: "u@example.com" }, supabase } as unknown as AuthContext;
  return { auth, rpc, inserts };
}

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
  it("reserves a Free user's units by model weight against the Free limits", async () => {
    const { auth, rpc } = fakeAuth();
    const t = await enforceLimits(req(), auth, 1, [haiku], { requestId: "00000000-0000-4000-8000-000000000001", purpose: "chat" });
    expect(t).toMatchObject({ units: 1, entitlement: "plan:free", requestId: "00000000-0000-4000-8000-000000000001" });
    expect(rpc[0]).toEqual(["usage_reserve", expect.objectContaining({ p_units: 1, p_window_limit: 15, p_week_limit: 100, p_purpose: "chat" })]);
  });

  it("uses Pro limits only for an active subscription", async () => {
    const pro = fakeAuth({ plan: { plan: "pro", status: "active" } });
    await enforceLimits(req(), pro.auth, 1, [sonnet]);
    expect(pro.rpc[0]![1]).toMatchObject({ p_units: 15, p_window_limit: 150 });
    const lapsed = fakeAuth({ plan: { plan: "pro", status: "canceled" } });
    await enforceLimits(req(), lapsed.auth, 1, [sonnet]);
    expect(lapsed.rpc[0]![1]).toMatchObject({ p_window_limit: 15 });
  });

  it("explains a block, including what a larger model costs", async () => {
    const { auth } = fakeAuth({ reserve: () => ({ ok: false, reason: "limit", scope: "window", used: 3, limit: 15, resets_at: "2026-10-19T15:00:00Z" }) });
    const err = (await enforceLimits(req(), auth, 1, [sonnet]).then(() => null, (e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("quota_exceeded");
    expect(err.message).toBe("Claude Sonnet 5.5 uses 15 units per message, but only 12 of your Free plan's 5-hour allowance are left. Auto or a lighter model uses 1.");
    expect(err.details).toMatchObject({ scope: "window", resetsAt: "2026-10-19T15:00:00.000Z", unitsNeeded: 15, unitsLeft: 12 });
  });

  it("refuses a duplicate submission with 409", async () => {
    const { auth } = fakeAuth({ reserve: () => ({ ok: false, reason: "duplicate" }) });
    const err = (await enforceLimits(req(), auth, 1, [haiku]).then(() => null, (e: unknown) => e)) as ApiError;
    expect(err.code).toBe("conflict");
  });

  it("gives administrators no allowance, enforced on the server, and records it", async () => {
    const { auth, rpc, inserts } = fakeAuth({ admin: true });
    const t = await enforceLimits(req(), auth, 1, [sonnet]);
    expect(t).toMatchObject({ units: 15, entitlement: "admin_unlimited" });
    // Still reserved (so duplicates are refused), but with no limit.
    expect(rpc[0]).toEqual(["usage_reserve", expect.objectContaining({ p_window_limit: 1_000_000_000, p_week_limit: 1_000_000_000 })]);
    expect(await planUsage(auth)).toBeNull();
    await recordRun(auth, run(sonnet));
    expect(inserts[0]).toMatchObject({ entitlement: "admin_unlimited", units: 15 });
  });

  it("can switch the admin exemption off", async () => {
    process.env.NOVA_ADMINS_UNLIMITED = "false";
    const { auth, rpc } = fakeAuth({ admin: true });
    await enforceLimits(req(), auth, 1, [sonnet]);
    expect(rpc[0]![1]).toMatchObject({ p_window_limit: 15 });
  });

  it("charges the model that actually answered and settles the reservation", async () => {
    const { auth, rpc, inserts } = fakeAuth();
    const t = await enforceLimits(req(), auth, 1, [sonnet], { requestId: "00000000-0000-4000-8000-000000000002" });
    expect(t.units).toBe(15);
    // Sonnet failed before any text; the fallback (Haiku) answered.
    await recordRun(auth, run(haiku, { routingReason: "Fallback from Claude Sonnet 5.5.", requestedModel: "auto", tools: ["time"] }));
    expect(inserts[0]).toMatchObject({ model_id: haiku.id, units: 1, request_id: "00000000-0000-4000-8000-000000000002", requested_model: "auto", tools: ["time"], entitlement: "plan:free" });
    expect(rpc.at(-1)).toEqual(["usage_finish", { p_request_id: "00000000-0000-4000-8000-000000000002", p_state: "settled" }]);
  });

  it("refunds a failed call that produced no output, but charges a partial reply", async () => {
    const { auth, inserts } = fakeAuth();
    await enforceLimits(req(), auth, 1, [sonnet]);
    await recordRun(auth, run(sonnet, { status: "error", response: "", error: "Upstream 500 with key sk-ant-abcdefghijklmnop" }));
    await recordRun(auth, run(sonnet, { status: "error", response: "partial" }));
    expect(inserts.map((r) => r.units)).toEqual([0, 15]);
    expect(inserts[0]!.error_code).toBe("Upstream 500 with key [redacted]");
  });

  it("reads remaining usage and reset times from the ledger", async () => {
    const { auth } = fakeAuth();
    const u = await planUsage(auth);
    expect(u).toMatchObject({ plan: "free", window: { used: 3, limit: 15, resetsAt: Date.parse("2026-10-19T15:00:00Z") }, week: { used: 40, limit: 100, resetsAt: Date.parse("2026-10-22T08:00:00Z") } });
  });

  it("redacts secrets from stored errors", () => {
    expect(redactSecrets("Bearer abc.def-123 failed for xai-1234567890abcdef")).toBe("Bearer [redacted] failed for [redacted]");
  });
});

describe("AI budget guard", () => {
  // Real providers configured, so the lowest-cost available model is Claude Haiku.
  beforeAll(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENAI_API_KEY = "test-key";
  });
  afterAll(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
  const pro = (runs: FakeRun[]) => fakeAuth({ plan: { plan: "pro", status: "active", current_period_start: new Date(Date.now() - 5 * 86_400_000).toISOString() }, runs });
  const spend = (usd: number): FakeRun[] => [{ estimated_cost: usd, input_tokens: 1000, output_tokens: 500 }];

  it("keeps 60% of the $12 Pro price after AI costs and payment fees", () => {
    expect(PLANS.pro.priceUsd).toBe(12);
    const budget = proAiBudgetUsd({ feePercent: 2.9, feeFixedUsd: 0.3, overheadUsd: 0 });
    expect(budget).toBeCloseTo(4.152, 3);
    const fee = 12 * 0.029 + 0.3;
    expect((12 - fee - budget) / 12).toBeCloseTo(TARGET_MARGIN, 5);
    // Other overheads per subscriber come out of the AI budget, not the margin.
    expect(proAiBudgetUsd({ feePercent: 2.9, feeFixedUsd: 0.3, overheadUsd: 1 })).toBeCloseTo(3.152, 3);
  });

  it("allows any model while under 80% of the budget", async () => {
    const { auth } = pro(spend(3.0));
    await expect(enforceLimits(req(), auth, 1, [sonnet])).resolves.toMatchObject({ units: 15 });
  });

  it("from 80%, allows only the lowest-cost model", async () => {
    const { auth } = pro(spend(3.5));
    const err = (await enforceLimits(req(), auth, 1, [sonnet]).then(() => null, (e: unknown) => e)) as ApiError;
    expect(err.code).toBe("quota_exceeded");
    expect(err.message).toMatch(/only the lowest-cost model/);
    expect(err.details).toMatchObject({ economy: true, budget: true });
    const ok = pro(spend(3.5));
    await expect(enforceLimits(req(), ok.auth, 1, [haiku])).resolves.toMatchObject({ units: 1 });
  });

  it("stops AI requests when the budget is used up, until it renews", async () => {
    const { auth, rpc } = pro(spend(4.2));
    const err = (await enforceLimits(req(), auth, 1, [haiku]).then(() => null, (e: unknown) => e)) as ApiError;
    expect(err.message).toMatch(/used this month's AI budget/);
    expect((err.details as { resetsAt: string }).resetsAt).toBeTruthy();
    expect(rpc.some(([fn]) => fn === "usage_reserve")).toBe(false);
  });

  it("caps Free users with their own budget", async () => {
    const { auth } = fakeAuth({ runs: spend(0.3) });
    const err = (await enforceLimits(req(), auth, 1, [haiku]).then(() => null, (e: unknown) => e)) as ApiError;
    expect(err.message).toMatch(/Free plan/);
  });

  it("counts runs without a verified price at the most expensive verified price", async () => {
    // 300 unpriced runs of 2k in + 1k out tokens, at the top verified price ($2 in / $12 out per 1M): $4.80.
    const runs: FakeRun[] = Array.from({ length: 300 }, () => ({ estimated_cost: null, input_tokens: 2000, output_tokens: 1000 }));
    const { auth } = pro(runs);
    await expect(enforceLimits(req(), auth, 1, [haiku])).rejects.toThrow(/AI budget/);
  });

  it("doesn't apply to administrators", async () => {
    const { auth } = fakeAuth({ admin: true, runs: spend(1000) });
    await expect(enforceLimits(req(), auth, 1, [sonnet])).resolves.toMatchObject({ entitlement: "admin_unlimited" });
  });
});
