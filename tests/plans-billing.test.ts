/**
 * Plans, budgets and finances: the plan economics behind the prices, the
 * atomic budget reservation (usage_reserve_v2) and the admin finance summary
 * in the real migrations on an in-process Postgres (PGlite), and the finance
 * report built from it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_MODELS } from "@/lib/ai/registry";
import { financeReport, type FinanceSummary } from "@/lib/billing/finance";
import { budgetPeriod } from "@/lib/budget";
import { estimateCost } from "@/lib/ai/cost";
import { DAYS_PER_MONTH, messageCostUsd, modelCostTable, planCapacity, planScenario } from "@/lib/billing/scenarios";
import { DEFAULT_BILLING, chargeUsd, modelTier, planEconomics, planForTier, planOf, priceForBudget, resolveBilling, validateBilling } from "@/lib/plans";

const B = DEFAULT_BILLING;

const model = (id: string) => DEFAULT_MODELS.find((m) => m.id === id)!;
const CONFIGURED = ["anthropic:claude-haiku-5-5", "openai:gpt-5.6-luna", "anthropic:claude-sonnet-5-5", "openai:gpt-5.6-terra", "anthropic:claude-opus-5-5", "openai:gpt-5.6-sol"].map(model);

describe("request cost from token usage (verified prices, 2026-10-19)", () => {
  it("uses (input × input price + output × output price) / 1,000,000", () => {
    expect(estimateCost(model("anthropic:claude-haiku-5-5"), { inputTokens: 2000, outputTokens: 800 })).toBeCloseTo(0.0006, 10);
    expect(estimateCost(model("anthropic:claude-opus-5-5"), { inputTokens: 2000, outputTokens: 800 })).toBeCloseTo(0.024, 10);
    expect(estimateCost({ inputPrice: null, outputPrice: 1 }, { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });

  it("prices cached input and cache writes at their own rates", () => {
    // Sonnet: cache hits $0.10, 5-minute cache writes $2.50, input $2, output $10.
    const c = estimateCost(model("anthropic:claude-sonnet-5-5"), { inputTokens: 10_000, outputTokens: 1000, cachedInputTokens: 8000, cacheWriteInputTokens: 1000 });
    expect(c).toBeCloseTo((1000 * 2 + 1000 * 2.5 + 8000 * 0.1 + 1000 * 10) / 1e6, 10);
    // OpenAI doesn't report cache writes: uncached input counts at the write price ($0.25 for Luna), an upper bound.
    expect(estimateCost(model("openai:gpt-5.6-luna"), { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 600 })).toBeCloseTo((400 * 0.25 + 600 * 0.02) / 1e6, 10);
  });

  it("switches to long-context prices above the provider's threshold", () => {
    const haiku = model("anthropic:claude-haiku-5-5");
    expect(estimateCost(haiku, { inputTokens: 100_000, outputTokens: 1000 })).toBeCloseTo((100_000 * 0.1 + 1000 * 0.5) / 1e6, 10);
    expect(estimateCost(haiku, { inputTokens: 100_001, outputTokens: 1000 })).toBeCloseTo((100_001 * 0.5 + 1000 * 2.5) / 1e6, 10);
    expect(estimateCost(model("openai:gpt-5.6-sol"), { inputTokens: 300_000, outputTokens: 0 })).toBeCloseTo((300_000 * 10) / 1e6, 8); // long-context write price
  });
});

describe("usage scenarios (2,000 in / 800 out per call, 1.05 calls per message, 30 days)", () => {
  const s = DEFAULT_BILLING.scenario;
  it("costs a message on each model and scales it by volume", () => {
    expect(messageCostUsd(model("anthropic:claude-haiku-5-5"), s)).toBeCloseTo(0.0006 * 1.05, 10);
    const t = modelCostTable(CONFIGURED, s);
    expect(t.map((r) => r.name)).toEqual(["Claude Haiku 5.5", "GPT-5.6 Luna", "Claude Sonnet 5.5", "GPT-5.6 Terra", "Claude Opus 5.5", "GPT-5.6 Sol"]);
    const opus = t.find((r) => r.name === "Claude Opus 5.5")!;
    expect(opus.per1000Usd).toBeCloseTo(25.2, 6);
    expect(opus.byVolume.find((v) => v.perDay === 300)!.monthlyUsd).toBeCloseTo(0.0252 * 300 * DAYS_PER_MONTH, 6);
  });

  it("separates the advanced-model part of each plan's budget", () => {
    const pro = planCapacity(DEFAULT_BILLING, "pro", CONFIGURED);
    expect(pro.models.map((m) => m.name)).not.toContain("Claude Opus 5.5");
    const sonnet = pro.models.find((m) => m.name === "Claude Sonnet 5.5")!;
    expect(sonnet.perMonth).toBe(Math.floor(pro.premiumBudgetUsd / 0.0126));
    expect(pro.mixed!.perMonth).toBeGreaterThan(sonnet.perMonth);
  });

  it("keeps at least 60% contribution margin on paid plans at 10–300 messages a day, even on the most expensive models", () => {
    for (const plan of ["pro", "max"] as const) {
      for (const m of CONFIGURED.filter((x) => DEFAULT_BILLING.plans[plan].tiers.includes(modelTier(x)))) {
        for (const perDay of [10, 50, 100, 300]) {
          const r = planScenario(DEFAULT_BILLING, plan, m, perDay)!;
          expect(r.marginPct!, `${plan} ${m.displayName} ${perDay}/day`).toBeGreaterThanOrEqual(60);
          for (const interval of ["year"] as const) expect(planScenario(DEFAULT_BILLING, plan, m, perDay, interval)!.marginPct!).toBeGreaterThanOrEqual(60);
        }
      }
    }
    // A heavy Max user on Opus is stopped by the guard rather than costing $226 a month.
    const heavy = planScenario(DEFAULT_BILLING, "max", model("anthropic:claude-opus-5-5"), 300)!;
    expect(heavy.uncappedAiUsd).toBeGreaterThan(200);
    expect(heavy.capped).toBe(true);
    expect(heavy.aiCostUsd).toBeLessThanOrEqual(planEconomics(DEFAULT_BILLING, "max").premiumBudgetUsd + 1e-9);
  });
});

describe("plan economics (60% contribution margin)", () => {
  it("derives each paid plan's AI budget so 60% of revenue remains after every variable cost", () => {
    for (const [id, interval, budget] of [
      ["pro", "month", 3.009],
      ["pro", "year", 2.789],
      ["max", "month", 31.756],
      ["max", "year", 28.661],
    ] as const) {
      const e = planEconomics(B, id, interval);
      expect(e.aiBudgetUsd).toBeCloseTo(budget, 2);
      const costs = e.feesUsd + e.overheadUsd + e.aiBudgetUsd;
      // Revenue excludes tax and expected refunds. Margin with the full AI budget used: at least 60%, the buffer on top.
      expect((e.revenueUsd - costs) / e.revenueUsd).toBeGreaterThanOrEqual(0.6);
      expect((e.revenueUsd - costs - e.bufferUsd) / e.revenueUsd).toBeCloseTo(0.6, 4);
    }
  });

  it("excludes taxes collected for authorities from revenue", () => {
    const e = planEconomics({ ...B, taxIncludedPct: 20, refundRatePct: 0 }, "pro");
    expect(e.taxUsd).toBeCloseTo(15 - 15 / 1.2, 6);
    expect(e.revenueUsd).toBeCloseTo(12.5, 6);
    expect(e.aiBudgetUsd).toBeLessThan(planEconomics(B, "pro").aiBudgetUsd);
  });

  it("charges yearly plans 12 months less the discount, in whole dollars", () => {
    expect(chargeUsd(planOf(B, "pro"), "year")).toBe(162);
    expect(chargeUsd(planOf(B, "max"), "year")).toBe(1188);
    expect(chargeUsd(planOf(B, "free"), "year")).toBe(0);
  });

  it("inverts: the price needed for a given AI budget", () => {
    expect(priceForBudget(B, planEconomics(B, "pro").aiBudgetUsd)).toBeCloseTo(15, 0);
    expect(priceForBudget({ ...B, targetMargin: 0.97 }, 5)).toBeNull();
  });

  it("puts models in tiers and tiers in plans", () => {
    const tier = (id: string) => modelTier(DEFAULT_MODELS.find((m) => m.id === id)!);
    expect([tier("anthropic:claude-haiku-5-5"), tier("openai:gpt-5.6-luna")]).toEqual(["standard", "standard"]);
    expect([tier("anthropic:claude-sonnet-5-5"), tier("openai:gpt-5.6-terra")]).toEqual(["advanced", "advanced"]);
    expect([tier("anthropic:claude-opus-5-5"), tier("openai:gpt-5.6-sol")]).toEqual(["premium", "premium"]);
    expect([planForTier(B, "standard"), planForTier(B, "advanced"), planForTier(B, "premium")]).toEqual(["free", "pro", "max"]);
  });

  it("merges admin changes over the defaults and rejects invalid ones", () => {
    const b = resolveBilling({ plans: { pro: { priceUsd: 25 } }, safetyBufferPct: 20 });
    expect(b.plans.pro.priceUsd).toBe(25);
    expect(b.plans.pro.windowUnits).toBe(B.plans.pro.windowUnits);
    expect(b.safetyBufferPct).toBe(20);
    expect(resolveBilling({ targetMargin: 5 })).toEqual(B); // invalid → defaults
    expect(validateBilling({ targetMargin: 5 }).ok).toBe(false);
    expect(validateBilling({ plans: { max: { windowUnits: 5000, weeklyUnits: 100 } } })).toMatchObject({ ok: false });
    expect(validateBilling({ plans: { free: { tiers: ["advanced"] } } })).toMatchObject({ ok: false });
    expect(validateBilling({ plans: { max: { priceUsd: 120 } } })).toMatchObject({ ok: true });
    expect(validateBilling({ plans: { pro: { premiumBudgetPct: 150 } } }).ok).toBe(false);
    expect(resolveBilling({ scenario: { inputTokens: 4000 } }).scenario).toMatchObject({ inputTokens: 4000, outputTokens: 800 });
  });

  it("resets budgets monthly on the billing date, also on yearly plans", () => {
    const start = Date.UTC(2026, 0, 31, 9);
    const p = budgetPeriod({ plan: "max", interval: "year", periodStart: start }, Date.UTC(2026, 2, 15));
    expect(new Date(p.start).toISOString()).toBe("2026-02-28T09:00:00.000Z");
    expect(new Date(p.end).toISOString()).toBe("2026-03-31T09:00:00.000Z");
    const free = budgetPeriod({ plan: "free", interval: "month", periodStart: null }, Date.UTC(2026, 9, 19, 12));
    expect(new Date(free.start).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let db: PGlite;

async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

type R = { ok: boolean; reason?: string; scope?: string; spent?: number };
const reserve = (user: string, id: string, o: { units?: number; est?: number; budget?: number | null; premium?: boolean; limits?: [number, number] } = {}) =>
  as(user, async () =>
    (
      await db.query<{ r: R }>("select public.usage_reserve_v2($1, $2, $3, $4, $5, $6, date_trunc('month', now()), $7, 0.8, 4, 20, 'chat', 'm') as r", [
        id,
        o.units ?? 1,
        o.limits?.[0] ?? 200,
        o.limits?.[1] ?? 1100,
        o.est ?? 0.01,
        o.budget === undefined ? 4.66 : o.budget,
        o.premium ?? false,
      ])
    ).rows[0]!.r,
  );
const spend = (user: string, usd: number | null, tokens: [number, number] = [1000, 500]) =>
  as(user, () => db.query("insert into public.model_runs (model_id, status, units, estimated_cost, input_tokens, output_tokens) values ('m', 'success', 1, $1, $2, $3)", [usd, tokens[0], tokens[1]]));

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  const dir = join(__dirname, "..", "supabase", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(join(dir, f), "utf8"));
  await db.exec(`
    grant usage on schema public to anon, authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    insert into auth.users (id, email) values ('${ALICE}', 'alice@example.com'), ('${BOB}', 'bob@example.com');
  `);
}, 60_000);

beforeEach(async () => {
  await db.exec("delete from public.usage_holds; delete from public.model_runs; delete from public.admins; delete from public.subscriptions; delete from public.billing_ledger;");
});

describe("usage_reserve_v2 (budget, atomically)", () => {
  it("allows requests within the budget and refuses once it's used", async () => {
    await spend(ALICE, 3);
    expect(await reserve(ALICE, rid(1))).toMatchObject({ ok: true });
    await spend(ALICE, 1.7);
    expect(await reserve(ALICE, rid(2))).toMatchObject({ ok: false, reason: "budget", scope: "exhausted" });
  });

  it("refuses a request whose estimate would exceed what's left", async () => {
    await spend(ALICE, 4.6);
    expect(await reserve(ALICE, rid(3), { est: 0.1 })).toMatchObject({ ok: false, scope: "insufficient" });
    expect(await reserve(ALICE, rid(4), { est: 0.01 })).toMatchObject({ ok: true });
  });

  it("from 80% of the budget, refuses anything but the lowest-cost model", async () => {
    await spend(ALICE, 3.8);
    expect(await reserve(ALICE, rid(5), { premium: true })).toMatchObject({ ok: false, scope: "economy" });
    expect(await reserve(ALICE, rid(6), { premium: false })).toMatchObject({ ok: true });
  });

  it("counts requests in flight at their estimate, so concurrent requests can't overspend", async () => {
    await spend(ALICE, 4.5);
    expect(await reserve(ALICE, rid(7), { est: 0.1 })).toMatchObject({ ok: true });
    // A second request before the first is recorded: 4.5 + 0.1 held + 0.1 > 4.66.
    expect(await reserve(ALICE, rid(8), { est: 0.1 })).toMatchObject({ ok: false, scope: "insufficient" });
    await as(ALICE, () => db.query("select public.usage_finish($1, 'released')", [rid(7)]));
    expect(await reserve(ALICE, rid(8), { est: 0.1 })).toMatchObject({ ok: true });
  });

  it("counts unpriced runs at the fallback prices", async () => {
    // 200 runs × (2,000 × $4 + 1,000 × $20) / 1M = $5.60.
    for (let i = 0; i < 200; i++) await spend(ALICE, null, [2000, 1000]);
    expect(await reserve(ALICE, rid(9))).toMatchObject({ ok: false, scope: "exhausted" });
  });

  it("keeps each user's budget separate, and skips it for accounts without one", async () => {
    await spend(ALICE, 10);
    expect(await reserve(BOB, rid(10))).toMatchObject({ ok: true });
    expect(await reserve(ALICE, rid(11), { budget: null })).toMatchObject({ ok: true });
  });

  it("refuses duplicates and still enforces the unit limits", async () => {
    expect(await reserve(ALICE, rid(12))).toMatchObject({ ok: true });
    expect(await reserve(ALICE, rid(12))).toMatchObject({ ok: false, reason: "duplicate" });
    expect(await reserve(ALICE, rid(13), { units: 20, limits: [10, 30] })).toMatchObject({ ok: false, reason: "limit" });
  });

  it("can't be called with someone else's identity or to hide spending", async () => {
    await spend(ALICE, 5);
    // Holds and runs are written only through the functions/RLS; another user's spend isn't visible.
    const seen = await as(BOB, async () => (await db.query<{ n: number }>("select count(*)::int as n from public.model_runs")).rows[0]!.n);
    expect(seen).toBe(0);
    await expect(as(ALICE, () => db.query("select public.usage_spend($1, now() - interval '1 day', now(), 0, 0)", [ALICE]))).rejects.toThrow();
  });
});

type R3 = { ok: boolean; reason?: string; scope?: string; used?: number; limit?: number };
const reserve3 = (
  user: string,
  id: string,
  o: { units?: number; est?: number; tokens?: number; budget?: number | null; premiumBudget?: number | null; premium?: boolean; daily?: number; tokenLimit?: number; since?: string } = {},
) =>
  as(user, async () =>
    (
      await db.query<{ r: R3 }>(
        "select public.usage_reserve_v3($1, $2, 200, 1100, $3, $4, $5, $6, $7, $8, $9, coalesce($10::timestamptz, date_trunc('month', now())), 4, 20, 'chat', 'm') as r",
        [id, o.units ?? 1, o.est ?? 0.01, o.tokens ?? 1000, o.budget === undefined ? 3.0 : o.budget, o.premiumBudget === undefined ? 1.8 : o.premiumBudget, o.premium ?? false, o.daily ?? 0, o.tokenLimit ?? 0, o.since ?? null],
      )
    ).rows[0]!.r,
  );
const spendTier = (user: string, usd: number, tier: string, tokens: [number, number] = [1000, 500]) =>
  as(user, () =>
    db.query("insert into public.model_runs (model_id, status, units, estimated_cost, input_tokens, output_tokens, model_tier, request_id) values ('anthropic:m', 'success', 1, $1, $2, $3, $4, gen_random_uuid())", [usd, tokens[0], tokens[1], tier]),
  );

describe("usage_reserve_v3 (premium budget, daily and token caps, atomically)", () => {
  it("limits advanced models to their part of the budget, leaving the rest for standard models", async () => {
    await spendTier(ALICE, 1.75, "advanced");
    expect(await reserve3(ALICE, rid(101), { premium: true, est: 0.1 })).toMatchObject({ ok: false, reason: "budget", scope: "premium" });
    expect(await reserve3(ALICE, rid(102), { premium: false, est: 0.1 })).toMatchObject({ ok: true });
  });

  it("holds concurrent advanced requests against the premium budget", async () => {
    expect(await reserve3(ALICE, rid(103), { premium: true, est: 1.0 })).toMatchObject({ ok: true });
    expect(await reserve3(ALICE, rid(104), { premium: true, est: 1.0 })).toMatchObject({ ok: false, scope: "premium" });
    await as(ALICE, () => db.query("select public.usage_finish($1, 'released')", [rid(103)]));
    expect(await reserve3(ALICE, rid(104), { premium: true, est: 1.0 })).toMatchObject({ ok: true });
  });

  it("caps messages per day, counting each request once and requests in flight", async () => {
    await spendTier(ALICE, 0.001, "standard");
    await spendTier(ALICE, 0.001, "standard");
    expect(await reserve3(ALICE, rid(105), { daily: 3 })).toMatchObject({ ok: true });
    expect(await reserve3(ALICE, rid(106), { daily: 3 })).toMatchObject({ ok: false, reason: "limit", scope: "day", used: 3, limit: 3 });
    // Yesterday's messages don't count.
    await db.exec("update public.model_runs set created_at = now() - interval '1 day'");
    expect(await reserve3(ALICE, rid(107), { daily: 3 })).toMatchObject({ ok: true });
  });

  it("caps tokens per period, including the request's own estimate", async () => {
    await spendTier(ALICE, 0.01, "standard", [300_000, 50_000]);
    expect(await reserve3(ALICE, rid(108), { tokenLimit: 400_000, tokens: 40_000 })).toMatchObject({ ok: true });
    expect(await reserve3(ALICE, rid(109), { tokenLimit: 400_000, tokens: 40_000 })).toMatchObject({ ok: false, reason: "tokens", limit: 400_000 });
  });

  it("resets with the billing period", async () => {
    await spendTier(ALICE, 3.5, "standard");
    await db.exec("update public.model_runs set created_at = now() - interval '40 days'"); // runs are time-stamped by the server; backdate as the database owner

    expect(await reserve3(ALICE, rid(110), { since: new Date(Date.now() - 60 * 86_400_000).toISOString() })).toMatchObject({ ok: false, scope: "exhausted" });
    expect(await reserve3(ALICE, rid(111), { since: new Date(Date.now() - 10 * 86_400_000).toISOString() })).toMatchObject({ ok: true });
  });

  it("refuses duplicates and skips money checks for accounts without a budget", async () => {
    expect(await reserve3(ALICE, rid(112))).toMatchObject({ ok: true });
    expect(await reserve3(ALICE, rid(112))).toMatchObject({ ok: false, reason: "duplicate" });
    await spendTier(ALICE, 50, "premium");
    expect(await reserve3(ALICE, rid(113), { budget: null, premiumBudget: null, premium: true })).toMatchObject({ ok: true });
  });

  it("rejects negative costs, so recorded spending can't be lowered", async () => {
    await expect(spendTier(ALICE, -5, "standard")).rejects.toThrow();
  });
});

describe("admin finance summary", () => {
  it("is for administrators only and aggregates subscriptions and costs", async () => {
    await expect(as(ALICE, () => db.query("select public.admin_finance_summary(now() - interval '30 days')"))).rejects.toThrow(/Administrators only/);
    await db.exec(`insert into public.admins (user_id) values ('${BOB}')`);
    await db.exec(`insert into public.subscriptions (user_id, plan, status, billing_interval, price_usd) values ('${ALICE}', 'pro', 'active', 'month', 20)`);
    await as(ALICE, () => db.query("insert into public.model_runs (model_id, status, units, estimated_cost, entitlement) values ('anthropic:claude-sonnet-5-5', 'success', 20, 1.25, 'plan:pro')"));
    const s = await as(BOB, async () => (await db.query<{ s: FinanceSummary }>("select public.admin_finance_summary(now() - interval '30 days') as s")).rows[0]!.s);
    expect(s.subscriptions).toEqual([expect.objectContaining({ plan: "pro", interval: "month", status: "active", count: 1 })]);
    expect(Number(s.cost_by_plan["plan:pro"])).toBeCloseTo(1.25);
    expect(s.cost_by_model[0]).toMatchObject({ model: "anthropic:claude-sonnet-5-5", runs: 1 });
    expect(s.top_users[0]).toMatchObject({ email: "alice@example.com", plan: "pro", admin: false });
    expect(s.users_total).toBe(2);

    const r = financeReport(s, DEFAULT_BILLING, 30);
    const pro = r.plans.find((p) => p.plan === "pro")!;
    expect(pro).toMatchObject({ subscribers: 1, mrrUsd: 20, feesUsd: 1.02, overheadUsd: 0.5, aiCostUsd: 1.25 });
    expect(pro.profitUsd).toBeCloseTo(20 - 1.02 - 0.5 - 1.25, 2);
    expect(r.totals.mrrUsd).toBe(20);
    expect(r.alerts).toEqual([]);
  });

  it("v2 adds messages, tokens, provider costs and money collected excluding tax", async () => {
    await db.exec(`insert into public.admins (user_id) values ('${BOB}')`);
    await db.exec(`insert into public.subscriptions (user_id, plan, status, billing_interval, price_usd) values ('${ALICE}', 'pro', 'active', 'month', 15)`);
    await spendTier(ALICE, 0.5, "advanced", [2000, 800]);
    await as(ALICE, () => db.query("insert into public.model_runs (model_id, status, units, estimated_cost, input_tokens, output_tokens, cached_input_tokens, model_tier, entitlement) values ('openai:gpt-5.6-luna', 'success', 1, 0.25, 4000, 800, 1000, 'standard', 'plan:pro')"));
    await db.exec(`
      insert into public.billing_ledger (stripe_object_id, user_id, kind, plan, amount_usd, tax_usd) values
        ('in_1', '${ALICE}', 'payment', 'pro', 15, 1.2), ('re_1', '${ALICE}', 'refund', null, 15, 0), ('failed:evt_1', '${ALICE}', 'failed_payment', 'pro', 16.2, 1.2);
    `);
    // Ledger and events are not readable by users.
    expect((await as(ALICE, () => db.query("select * from public.billing_ledger"))).rows).toHaveLength(0);
    await expect(as(ALICE, () => db.query("select public.admin_finance_summary_v2(now() - interval '30 days')"))).rejects.toThrow(/Administrators only/);
    const s = await as(BOB, async () => (await db.query<{ s: FinanceSummary }>("select public.admin_finance_summary_v2(now() - interval '30 days') as s")).rows[0]!.s);
    expect(s.usage).toMatchObject({ runs: 2, messages: 2 });
    expect(Number(s.cost_by_provider!.anthropic)).toBeCloseTo(0.5);
    expect(Number(s.cost_by_provider!.openai)).toBeCloseTo(0.25);
    expect(Number(s.ledger!.payment!.amount)).toBe(15);
    const r = financeReport(s, { ...DEFAULT_BILLING, fixedOverheadMonthlyUsd: 300 }, 30);
    expect(r.collected).toMatchObject({ revenueUsd: 15, taxUsd: 1.2, refundsUsd: 15, refunds: 1, failedPayments: 1 });
    expect(r.usage).toMatchObject({ messages: 2, modelCalls: 2, avgInputTokens: 3000, avgOutputTokens: 800, cachedInputShare: 0.167 });
    expect(r.usage.costPer1000MessagesUsd).toBeCloseTo(375, 2);
    expect(r.contribution.fixedOverheadUsd).toBe(300);
    expect(r.contribution.operatingResultUsd).toBeCloseTo(r.contribution.contributionUsd - 300, 2);
    expect(r.alerts.map((a) => a.text).join(" ")).toMatch(/payment attempt failed/);
  });
});

describe("finance report alerts", () => {
  const base: FinanceSummary = { subscriptions: [], canceled_since: 0, cost_by_plan: {}, cost_by_model: [], daily_cost: [], top_users: [], users_total: 0 };

  it("flags heavy users, spend spikes, failed payments and plans below the target margin", () => {
    const today = new Date().toISOString().slice(0, 10);
    const days = Array.from({ length: 7 }, (_, i) => ({ day: new Date(Date.now() - (7 - i) * 86_400_000).toISOString().slice(0, 10), cost: 1, runs: 10 }));
    const r = financeReport(
      {
        ...base,
        subscriptions: [
          { plan: "pro", interval: "month", status: "active", count: 2, price_usd: 20, canceling: 1 },
          { plan: "max", interval: "month", status: "past_due", count: 1, price_usd: 100, canceling: 0 },
        ],
        cost_by_plan: { "plan:pro": 20 },
        daily_cost: [...days, { day: today, cost: 5, runs: 50 }],
        top_users: [{ user_id: "a", email: "a@example.com", plan: "pro", status: "active", interval: "month", cost: 2.709, runs: 300, admin: false }],
        users_total: 10,
      },
      DEFAULT_BILLING,
      30,
    );
    const text = r.alerts.map((a) => a.text).join("\n");
    expect(text).toMatch(/a@example\.com \(pro\) is at 90% of their AI budget/);
    expect(text).toMatch(/more than twice the previous 7-day average/);
    expect(text).toMatch(/1 subscription has a failed payment/);
    expect(text).toMatch(/Pro margin is .*below the 60% target/);
    expect(r.plans.find((p) => p.plan === "pro")!.canceling).toBe(1);
    expect(r.pastDue).toBe(1);
    expect(r.projection.aiCostUsd).toBeGreaterThan(0);
  });
});
