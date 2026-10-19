import "server-only";
import { cheapestModel } from "./ai/router";
import type { ModelInfo, ModelWithStatus } from "./ai/types";
import type { AuthContext } from "./auth";
import type { Entitlement } from "./entitlements";
import { serverEnv } from "./env";
import { ApiError } from "./http";
import { reportError } from "./observability";
import { PREMIUM_BUDGET_SHARE, proAiBudgetUsd } from "./plans";
import { serviceSupabase } from "./supabase/admin";

/**
 * AI budget guard. Each account has a monthly AI cost budget in USD:
 * - Pro: what keeps the 60% margin — price × 40% − payment fee − overheads
 *   (proAiBudgetUsd in plans.ts), per billing period;
 * - Free: NOVA_FREE_AI_BUDGET_USD per calendar month;
 * - administrators: none.
 * Below 80% of the budget any model may be used; from 80% only the
 * lowest-cost available model; at 100% AI requests stop until the period
 * renews. Optionally, NOVA_MONTHLY_AI_BUDGET_USD caps the whole site's spend
 * per calendar month (administrators excepted).
 *
 * Spend is the recorded cost of the account's runs. Runs without a verified
 * price are counted at the most expensive verified price, so an unpriced
 * model can't slip past the guard.
 */

const DAY = 86_400_000;

export interface BudgetStatus {
  /** Monthly budget in USD; null when the account has none. */
  limitUsd: number | null;
  spentUsd: number;
  /** When the budget period started and when it renews (epoch ms). */
  periodStart: number;
  resetsAt: number;
  /** "ok": any model; "economy": lowest-cost model only; "exhausted": no AI until resetsAt. */
  state: "ok" | "economy" | "exhausted";
}

export function budgetLimitUsd(entitlement: Entitlement | null): number | null {
  if (!entitlement || entitlement.kind === "unlimited") return null;
  const env = serverEnv();
  if (entitlement.plan === "pro") {
    return proAiBudgetUsd({ feePercent: env.paymentFeePercent, feeFixedUsd: env.paymentFeeFixedUsd, overheadUsd: env.overheadPerSubscriberUsd });
  }
  return env.freeAiBudgetUsd;
}

/** The current budget period: the Pro billing period, else the calendar month (UTC). */
export function budgetPeriod(entitlement: Entitlement | null, now = Date.now()): { start: number; end: number } {
  if (entitlement?.plan === "pro" && entitlement.periodStart && entitlement.periodStart <= now) {
    let start = entitlement.periodStart;
    // If the webhook hasn't moved the period on yet, step forward in 30-day periods.
    while (start + 30 * DAY <= now) start += 30 * DAY;
    return { start, end: addMonth(start) };
  }
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return { start, end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}

function addMonth(t: number): number {
  const d = new Date(t);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  return Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), Math.min(d.getUTCDate(), lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

export function budgetState(spentUsd: number, limitUsd: number | null): BudgetStatus["state"] {
  if (limitUsd === null) return "ok";
  if (spentUsd >= limitUsd) return "exhausted";
  if (spentUsd >= limitUsd * PREMIUM_BUDGET_SHARE) return "economy";
  return "ok";
}

type RunCost = { estimated_cost: number | string | null; input_tokens: number | null; output_tokens: number | null };

/** Cost of runs, counting unpriced runs at the most expensive verified price. */
export function costOfRuns(rows: RunCost[], models: ModelInfo[]): number {
  const priced = models.filter((m) => m.inputPrice !== null && m.outputPrice !== null);
  const maxIn = Math.max(0, ...priced.map((m) => m.inputPrice!));
  const maxOut = Math.max(0, ...priced.map((m) => m.outputPrice!));
  let total = 0;
  for (const r of rows) {
    if (r.estimated_cost !== null && r.estimated_cost !== undefined) total += Number(r.estimated_cost);
    else total += ((r.input_tokens ?? 2000) * maxIn + (r.output_tokens ?? 1000) * maxOut) / 1_000_000;
  }
  return total;
}

export async function budgetStatus(auth: AuthContext, entitlement: Entitlement | null, models: ModelInfo[], now = Date.now()): Promise<BudgetStatus | null> {
  if (auth.mode !== "authenticated") return null;
  const limitUsd = budgetLimitUsd(entitlement);
  const { start, end } = budgetPeriod(entitlement, now);
  if (limitUsd === null) return { limitUsd, spentUsd: 0, periodStart: start, resetsAt: end, state: "ok" };
  const { data, error } = await auth.supabase
    .from("model_runs")
    .select("estimated_cost, input_tokens, output_tokens")
    .gte("created_at", new Date(start).toISOString())
    .gt("units", 0)
    .limit(20_000);
  if (error) {
    reportError(error, { where: "budgetStatus" });
    return null;
  }
  const spentUsd = costOfRuns((data ?? []) as RunCost[], models);
  return { limitUsd, spentUsd, periodStart: start, resetsAt: end, state: budgetState(spentUsd, limitUsd) };
}

let siteSpendCache: { at: number; month: number; usd: number } | null = null;

/** The whole site's AI spend this calendar month (service role; cached for a minute). */
async function siteSpendUsd(models: ModelInfo[], now: number): Promise<number | null> {
  const d = new Date(now);
  const month = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  if (siteSpendCache && siteSpendCache.month === month && now - siteSpendCache.at < 60_000) return siteSpendCache.usd;
  const admin = serviceSupabase();
  if (!admin) return null;
  const { data, error } = await admin
    .from("model_runs")
    .select("estimated_cost, input_tokens, output_tokens")
    .gte("created_at", new Date(month).toISOString())
    .gt("units", 0)
    .limit(200_000);
  if (error) {
    reportError(error, { where: "siteSpendUsd" });
    return null;
  }
  const usd = costOfRuns((data ?? []) as RunCost[], models);
  siteSpendCache = { at: now, month, usd };
  return usd;
}

const when = (t: number) => new Date(t).toISOString();

/**
 * Throws when the request's models aren't allowed by the account's budget.
 * `available` is the list users can choose from (to find the lowest-cost model).
 */
export async function enforceBudget(
  auth: AuthContext,
  entitlement: Entitlement | null,
  requested: ModelInfo[] | undefined,
  available: ModelWithStatus[],
  all: ModelInfo[],
  now = Date.now(),
): Promise<void> {
  if (auth.mode !== "authenticated" || !entitlement || entitlement.kind === "unlimited") return;

  const siteCap = serverEnv().monthlyAiBudgetUsd;
  if (siteCap !== null) {
    const spent = await siteSpendUsd(all, now);
    if (spent !== null && spent >= siteCap) {
      throw new ApiError("quota_exceeded", "NOVA has reached its AI usage limit for this month. Please try again next month.", { scope: "site", budget: true });
    }
  }

  const status = await budgetStatus(auth, entitlement, all, now);
  if (!status || status.state === "ok") return;
  if (status.state === "exhausted") {
    throw new ApiError("quota_exceeded", `You've used this month's AI budget for your ${entitlement.plan === "pro" ? "Pro" : "Free"} plan.`, {
      scope: "budget",
      budget: true,
      resetsAt: when(status.resetsAt),
    });
  }
  // Economy: only the lowest-cost available model.
  const cheapest = cheapestModel(available);
  const premium = (requested ?? []).filter((m) => m.id !== cheapest?.id);
  if (premium.length) {
    throw new ApiError(
      "quota_exceeded",
      `You've used most of this month's AI budget, so only the lowest-cost model${cheapest ? ` (${cheapest.displayName})` : ""} is available until it renews. Choose Auto to keep going.`,
      { scope: "budget", budget: true, economy: true, resetsAt: when(status.resetsAt), allowedModelId: cheapest?.id ?? null },
    );
  }
}
