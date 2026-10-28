import "server-only";
import type { AuthContext } from "./auth";
import { entitlementFor } from "./entitlements";
import { reportError } from "./observability";
import { planUsage } from "./usage";
import { ESTIMATED_FEATURES, estimateRuns, headline, runsFromRecords, weekPct, type EstimatedFeature, type RunEstimate } from "./usage-glance";

type Authed = Extract<AuthContext, { mode: "authenticated" }>;

/** What a costly task usually uses, as shares of the week, for the line shown before it starts. */
export interface UsageEstimate {
  feature: EstimatedFeature;
  label: string;
  /** No allowance on this account: nothing to estimate. */
  unlimited: boolean;
  /** Share of this week's allowance left (100 − used), or null when it can't be read. */
  weekLeftPct: number | null;
  /** The 5-hour session's share used, when it's the tighter limit right now. */
  windowUsedPct: number | null;
  /** From the user's own runs of this task (last 30 days), else everyone's; null when there aren't enough runs. */
  estimate: { typicalPct: number; lowPct: number; highPct: number; runs: number; source: RunEstimate["source"] } | null;
}

const LOOKBACK_MS = 30 * 86_400_000;
const EVERYONE_TTL_MS = 10 * 60_000;
const everyone = new Map<EstimatedFeature, { at: number; value: RunEstimate | null }>();

/** The typical run across all accounts (an aggregate from the database), cached for a few minutes per feature. */
async function everyonesRun(auth: Authed, feature: EstimatedFeature): Promise<RunEstimate | null> {
  const hit = everyone.get(feature);
  if (hit && Date.now() - hit.at < EVERYONE_TTL_MS) return hit.value;
  const { data, error } = await auth.supabase.rpc("usage_typical_run", { p_purposes: [...ESTIMATED_FEATURES[feature].purposes] });
  if (error) {
    // Not applied yet, or the database is busy: the estimate falls back to "not enough runs yet".
    reportError(error, { where: "usage_typical_run" });
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as { typical: number | string; low: number | string; high: number | string; runs: number } | undefined;
  const value = row && Number(row.runs) > 0 ? { typical: Number(row.typical), low: Number(row.low), high: Number(row.high), runs: Number(row.runs), source: "everyone" as const } : null;
  everyone.set(feature, { at: Date.now(), value });
  return value;
}

export async function usageEstimate(auth: Authed, feature: EstimatedFeature): Promise<UsageEstimate> {
  const label = ESTIMATED_FEATURES[feature].label;
  const entitlement = await entitlementFor(auth);
  if (!entitlement || entitlement.kind === "unlimited") return { feature, label, unlimited: true, weekLeftPct: null, windowUsedPct: null, estimate: null };
  const weekly = entitlement.limits.weeklyUnits;
  const [state, own] = await Promise.all([
    planUsage(auth),
    auth.supabase
      .from("model_runs")
      .select("created_at, units")
      .eq("user_id", auth.user.id)
      .in("purpose", [...ESTIMATED_FEATURES[feature].purposes])
      .gte("created_at", new Date(Date.now() - LOOKBACK_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);
  if (own.error) reportError(own.error, { where: "usage_estimate.own" });
  const rows = ((own.data ?? []) as { created_at: string; units: number | string | null }[]).map((r) => ({ at: Date.parse(r.created_at), units: Number(r.units ?? 0) }));
  const run = estimateRuns(runsFromRecords(rows), "you") ?? (await everyonesRun(auth, feature));
  const h = state ? headline(state) : null;
  return {
    feature,
    label,
    unlimited: false,
    weekLeftPct: state ? Math.max(0, 100 - Math.min(100, Math.floor((state.week.used / Math.max(1, state.week.limit)) * 100))) : null,
    windowUsedPct: h && h.scope === "window" ? h.pct : null,
    estimate: run ? { typicalPct: weekPct(run.typical, weekly), lowPct: weekPct(run.low, weekly), highPct: weekPct(run.high, weekly), runs: run.runs, source: run.source } : null,
  };
}
