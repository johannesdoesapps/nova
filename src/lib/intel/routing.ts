import { classifyTask, type TaskKind } from "../ai/router";
import type { ModelWithStatus } from "../ai/types";
import type { Fingerprint } from "./fingerprint";
import { privacyFor } from "./profiles";
import type { PrivacyProfile, TaskCategory } from "./types";

export interface RouteConstraints {
  /** Require providers verified not to train on API data. */
  requireNoTraining?: boolean;
  /** Require a verified retention period at or below this many days. */
  maxRetentionDays?: number | null;
  allowedProviders?: string[] | null;
  /** Max blended price (input + output, USD per 1M tokens). Unpriced models are excluded when set. */
  maxPricePer1M?: number | null;
  /** Max observed p50 latency in ms. Models without enough latency data are kept but flagged. */
  maxP50LatencyMs?: number | null;
  /** Which evidence stream to trust first. */
  prefer?: "personal" | "general";
}

export interface RoutePlan {
  category: TaskCategory;
  primary: string | null;
  fallbacks: string[];
  basis: "personal_preference" | "general_benchmark" | "rules";
  sufficiency: "clear" | "tentative" | "insufficient";
  explanation: string[];
  excluded: { modelId: string; reason: string }[];
}

const TASK_TO_CATEGORY: Record<TaskKind, TaskCategory> = {
  coding: "coding",
  analysis: "analysis",
  summary: "writing",
  "long-document": "research",
  general: "general",
};

export function categoryForPrompt(prompt: string, mode?: string): TaskCategory {
  if (/\b(extract|parse|pull out|fields?|json from|invoice|form data)\b/i.test(prompt)) return "extraction";
  if (mode === "research" || /\b(sources?|evidence|studies|research|cite|according to)\b/i.test(prompt)) return "research";
  if (/\b(write|draft|rewrite|essay|email|blog post|tagline|story|poem|edit)\b/i.test(prompt)) return "writing";
  return TASK_TO_CATEGORY[classifyTask(prompt, mode).kind];
}

function constraintFailure(m: ModelWithStatus, privacy: PrivacyProfile, c: RouteConstraints, p50: number | null): string | null {
  if (!m.available) return m.unavailableReason ?? "Unavailable";
  if (c.allowedProviders?.length && !c.allowedProviders.includes(m.provider)) return `Provider ${m.provider} is not in your allowed list.`;
  if (c.requireNoTraining && privacy.trainsOnApiData !== false) return privacy.trainsOnApiData === null ? "Training-on-data policy not verified." : "Provider may train on API data.";
  if (c.maxRetentionDays !== undefined && c.maxRetentionDays !== null) {
    if (privacy.retentionDays === null) return "Data retention not verified.";
    if (privacy.retentionDays > c.maxRetentionDays) return `Retains data ${privacy.retentionDays} days (limit ${c.maxRetentionDays}).`;
  }
  if (c.maxPricePer1M !== undefined && c.maxPricePer1M !== null) {
    if (m.inputPrice === null || m.outputPrice === null) return "No verified price, and you set a price limit.";
    if (m.inputPrice + m.outputPrice > c.maxPricePer1M) return `Blended price $${(m.inputPrice + m.outputPrice).toFixed(2)}/1M exceeds $${c.maxPricePer1M}.`;
  }
  if (c.maxP50LatencyMs && p50 !== null && p50 > c.maxP50LatencyMs) return `Observed median latency ${Math.round(p50)} ms exceeds ${c.maxP50LatencyMs} ms.`;
  return null;
}

/**
 * Plan a route: filter by hard constraints, then order by the user's own
 * evidence (only when sufficient), and fall back to the transparent rules
 * router. Fallbacks are the remaining eligible models, preferring other
 * providers first so one provider outage doesn't take out the whole chain.
 */
export function planRoute(args: {
  prompt: string;
  mode?: string;
  category?: TaskCategory;
  models: ModelWithStatus[];
  fingerprint: Fingerprint | null;
  privacyProfiles: Record<string, PrivacyProfile>;
  constraints?: RouteConstraints;
  rulesPick: string | null;
}): RoutePlan {
  const c = args.constraints ?? {};
  const category = args.category ?? categoryForPrompt(args.prompt, args.mode);
  const cat = args.fingerprint?.categories.find((x) => x.category === category);
  const p50 = (id: string) => cat?.models.find((m) => m.modelId === id)?.ops.p50 ?? null;

  const excluded: RoutePlan["excluded"] = [];
  const eligible = args.models.filter((m) => {
    const why = constraintFailure(m, privacyFor(m.provider, args.privacyProfiles), c, p50(m.id));
    if (why) excluded.push({ modelId: m.id, reason: why });
    return !why;
  });
  const explanation: string[] = [`Task category: ${category}.`];
  if (!eligible.length)
    return { category, primary: null, fallbacks: [], basis: "rules", sufficiency: "insufficient", explanation: [...explanation, "No model satisfies your constraints."], excluded };

  const recs = cat ? (c.prefer === "general" ? [cat.general, cat.personal] : [cat.personal, cat.general]) : [];
  const eligibleIds = new Set(eligible.map((m) => m.id));
  let primary: string | null = null;
  let basis: RoutePlan["basis"] = "rules";
  let sufficiency: RoutePlan["sufficiency"] = "insufficient";
  for (const level of ["clear", "tentative"] as const) {
    const hit = recs.find((r) => r.modelId && r.sufficiency === level && eligibleIds.has(r.modelId));
    if (hit) {
      primary = hit.modelId;
      basis = hit.basis;
      sufficiency = level;
      explanation.push(...hit.reasons);
      if (level === "tentative") explanation.push("Treat this as a provisional pick; more trials or benchmark runs would firm it up.");
      break;
    }
  }
  if (!primary) {
    primary = args.rulesPick && eligibleIds.has(args.rulesPick) ? args.rulesPick : eligible[0]!.id;
    explanation.push("Not enough of your own evaluation data for this category, so the published rules (capabilities, context, price) chose the model.");
  }
  const primaryProvider = eligible.find((m) => m.id === primary)!.provider;
  const rank = (id: string) => cat?.ranking.findIndex((r) => r.modelId === id) ?? -1;
  const fallbacks = eligible
    .filter((m) => m.id !== primary)
    .sort((a, b) => Number(a.provider === primaryProvider) - Number(b.provider === primaryProvider) || (rank(a.id) < 0 ? 99 : rank(a.id)) - (rank(b.id) < 0 ? 99 : rank(b.id)))
    .map((m) => m.id)
    .slice(0, 3);
  if (fallbacks.length) explanation.push(`Fallback order (tried on timeout, rate limit or provider error): ${fallbacks.join(" → ")}.`);
  return { category, primary, fallbacks, basis, sufficiency, explanation, excluded };
}
