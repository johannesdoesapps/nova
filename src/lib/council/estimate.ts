/**
 * Before a multi-model run: how many model calls it makes, the allowance
 * units they use (the same per-model units the server charges), and a
 * worst-case dollar cost from published prices (input estimated from the
 * text sent, output at each call's maximum). Unknown prices are reported as
 * unknown, never guessed.
 */

export interface EstimateModel {
  id: string;
  displayName: string;
  inputPrice: number | null;
  outputPrice: number | null;
  units?: number;
}

export interface PlannedCall {
  model: EstimateModel;
  /** Characters sent (question, answers being compared, instructions). */
  inputChars: number;
  maxOutputTokens: number;
}

export interface Estimate {
  calls: number;
  /** Allowance units; null when a model's units aren't known. */
  units: number | null;
  /** Upper bound in USD; null when any model has no published price. */
  maxUsd: number | null;
  /** Models without a published price. */
  unpriced: string[];
}

/** Rough token count (about four characters a token), plus the fixed instructions each call carries. */
export const inputTokens = (chars: number) => Math.ceil(chars / 4) + 400;

export function estimate(calls: PlannedCall[]): Estimate {
  let units: number | null = 0;
  let usd: number | null = 0;
  const unpriced = new Set<string>();
  for (const c of calls) {
    units = units === null || c.model.units === undefined ? null : units + c.model.units;
    if (c.model.inputPrice === null || c.model.outputPrice === null) {
      unpriced.add(c.model.displayName);
      usd = null;
    } else if (usd !== null) usd += (inputTokens(c.inputChars) * c.model.inputPrice + c.maxOutputTokens * c.model.outputPrice) / 1_000_000;
  }
  return { calls: calls.length, units, maxUsd: usd === null ? null : Math.round(usd * 10_000) / 10_000, unpriced: [...unpriced] };
}

/** "3 model calls · 6 units · up to ≈ $0.04", plainly when something is unknown. */
export function describeEstimate(e: Estimate): string {
  const parts = [`${e.calls} model call${e.calls === 1 ? "" : "s"}`];
  if (e.units !== null) parts.push(`${e.units} unit${e.units === 1 ? "" : "s"} of your allowance`);
  if (e.maxUsd !== null) parts.push(`up to ≈ ${e.maxUsd < 0.01 ? "<$0.01" : `$${e.maxUsd.toFixed(2)}`} at list prices`);
  else if (e.unpriced.length) parts.push(`no published price for ${e.unpriced.join(", ")}`);
  return parts.join(" · ");
}

/** Output caps of the steps (kept in step with the API routes). */
export const MAX_OUTPUT = { answer: 2400, critique: 3000, improve: 2400, synthesize: 3000 } as const;
