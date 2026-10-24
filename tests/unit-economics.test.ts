import { describe, expect, it } from "vitest";
import { unitEconomics, type UnitEconomicsRaw } from "@/lib/billing/unit-economics";

const empty: UnitEconomicsRaw = {
  by_plan: [],
  by_purpose: [],
  concentration: { paying_or_free_users: 0, total_cost_usd: 0, top_user_cost_usd: 0, top_10pct_cost_usd: 0 },
  tasks: { total: 0, completed: 0, succeeded: 0, failed: 0, cancelled: 0, open: 0, pair: 0, cost_usd: 0, succeeded_cost_usd: 0, failed_or_cancelled_cost_usd: 0 },
  revenue: [],
  subscriptions: [],
};

describe("unit economics", () => {
  it("leaves metrics empty, never estimated, when there is no data, and lists what's missing", () => {
    const ue = unitEconomics(empty, 30);
    const v = Object.fromEntries(ue.metrics.map((m) => [m.label, m.value]));
    expect(v["Variable cost per active user"]).toBeNull();
    expect(v["Cost per successful coding task"]).toBeNull();
    expect(v["Failed model calls"]).toBeNull();
    expect(v["Top user's share of cost"]).toBeNull();
    const gaps = ue.gaps.join(" ");
    expect(gaps).toMatch(/No payments/);
    expect(gaps).toMatch(/Only 0 non-administrator users/);
    expect(gaps).toMatch(/Only 0 coding tasks/);
    expect(gaps).toMatch(/subscription events/);
    expect(gaps).toMatch(/Payment fees/);
    expect(gaps).toMatch(/Hosting/);
  });

  it("every metric carries a definition", () => {
    for (const m of unitEconomics(empty, 7).metrics) expect(m.definition.length).toBeGreaterThan(20);
  });

  it("gross margin needs revenue; refunds reduce it; Free cost and failed-call share come from the records", () => {
    const ue = unitEconomics(
      {
        ...empty,
        by_plan: [
          { entitlement: "plan:free", active_users: 4, calls: 40, failed_calls: 2, model_cost_usd: "0.4", sandbox_cost_usd: null, credit_cost_usd: null },
          { entitlement: "plan:max", active_users: 1, calls: 60, failed_calls: 3, model_cost_usd: 30, sandbox_cost_usd: 10, credit_cost_usd: 0 },
        ],
        concentration: { paying_or_free_users: 5, total_cost_usd: 40.4, top_user_cost_usd: 40, top_10pct_cost_usd: 40 },
        revenue: [
          { plan: "max", kind: "payment", count: 1, amount_usd: 100 },
          { plan: "max", kind: "refund", count: 1, amount_usd: 20 },
          { plan: "max", kind: "failed_payment", count: 1, amount_usd: 100 },
        ],
      },
      30,
    );
    const max = ue.plans.find((p) => p.plan === "plan:max")!;
    expect(max).toMatchObject({ label: "Max", revenueUsd: 80, variableCostUsd: 40, costPerActiveUserUsd: 40, grossMarginPct: 50 });
    const free = ue.plans.find((p) => p.plan === "plan:free")!;
    expect(free).toMatchObject({ revenueUsd: 0, grossMarginPct: null, costPerActiveUserUsd: 0.1 });
    expect(ue.plans[0]!.plan).toBe("plan:max");
    const v = Object.fromEntries(ue.metrics.map((m) => [m.label, m.value]));
    expect(v["Free tier cost"]).toBe(0.4);
    expect(v["Failed model calls"]).toBe(0.05);
    expect(v["Top user's share of cost"]).toBe(0.99);
    expect(ue.gaps.join(" ")).not.toMatch(/No payments/);
  });
});
