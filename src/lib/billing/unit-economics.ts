/**
 * Unit economics for administrators, from measured records only (admin_unit_economics): costs from the
 * usage records, coding tasks and Stripe's collected revenue. Each metric says what it is and what it
 * leaves out; a metric whose inputs are missing is null and listed under `gaps`, never estimated.
 * Pure (no server imports), so it's tested directly.
 */

export interface UnitEconomicsRaw {
  by_plan: {
    entitlement: string;
    active_users: number;
    calls: number;
    failed_calls: number;
    model_cost_usd: number | string | null;
    sandbox_cost_usd: number | string | null;
    credit_cost_usd: number | string | null;
  }[];
  by_purpose: { purpose: string; calls: number; cost_usd: number | string | null }[];
  concentration: { paying_or_free_users: number; total_cost_usd: number | string; top_user_cost_usd: number | string; top_10pct_cost_usd: number | string };
  tasks: {
    total: number;
    completed: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    open: number;
    pair: number;
    cost_usd: number | string;
    succeeded_cost_usd: number | string;
    failed_or_cancelled_cost_usd: number | string;
  };
  revenue: { plan: string; kind: "payment" | "refund" | "failed_payment"; count: number; amount_usd: number | string }[];
  subscriptions: { plan: string; status: string; count: number }[];
}

export interface Metric {
  label: string;
  value: number | null;
  unit: "usd" | "share" | "count";
  definition: string;
}

export interface PlanEconomics {
  plan: string;
  label: string;
  activeUsers: number;
  calls: number;
  modelCostUsd: number;
  sandboxCostUsd: number;
  variableCostUsd: number;
  costPerActiveUserUsd: number | null;
  /** Payments minus refunds in the period (Stripe, excluding tax). */
  revenueUsd: number;
  /** (revenue − variable cost) ÷ revenue; null without revenue. Payment fees and hosting aren't in it. */
  grossMarginPct: number | null;
}

export interface UnitEconomics {
  periodDays: number;
  plans: PlanEconomics[];
  metrics: Metric[];
  costByFeature: { feature: string; calls: number; costUsd: number }[];
  gaps: string[];
}

const n = (x: number | string | null | undefined) => Number(x ?? 0) || 0;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;
const LABEL: Record<string, string> = { "plan:free": "Free", "plan:pro": "Pro", "plan:max": "Max", guest: "No plan recorded (guests and older records)", admin_unlimited: "Administrators" };

export function unitEconomics(raw: UnitEconomicsRaw, periodDays: number): UnitEconomics {
  const revenueBy = new Map<string, number>();
  for (const r of raw.revenue) {
    const key = `plan:${r.plan}`;
    if (r.kind === "payment") revenueBy.set(key, (revenueBy.get(key) ?? 0) + n(r.amount_usd));
    if (r.kind === "refund") revenueBy.set(key, (revenueBy.get(key) ?? 0) - n(r.amount_usd));
  }
  const plans: PlanEconomics[] = raw.by_plan.map((p) => {
    const model = n(p.model_cost_usd);
    const sandbox = n(p.sandbox_cost_usd);
    const variable = model + sandbox;
    const revenue = revenueBy.get(p.entitlement) ?? 0;
    return {
      plan: p.entitlement,
      label: LABEL[p.entitlement] ?? p.entitlement,
      activeUsers: p.active_users,
      calls: p.calls,
      modelCostUsd: r4(model),
      sandboxCostUsd: r4(sandbox),
      variableCostUsd: r4(variable),
      costPerActiveUserUsd: p.active_users ? r4(variable / p.active_users) : null,
      revenueUsd: Math.round(revenue * 100) / 100,
      grossMarginPct: revenue > 0 ? Math.round(((revenue - variable) / revenue) * 1000) / 10 : null,
    };
  });

  const customers = plans.filter((p) => p.plan !== "admin_unlimited");
  const custCost = customers.reduce((s, p) => s + p.variableCostUsd, 0);
  const custUsers = raw.concentration.paying_or_free_users;
  const total = n(raw.concentration.total_cost_usd);
  const t = raw.tasks;
  const allModel = plans.reduce((s, p) => s + p.modelCostUsd, 0);
  const allSandbox = plans.reduce((s, p) => s + p.sandboxCostUsd, 0);
  const failedCalls = raw.by_plan.reduce((s, p) => s + p.failed_calls, 0);
  const calls = raw.by_plan.reduce((s, p) => s + p.calls, 0);
  const free = plans.find((p) => p.plan === "plan:free");

  const metrics: Metric[] = [
    {
      label: "Variable cost per active user",
      value: custUsers ? r4(custCost / custUsers) : null,
      unit: "usd",
      definition: "Model and sandbox cost of signed-in, non-administrator users ÷ how many of them made a request in the period.",
    },
    {
      label: "Cost per successful coding task",
      value: t.succeeded ? r4(n(t.succeeded_cost_usd) / t.succeeded) : null,
      unit: "usd",
      definition: "Model cost of coding tasks that finished verified or checked ÷ their number. Workspace computer time isn't attributed to tasks.",
    },
    {
      label: "All task cost per successful task",
      value: t.succeeded ? r4(n(t.cost_usd) / t.succeeded) : null,
      unit: "usd",
      definition: "Model cost of every coding task (including failed, stopped and unverified ones) ÷ successful tasks: what one success really costs.",
    },
    {
      label: "Failed or stopped task cost",
      value: r4(n(t.failed_or_cancelled_cost_usd)),
      unit: "usd",
      definition: "Model cost already spent on coding tasks that failed or were stopped (charged to users, since the calls answered).",
    },
    {
      label: "Model cost",
      value: r4(allModel),
      unit: "usd",
      definition: "All model calls, from provider-reported tokens × verified list prices (estimated_cost). Not reconciled to provider invoices here.",
    },
    {
      label: "Sandbox cost",
      value: r4(allSandbox),
      unit: "usd",
      definition: "Code runs and workspace computer time, from Vercel Sandbox's published per-hour prices × measured time. Not Vercel's invoice.",
    },
    { label: "Free tier cost", value: free ? free.variableCostUsd : 0, unit: "usd", definition: "Variable cost of Free accounts in the period." },
    {
      label: "Failed model calls",
      value: calls ? Math.round((failedCalls / calls) * 1000) / 1000 : null,
      unit: "share",
      definition: "Share of model calls that ended in an error. They're charged 0 units; their cost is whatever the provider billed before failing.",
    },
    {
      label: "Top user's share of cost",
      value: total > 0 ? Math.round((n(raw.concentration.top_user_cost_usd) / total) * 1000) / 1000 : null,
      unit: "share",
      definition: "Cost of the single most expensive non-administrator user ÷ all non-administrator cost.",
    },
    {
      label: "Top 10% of users' share of cost",
      value: total > 0 ? Math.round((n(raw.concentration.top_10pct_cost_usd) / total) * 1000) / 1000 : null,
      unit: "share",
      definition: "Cost of the most expensive tenth of users (at least one) ÷ all non-administrator cost.",
    },
  ];

  const gaps: string[] = [];
  const paid = raw.revenue.filter((r) => r.kind === "payment").reduce((s, r) => s + r.count, 0);
  if (!paid) gaps.push("No payments were collected in this period, so revenue and gross margin by plan can't be measured yet (they appear once Stripe records paid invoices).");
  if (custUsers < 20) gaps.push(`Only ${custUsers} non-administrator user${custUsers === 1 ? "" : "s"} made requests in this period: averages and concentration aren't meaningful yet.`);
  if (t.total < 20) gaps.push(`Only ${t.total} coding task${t.total === 1 ? "" : "s"} in this period: per-task costs aren't reliable yet.`);
  gaps.push(
    "Plan changes (upgrades, downgrades, cancellations over time) aren't kept as history: subscriptions holds each user's current state only, so upgrade and retention rates need a subscription events record (one row per Stripe subscription change).",
  );
  gaps.push("Payment fees aren't recorded per payment; Finance uses the fee rate set in Admin → Plans. Recording Stripe's balance-transaction fee would make margins exact.");
  gaps.push("Hosting (Vercel functions, Supabase) isn't recorded per request; Finance uses the overhead set in Admin → Plans.");
  gaps.push("Workspace computer time isn't linked to coding tasks, so per-task cost covers model calls only.");
  if (n(raw.by_plan.find((p) => p.entitlement === "admin_unlimited")?.model_cost_usd) > custCost)
    gaps.push("Most cost in this period came from administrator accounts (testing); it's shown separately and left out of the per-user metrics.");

  return {
    periodDays,
    plans: plans.sort((a, b) => b.variableCostUsd - a.variableCostUsd),
    metrics,
    costByFeature: raw.by_purpose.map((p) => ({ feature: p.purpose, calls: p.calls, costUsd: r4(n(p.cost_usd)) })),
    gaps,
  };
}
