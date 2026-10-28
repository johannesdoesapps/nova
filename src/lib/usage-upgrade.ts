/** What the next plan would give at a limit, in numbers (for the messages in usage.ts). Pure. */
import { planEconomics, type BillingSettings, type PlanId } from "./plans";

/** The limit a request ran into (ApiError details.scope from enforceLimits). */
export type LimitScope = "window" | "week" | "top_week" | "budget" | "tokens" | "day" | "daily";

const times = (r: number) => (r >= 2 ? `${Math.floor(r)}×` : `${Math.round((r - 1) * 100)}% more than`);

/**
 * One sentence on what the next plan gives for the limit that was reached, e.g. " Pro ($28/month) includes 36×
 * this weekly allowance." Empty when there is no bigger plan. Only ratios are shown: AI budgets are internal.
 */
export function upgradeLine(billing: BillingSettings, from: PlanId, scope: LimitScope): string {
  const to: PlanId | null = from === "free" ? "pro" : from === "pro" ? "max" : null;
  if (!to) return "";
  const a = billing.plans[from];
  const b = billing.plans[to];
  const name = `${b.label} ($${b.priceUsd}/month)`;
  const ratio = (x: number, y: number) => (x > 0 && y > x ? y / x : null);
  let r: number | null = null;
  let what = "";
  switch (scope) {
    case "window":
      r = ratio(a.windowUnits, b.windowUnits);
      what = "the allowance per 5-hour session";
      break;
    case "week":
      r = ratio(a.weeklyUnits, b.weeklyUnits);
      what = "this weekly allowance";
      break;
    case "top_week":
      r = ratio(a.topWeeklyUnits, b.topWeeklyUnits);
      what = "the weekly allowance for premium models";
      break;
    case "tokens":
      if (a.monthlyTokens > 0 && b.monthlyTokens === 0) return ` ${name} has no monthly token cap.`;
      r = ratio(a.monthlyTokens, b.monthlyTokens);
      what = "the monthly tokens";
      break;
    case "day":
      if (a.dailyMessages > 0 && b.dailyMessages === 0) return ` ${name} has no daily message limit.`;
      r = ratio(a.dailyMessages, b.dailyMessages);
      what = "the messages per day";
      break;
    case "budget":
    case "daily": {
      r = ratio(planEconomics(billing, from).aiBudgetUsd, planEconomics(billing, to).aiBudgetUsd);
      what = "the monthly AI allowance";
      break;
    }
  }
  return r ? ` ${name} includes ${times(r)} ${what}.` : ` ${name} includes more.`;
}
