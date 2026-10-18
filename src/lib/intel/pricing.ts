import type { ModelInfo } from "../ai/types";

/**
 * Pricing validation. NOVARA never scrapes prices from marketing pages at
 * runtime. Prices enter through the registry (DB or NOVARA_MODELS) with a
 * source URL and verification date, and are checked here before use.
 */

export const PRICE_STALE_DAYS = 45;
/** Sanity bounds, USD per 1M tokens. Outside these, a typo (e.g. per-1K entered as per-1M) is likely. */
export const PRICE_BOUNDS = { min: 0.001, max: 500 };

export type PriceIssueLevel = "error" | "warning" | "info";
export interface PriceIssue {
  level: PriceIssueLevel;
  message: string;
}

export interface PriceValidation {
  modelId: string;
  status: "verified" | "stale" | "unverified" | "invalid" | "simulated";
  issues: PriceIssue[];
}

export function validatePrice(m: Pick<ModelInfo, "id" | "provider" | "inputPrice" | "outputPrice" | "lastVerifiedAt"> & { priceSourceUrl?: string | null }, now: string): PriceValidation {
  const issues: PriceIssue[] = [];
  if (m.provider === "demo") return { modelId: m.id, status: "simulated", issues: [{ level: "info", message: "Simulated model — no cost." }] };
  if (m.inputPrice === null || m.outputPrice === null) {
    return { modelId: m.id, status: "unverified", issues: [{ level: "warning", message: "No verified price. Costs show as n/a and price-limited routes exclude this model." }] };
  }
  for (const [label, v] of [["input", m.inputPrice], ["output", m.outputPrice]] as const) {
    if (v !== 0 && (v < PRICE_BOUNDS.min || v > PRICE_BOUNDS.max)) issues.push({ level: "error", message: `${label} price $${v}/1M is outside the sanity range $${PRICE_BOUNDS.min}–$${PRICE_BOUNDS.max}. Check units (per 1M tokens).` });
  }
  if (m.outputPrice < m.inputPrice) issues.push({ level: "warning", message: "Output price is lower than input price — unusual; double-check the figures." });
  if (!m.priceSourceUrl) issues.push({ level: "warning", message: "No source URL recorded for this price." });
  let status: PriceValidation["status"] = issues.some((i) => i.level === "error") ? "invalid" : "verified";
  if (!m.lastVerifiedAt) {
    issues.push({ level: "warning", message: "No verification date recorded." });
    if (status === "verified") status = "unverified";
  } else {
    const age = (new Date(now).getTime() - new Date(m.lastVerifiedAt).getTime()) / 86_400_000;
    if (age > PRICE_STALE_DAYS) {
      issues.push({ level: "warning", message: `Last verified ${Math.floor(age)} days ago (re-check every ${PRICE_STALE_DAYS} days).` });
      if (status === "verified") status = "stale";
    }
  }
  return { modelId: m.id, status, issues };
}

/** Flag large price changes between two registry snapshots so they get a human look before taking effect. */
export function priceChangeNeedsReview(oldPrice: number | null, newPrice: number | null, threshold = 0.5): boolean {
  if (oldPrice === null || newPrice === null || oldPrice === 0) return false;
  return Math.abs(newPrice - oldPrice) / oldPrice > threshold;
}

export interface Reconciliation {
  estimatedUsd: number;
  billedUsd: number;
  differencePct: number;
  verdict: "match" | "investigate";
}

/** Compare NOVARA's token-based estimate with a provider billing export for the same period. */
export function reconcile(estimatedUsd: number, billedUsd: number, tolerancePct = 5): Reconciliation {
  const differencePct = billedUsd === 0 ? (estimatedUsd === 0 ? 0 : 100) : ((estimatedUsd - billedUsd) / billedUsd) * 100;
  return { estimatedUsd, billedUsd, differencePct: Math.round(differencePct * 10) / 10, verdict: Math.abs(differencePct) <= tolerancePct ? "match" : "investigate" };
}
