import "server-only";
import type { AuthContext } from "@/lib/auth";
import { budgetPeriod, nextRenewal } from "@/lib/budget";
import { entitlementFor } from "@/lib/entitlements";
import { ApiError } from "@/lib/http";
import { reportError } from "@/lib/observability";
import type { CodeLanguage, CodeRunResult } from "./languages";
import { codeRunCostUsd } from "./pricing";
import { usageWriter } from "../supabase/admin";

/**
 * Metering for code runs. A run is reserved like an AI request (so duplicates
 * are refused and it counts while it runs), then checked against the plan's
 * monthly runs and the site-wide monthly limit, and recorded in model_runs
 * with tools = {code_run} and its sandbox cost (see ./pricing.ts).
 */

type Authed = Extract<AuthContext, { mode: "authenticated" }>;

export interface RunAllowance {
  /** Runs left this period after this one; null for accounts without an allowance. */
  left: number | null;
  limit: number | null;
}

/** Release a run's hold without recording it (the run didn't happen). */
export async function releaseRun(auth: Authed, requestId: string): Promise<void> {
  const { error } = await auth.supabase.rpc("usage_finish", { p_request_id: requestId, p_state: "released" });
  if (error) reportError(error, { where: "code_run.release" });
}

/**
 * After the run's hold is in place: refuse when the plan's runs for this period
 * or the site's runs for this month are used up. Counts include requests still
 * running, this one among them.
 */
export async function checkRunAllowance(auth: Authed, requestId: string): Promise<RunAllowance> {
  const entitlement = await entitlementFor(auth);
  if (!entitlement) throw new ApiError("not_configured", "Code runs need accounts to be set up.");
  const billing = entitlement.billing;
  const unlimited = entitlement.kind === "unlimited";
  const period = budgetPeriod(entitlement);
  const { data, error } = await auth.supabase.rpc("code_run_status", { p_since: new Date(period.start).toISOString() });
  if (error) {
    reportError(error, { where: "code_run_status" });
    if (!unlimited) {
      await releaseRun(auth, requestId);
      throw new ApiError("upstream_error", "Code run limits can't be checked right now. Please try again shortly.");
    }
    return { left: null, limit: null };
  }
  const s = data as { user_runs: number; user_in_flight: number; site_runs: number };
  if (billing.codeRunsSiteMonthly > 0 && Number(s.site_runs) > billing.codeRunsSiteMonthly) {
    await releaseRun(auth, requestId);
    reportError(new Error("Site-wide monthly code run limit reached"), { where: "code_run.site_cap" });
    throw new ApiError("quota_exceeded", "Orbis has reached its limit for running code this month. Please try again next month.", { scope: "code_site" });
  }
  if (unlimited) return { left: null, limit: null };
  const limit = entitlement.limits.codeRunsPerPeriod;
  const used = Number(s.user_runs) + Number(s.user_in_flight);
  if (limit <= 0 || used > limit) {
    await releaseRun(auth, requestId);
    const upgrade = entitlement.plan === "free" ? "pro" : entitlement.plan === "pro" ? "max" : null;
    const hint = upgrade ? ` ${billing.plans[upgrade].label} includes ${billing.plans[upgrade].codeRunsPerPeriod.toLocaleString("en-US")} a month.` : "";
    throw new ApiError(
      "quota_exceeded",
      limit <= 0
        ? `Running code isn't included in the ${entitlement.limits.label} plan.${hint}`
        : `You've used this month's ${limit.toLocaleString("en-US")} code runs on the ${entitlement.limits.label} plan. They renew on ${nextRenewal(period.end)}.${hint}`,
      { scope: "code_runs", plan: entitlement.plan, upgradeTo: upgrade, resetsAt: new Date(period.end).toISOString() },
    );
  }
  return { left: Math.max(0, limit - used), limit };
}

/** Record a finished run: its sandbox cost, settled against the request's hold. No code or output is stored. */
export async function recordCodeRun(auth: Authed, requestId: string, lang: CodeLanguage, run: CodeRunResult, reservedUsd: number): Promise<void> {
  const entitlement = await entitlementFor(auth);
  const { error } = await usageWriter(auth.supabase).from("model_runs").insert({
    user_id: auth.user.id,
    model_id: "vercel:sandbox",
    prompt: `${lang.label} code run`,
    response: run.timedOut ? "timed out" : `exit ${run.exitCode}`,
    latency_ms: Math.round(run.durationMs),
    input_tokens: 0,
    output_tokens: 0,
    model_tier: "standard",
    reserved_cost_usd: reservedUsd,
    estimated_cost: codeRunCostUsd(run.durationMs),
    status: "success",
    purpose: "code_run",
    request_id: requestId,
    requested_model: lang.id,
    units: 0,
    entitlement: entitlement?.label ?? null,
    tools: ["code_run"],
  });
  if (error) reportError(error, { where: "code_run.record" });
  const fin = await auth.supabase.rpc("usage_finish", { p_request_id: requestId, p_state: "settled" });
  if (fin.error) reportError(fin.error, { where: "code_run.settle" });
}
