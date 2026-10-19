import "server-only";
import { entitlementFor } from "./entitlements";
import type { AuthContext } from "./auth";
import { getPlatformSettings } from "./ai/settings";
import { estimateCost } from "./ai/cost";
import type { ModelInfo, Usage } from "./ai/types";
import { serverEnv } from "./env";
import { ApiError, clientIp } from "./http";
import { LARGE_MODEL_UNITS, WEEK_MS, WINDOW_MS, modelUnits, unitsLeft, type UsageState } from "./plans";
import { limiter } from "./rate-limit";
import { reportError } from "./observability";

/**
 * Usage accounting. Policy (see docs/USAGE.md):
 * - Each model call costs usage units by the model that actually answered:
 *   1 for low-cost models, 15 for larger ones, or the admin's per-model setting.
 * - Before a request runs, its units are reserved atomically in the database
 *   (usage_reserve): a per-user lock means concurrent requests can't both slip
 *   under the limit, and a request id can only be reserved once, so duplicate
 *   submissions aren't charged twice.
 * - The charge is the recorded run (model_runs.units). Failed requests that
 *   produced no output are refunded (0 units); partial replies are charged.
 * - Who has which allowance is decided by entitlementFor() in entitlements.ts.
 */
export interface UsageTicket {
  requestId: string;
  /** Units reserved for this request (0 when no allowance applies). */
  units: number;
  entitlement: string | null;
}

const tickets = new WeakMap<object, UsageTicket>();
const NO_LIMIT = 1_000_000_000;

/** The reservation made for this request, if any (used to link runs to their request). */
export function ticketFor(auth: AuthContext): UsageTicket | null {
  return tickets.get(auth) ?? null;
}

function unitsFor(models: ModelInfo[] | undefined, cost: number, overrides: Record<string, number>): number {
  return models?.length ? models.reduce((s, m) => s + modelUnits(m.capabilities, overrides[m.id]), 0) : cost;
}

/**
 * Enforce per-minute rate limits, then reserve the request's units against the
 * plan's 5-hour and weekly allowance (signed-in users) or apply the daily cap
 * (guests). `cost` is the number of model calls; when `models` is given each
 * call is weighted by its model. `requestId` (from the browser) makes retries
 * of the same submission idempotent.
 */
export async function enforceLimits(
  req: Request,
  auth: AuthContext,
  cost = 1,
  models?: ModelInfo[],
  opts: { requestId?: string | null; purpose?: string } = {},
): Promise<UsageTicket> {
  const env = serverEnv();
  const who = auth.mode === "authenticated" ? `u:${auth.user.id}` : `ip:${clientIp(req)}`;
  const requestId = opts.requestId ?? crypto.randomUUID();

  const minute = limiter("minute", env.ratePerMinute, 60_000).check(who, cost);
  if (!minute.ok) {
    throw new ApiError("rate_limited", "Too many requests. Please wait a moment and try again.", {
      retryAfterSeconds: Math.ceil((minute.resetAt - Date.now()) / 1000),
    });
  }

  if (auth.mode !== "authenticated") {
    const day = limiter("day", env.dailyRequestLimit, 86_400_000).check(who, cost);
    if (!day.ok) throw new ApiError("quota_exceeded", `Daily guest limit of ${env.dailyRequestLimit} requests reached.`);
    return { requestId, units: 0, entitlement: null };
  }

  const [entitlement, settings] = await Promise.all([entitlementFor(auth), getPlatformSettings()]);
  const units = unitsFor(models, cost, settings.modelUnits);
  if (!entitlement) return { requestId, units: 0, entitlement: null };

  // Accounts without an allowance still reserve, with no limit, so duplicate submissions are refused for everyone.
  const unlimited = entitlement.kind === "unlimited";
  const { data, error } = await auth.supabase.rpc("usage_reserve", {
    p_request_id: requestId,
    p_units: units,
    p_window_limit: unlimited ? NO_LIMIT : entitlement.limits.windowUnits,
    p_week_limit: unlimited ? NO_LIMIT : entitlement.limits.weeklyUnits,
    p_purpose: opts.purpose ?? null,
    p_model: models?.map((m) => m.id).join(",") ?? null,
    // Calls without a model list are short checks; don't hold their units for long.
    p_ttl_seconds: models?.length ? 180 : 45,
  });
  if (error) {
    // The allowance can't be checked (database unavailable): log it and let the request through rather than block everyone.
    reportError(error, { where: "usage_reserve" });
    return { requestId, units: 0, entitlement: entitlement.label };
  }
  const r = data as { ok: boolean; reason?: "duplicate" | "limit"; scope?: "window" | "week"; used?: number; limit?: number; resets_at?: string };
  if (!r.ok && r.reason === "duplicate") {
    throw new ApiError("conflict", "This message was already sent. NOVA won't run or charge it twice.");
  }
  if (!r.ok) {
    if (entitlement.kind === "unlimited") {
      reportError(new Error(`usage_reserve refused an unlimited account: ${r.reason}`), { where: "usage_reserve" });
      return { requestId, units: 0, entitlement: entitlement.label };
    }
    const plan = entitlement.limits;
    const left = Math.max(0, Number(r.limit ?? 0) - Number(r.used ?? 0));
    const scope = r.scope === "week" ? "weekly" : "5-hour";
    const heavy = models?.length === 1 && units > 1 ? ` ${models[0]!.displayName} uses ${units} units per message and you have ${left} left; Auto or a lighter model uses 1.` : "";
    throw new ApiError("quota_exceeded", `You've reached your ${plan.label} plan's ${scope} limit.${heavy}`, {
      scope: r.scope,
      resetsAt: r.resets_at ? new Date(r.resets_at).toISOString() : null,
      plan: entitlement.plan,
      unitsNeeded: units,
      unitsLeft: left,
    });
  }
  const ticket = { requestId, units, entitlement: entitlement.label };
  tickets.set(auth, ticket);
  return ticket;
}

/** Release this request's reservation without charging (the request failed before any model ran). */
export async function releaseUsage(auth: AuthContext): Promise<void> {
  const t = tickets.get(auth);
  if (!t || auth.mode !== "authenticated" || !t.units) return;
  const { error } = await auth.supabase.rpc("usage_finish", { p_request_id: t.requestId, p_state: "released" });
  if (error) reportError(error, { where: "usage_finish" });
}

/** The user's plan: Pro only while a subscription is active; everyone else is Free. */
export { userPlan } from "./entitlements";

/**
 * Current 5-hour window and weekly usage (charged runs plus requests in
 * flight). Null for guests, for accounts without an allowance (administrators)
 * and when it can't be read.
 */
export async function planUsage(auth: AuthContext): Promise<UsageState | null> {
  if (auth.mode !== "authenticated") return null;
  const entitlement = await entitlementFor(auth);
  if (!entitlement || entitlement.kind === "unlimited") return null;
  const { data, error } = await auth.supabase.rpc("usage_status");
  if (error) {
    reportError(error, { where: "usage_status" });
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as { window_used: number | string; window_start: string | null; week_used: number | string; week_oldest: string | null } | undefined;
  const plan = entitlement.limits;
  return {
    plan: plan.id,
    window: { used: Number(row?.window_used ?? 0), limit: plan.windowUnits, resetsAt: row?.window_start ? Date.parse(row.window_start) + WINDOW_MS : null },
    week: { used: Number(row?.week_used ?? 0), limit: plan.weeklyUnits, resetsAt: row?.week_oldest ? Date.parse(row.week_oldest) + WEEK_MS : null },
  };
}

/**
 * Whether Auto and agent defaults should keep to low-cost models: once 80% of
 * the allowance is used, or whenever fewer units are left than two messages to
 * a larger model need (always the case on Free), so one message can't use up
 * the whole allowance.
 */
export async function shouldSaveAllowance(auth: AuthContext): Promise<boolean> {
  const u = await planUsage(auth);
  if (!u) return false;
  return u.window.used >= u.window.limit * 0.8 || u.week.used >= u.week.limit * 0.8 || unitsLeft(u) < LARGE_MODEL_UNITS * 2;
}

export interface RunRecord {
  model: ModelInfo;
  prompt: string;
  response: string;
  latencyMs: number;
  usage: Usage;
  status: "success" | "error";
  conversationId?: string | null;
  /** Which feature made the call: chat, search, compare, trial, benchmark, claims, route… */
  purpose?: string;
  category?: string | null;
  servedModel?: string | null;
  /** Set when this call happened because an earlier model in a fallback chain failed. */
  fallbackFrom?: string | null;
  /** What the user selected (a model id, "auto" or "auto:<mode>"). */
  requestedModel?: string | null;
  /** Why this model was used, for diagnostics. */
  routingReason?: string | null;
  /** Server-side tools that ran for this call (e.g. time, web_search). */
  tools?: string[];
  /** A short error code or message for failed calls (no prompt content). */
  error?: string | null;
}

/**
 * Persist a model run and its charge, then settle the request's reservation.
 * Units come from the model that actually answered. A failed call that
 * produced no output is refunded (0 units). Failures to record are logged, never fatal.
 */
export async function recordRun(auth: AuthContext, run: RunRecord): Promise<void> {
  if (auth.mode !== "authenticated") return;
  const ticket = tickets.get(auth);
  const [entitlement, settings] = await Promise.all([entitlementFor(auth), getPlatformSettings()]);
  const refunded = run.status === "error" && !run.response;
  const units = refunded ? 0 : modelUnits(run.model.capabilities, settings.modelUnits[run.model.id]);
  const { error } = await auth.supabase.from("model_runs").insert({
    user_id: auth.user.id,
    conversation_id: run.conversationId ?? null,
    model_id: run.model.id,
    prompt: run.prompt.slice(0, 4000),
    response: run.response.slice(0, 8000),
    latency_ms: Math.round(run.latencyMs),
    input_tokens: run.usage.inputTokens,
    output_tokens: run.usage.outputTokens,
    estimated_cost: estimateCost(run.model, run.usage),
    status: run.status,
    purpose: run.purpose ?? null,
    category: run.category ?? null,
    served_model: run.servedModel ?? null,
    fallback_from: run.fallbackFrom ?? null,
    request_id: ticket?.requestId ?? null,
    requested_model: run.requestedModel?.slice(0, 120) ?? null,
    routing_reason: run.routingReason?.slice(0, 500) ?? null,
    units,
    entitlement: entitlement?.label ?? null,
    error_code: run.error ? redactSecrets(run.error).slice(0, 300) : null,
    tools: run.tools?.length ? run.tools : null,
  });
  if (error) reportError(error, { where: "recordRun" });
  if (ticket?.units) {
    const fin = await auth.supabase.rpc("usage_finish", { p_request_id: ticket.requestId, p_state: "settled" });
    if (fin.error) reportError(fin.error, { where: "usage_finish" });
  }
}

/** Keep API keys and bearer tokens out of stored error text. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(sk|xai|gsk|hf|pk|rk)[-_][A-Za-z0-9_-]{10,}/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, "[redacted]");
}

export interface UsageSummary {
  runsToday: number;
  dailyLimit: number;
  estimatedCostToday: number | null;
  costIsPartial: boolean;
}

export async function usageSummary(auth: AuthContext): Promise<UsageSummary | null> {
  if (auth.mode !== "authenticated") return null;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { data, error } = await auth.supabase
    .from("model_runs")
    .select("estimated_cost")
    .gte("created_at", since.toISOString())
    .limit(5000);
  if (error || !data) return null;
  let total = 0;
  let unknown = 0;
  for (const r of data as { estimated_cost: number | string | null }[]) {
    if (r.estimated_cost === null) unknown++;
    else total += Number(r.estimated_cost);
  }
  return {
    runsToday: data.length,
    dailyLimit: serverEnv().dailyRequestLimit,
    estimatedCostToday: data.length === unknown ? null : total,
    costIsPartial: unknown > 0 && unknown < data.length,
  };
}
