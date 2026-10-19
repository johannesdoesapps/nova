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
import { DEFAULT_BILLING, chargeUsd, modelTier, planEconomics, planForTier, planOf, priceForBudget, resolveBilling, typicalRequestUsd, validateBilling } from "@/lib/plans";

const B = DEFAULT_BILLING;

describe("plan economics (60% margin)", () => {
  it("derives each paid plan's AI budget so 60% of revenue remains after every cost", () => {
    for (const [id, interval, budget] of [
      ["pro", "month", 4.66],
      ["pro", "year", 4.27],
      ["max", "month", 29.41],
      ["max", "year", 26.55],
    ] as const) {
      const e = planEconomics(B, id, interval);
      expect(e.aiBudgetUsd).toBeCloseTo(budget, 2);
      const costs = e.feesUsd + e.overheadUsd + e.aiBudgetUsd;
      // Profit after fees, hosting, Free users' share and the full AI budget: at least 60%, the buffer on top.
      expect((e.revenueUsd - costs) / e.revenueUsd).toBeGreaterThanOrEqual(0.6);
      expect((e.revenueUsd - costs - e.bufferUsd) / e.revenueUsd).toBeCloseTo(0.6, 4);
    }
  });

  it("charges yearly plans 12 months less the discount, in whole dollars", () => {
    expect(chargeUsd(planOf(B, "pro"), "year")).toBe(216);
    expect(chargeUsd(planOf(B, "max"), "year")).toBe(1080);
    expect(chargeUsd(planOf(B, "free"), "year")).toBe(0);
  });

  it("inverts: the price needed for a given AI budget", () => {
    expect(priceForBudget(B, planEconomics(B, "pro").aiBudgetUsd)).toBeCloseTo(20, 0);
    expect(priceForBudget({ ...B, targetMargin: 0.97 }, 5)).toBeNull();
  });

  it("puts models in tiers and tiers in plans", () => {
    const tier = (id: string) => modelTier(DEFAULT_MODELS.find((m) => m.id === id)!);
    expect([tier("anthropic:claude-haiku-5-5"), tier("openai:gpt-5.6-luna")]).toEqual(["standard", "standard"]);
    expect([tier("anthropic:claude-sonnet-5-5"), tier("openai:gpt-5.6-terra")]).toEqual(["advanced", "advanced"]);
    expect([tier("anthropic:claude-opus-5-5"), tier("openai:gpt-5.6-sol")]).toEqual(["premium", "premium"]);
    expect([planForTier(B, "standard"), planForTier(B, "advanced"), planForTier(B, "premium")]).toEqual(["free", "pro", "max"]);
  });

  it("estimates a typical request from official prices", () => {
    const haiku = DEFAULT_MODELS.find((m) => m.id === "anthropic:claude-haiku-5-5")!;
    expect(typicalRequestUsd(haiku)).toBeCloseTo(0.00098, 6);
    expect(typicalRequestUsd({ inputPrice: null, outputPrice: 1 })).toBeNull();
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
  await db.exec("delete from public.usage_holds; delete from public.model_runs; delete from public.admins; delete from public.subscriptions;");
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
        top_users: [{ user_id: "a", email: "a@example.com", plan: "pro", status: "active", interval: "month", cost: 4.2, runs: 300, admin: false }],
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
