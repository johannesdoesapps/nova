import { PLAN_IDS, chargeUsd, planEconomics, planOf, type BillingInterval, type BillingSettings, type PlanId } from "../plans";

/**
 * Business figures for the admin finance dashboard, from
 * admin_finance_summary (raw aggregates) and the plan settings. Pure, so it
 * can be tested. AI costs are the recorded per-request estimates from
 * official prices; Stripe fees and hosting are the configured assumptions.
 */

export interface FinanceSummary {
  subscriptions: { plan: string; interval: string | null; status: string; count: number; price_usd: number | string | null; canceling: number }[];
  canceled_since: number;
  cost_by_plan: Record<string, number | string>;
  cost_by_model: { model: string; runs: number; cost: number | string; input_tokens: number; output_tokens: number }[];
  daily_cost: { day: string; cost: number | string; runs: number }[];
  top_users: { user_id: string; email: string | null; plan: string; status: string | null; interval: string | null; cost: number | string; runs: number; admin: boolean }[];
  users_total: number;
}

export interface PlanFinance {
  plan: PlanId;
  label: string;
  subscribers: number;
  canceling: number;
  mrrUsd: number;
  feesUsd: number;
  overheadUsd: number;
  aiCostUsd: number;
  aiBudgetUsd: number;
  profitUsd: number;
  /** Profit as a share of revenue; null without revenue. */
  margin: number | null;
}

export interface FinanceAlert {
  level: "warning" | "critical";
  text: string;
}

export interface FinanceReport {
  periodDays: number;
  plans: PlanFinance[];
  totals: { mrrUsd: number; arrUsd: number; aiCostUsd: number; feesUsd: number; overheadUsd: number; profitUsd: number; margin: number | null; subscribers: number; users: number };
  projection: { aiCostUsd: number; profitUsd: number; margin: number | null; basis: string };
  models: { model: string; runs: number; costUsd: number; inputTokens: number; outputTokens: number }[];
  daily: { day: string; costUsd: number; runs: number }[];
  topUsers: { email: string | null; plan: string; costUsd: number; runs: number; budgetUsd: number | null; budgetShare: number | null; admin: boolean }[];
  pastDue: number;
  canceledRecently: number;
  alerts: FinanceAlert[];
}

const n = (x: number | string | null | undefined) => Number(x ?? 0) || 0;
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function financeReport(s: FinanceSummary, billing: BillingSettings, periodDays = 30, now = Date.now()): FinanceReport {
  const scale = periodDays / 30; // monthly figures → the period
  const plans: PlanFinance[] = PLAN_IDS.map((id) => {
    const plan = planOf(billing, id);
    const rows = s.subscriptions.filter((r) => r.plan === id && (r.status === "active" || r.status === "trialing"));
    let mrr = 0;
    let fees = 0;
    let subscribers = 0;
    let budget = 0;
    for (const r of rows) {
      const interval: BillingInterval = r.interval === "year" ? "year" : "month";
      const charged = n(r.price_usd) || chargeUsd(plan, interval);
      const monthly = interval === "year" ? charged / 12 : charged;
      const perCharge = (charged * billing.paymentFeePercent) / 100 + billing.paymentFeeFixedUsd;
      subscribers += r.count;
      mrr += r.count * monthly;
      fees += r.count * (interval === "year" ? perCharge / 12 : perCharge);
      budget += r.count * planEconomics(billing, id, interval).aiBudgetUsd;
    }
    const overhead = id === "free" ? 0 : subscribers * billing.overheadPerSubscriberUsd;
    const ai = n(s.cost_by_plan[`plan:${id}`]);
    const profit = (mrr - fees - overhead) * scale - ai;
    return {
      plan: id,
      label: plan.label,
      subscribers: id === "free" ? Math.max(0, s.users_total - s.subscriptions.filter((r) => r.plan !== "free" && (r.status === "active" || r.status === "trialing")).reduce((a, r) => a + r.count, 0)) : subscribers,
      canceling: rows.reduce((a, r) => a + r.canceling, 0),
      mrrUsd: round(mrr),
      feesUsd: round(fees),
      overheadUsd: round(overhead),
      aiCostUsd: round(ai, 4),
      aiBudgetUsd: round(id === "free" ? (plan.aiBudgetUsd ?? 0) : budget),
      profitUsd: round(profit),
      margin: mrr > 0 ? round(profit / (mrr * scale), 4) : null,
    };
  });

  const otherAi = Object.entries(s.cost_by_plan)
    .filter(([k]) => !PLAN_IDS.some((id) => k === `plan:${id}`))
    .reduce((a, [, v]) => a + n(v), 0); // administrators, signed-out visitors and older runs
  const mrr = plans.reduce((a, p) => a + p.mrrUsd, 0);
  const fees = plans.reduce((a, p) => a + p.feesUsd, 0);
  const overhead = plans.reduce((a, p) => a + p.overheadUsd, 0);
  const ai = plans.reduce((a, p) => a + p.aiCostUsd, 0) + otherAi;
  const profit = (mrr - fees - overhead) * scale - ai;

  const daily = s.daily_cost.map((d) => ({ day: String(d.day), costUsd: n(d.cost), runs: d.runs }));
  const last7 = daily.filter((d) => Date.parse(d.day) >= now - 7 * 86_400_000);
  const avg7 = last7.length ? last7.reduce((a, d) => a + d.costUsd, 0) / 7 : 0;
  const projectedAi = avg7 * 30;
  const projectedProfit = mrr - fees - overhead - projectedAi;

  const topUsers = s.top_users.map((u) => {
    const pid = (PLAN_IDS as readonly string[]).includes(u.plan) && (u.plan === "free" || u.status === "active" || u.status === "trialing") ? (u.plan as PlanId) : "free";
    const budgetUsd = u.admin ? null : planEconomics(billing, pid, u.interval === "year" ? "year" : "month").aiBudgetUsd * scale;
    return { email: u.email, plan: pid, costUsd: round(n(u.cost), 4), runs: u.runs, budgetUsd: budgetUsd === null ? null : round(budgetUsd, 2), budgetShare: budgetUsd ? round(n(u.cost) / budgetUsd, 3) : null, admin: u.admin };
  });

  const pastDue = s.subscriptions.filter((r) => r.status === "past_due").reduce((a, r) => a + r.count, 0);
  const alerts: FinanceAlert[] = [];
  for (const u of topUsers) {
    if (u.budgetShare !== null && u.budgetShare >= 1) alerts.push({ level: "critical", text: `${u.email ?? "A user"} (${u.plan}) used ${Math.round(u.budgetShare * 100)}% of their AI budget in the last ${periodDays} days.` });
    else if (u.budgetShare !== null && u.budgetShare >= 0.8) alerts.push({ level: "warning", text: `${u.email ?? "A user"} (${u.plan}) is at ${Math.round(u.budgetShare * 100)}% of their AI budget.` });
  }
  const today = daily.at(-1);
  const before = daily.slice(-8, -1);
  const prevAvg = before.length ? before.reduce((a, d) => a + d.costUsd, 0) / before.length : 0;
  if (today && prevAvg > 0 && today.costUsd > 2 * prevAvg && today.costUsd > 0.5) {
    alerts.push({ level: "warning", text: `AI spend on ${today.day} ($${today.costUsd.toFixed(2)}) is more than twice the previous 7-day average ($${prevAvg.toFixed(2)}).` });
  }
  if (pastDue) alerts.push({ level: "warning", text: `${pastDue} subscription${pastDue === 1 ? " has" : "s have"} a failed payment (past due) and ${pastDue === 1 ? "is" : "are"} on Free until paid.` });
  for (const p of plans) {
    if (p.plan !== "free" && p.margin !== null && p.margin < billing.targetMargin) {
      alerts.push({ level: p.margin < 0 ? "critical" : "warning", text: `${p.label} margin is ${Math.round(p.margin * 100)}% over the last ${periodDays} days, below the ${Math.round(billing.targetMargin * 100)}% target.` });
    }
  }
  const freeAi = plans.find((p) => p.plan === "free")!.aiCostUsd;
  const paidSubs = plans.filter((p) => p.plan !== "free").reduce((a, p) => a + p.subscribers, 0);
  if (freeAi > billing.freeSubsidyPerSubscriberUsd * Math.max(1, paidSubs) * scale) {
    alerts.push({ level: "warning", text: `Free users cost $${freeAi.toFixed(2)} in the last ${periodDays} days, more than the $${billing.freeSubsidyPerSubscriberUsd.toFixed(2)} per paying subscriber that prices assume.` });
  }

  return {
    periodDays,
    plans,
    totals: { mrrUsd: round(mrr), arrUsd: round(mrr * 12), aiCostUsd: round(ai, 4), feesUsd: round(fees), overheadUsd: round(overhead), profitUsd: round(profit), margin: mrr > 0 ? round(profit / (mrr * scale), 4) : null, subscribers: paidSubs, users: s.users_total },
    projection: { aiCostUsd: round(projectedAi), profitUsd: round(projectedProfit), margin: mrr > 0 ? round(projectedProfit / mrr, 4) : null, basis: "last 7 days of AI spend × 30, current subscribers" },
    models: s.cost_by_model.map((m) => ({ model: m.model, runs: m.runs, costUsd: round(n(m.cost), 4), inputTokens: n(m.input_tokens), outputTokens: n(m.output_tokens) })),
    daily,
    topUsers,
    pastDue,
    canceledRecently: s.canceled_since,
    alerts,
  };
}
