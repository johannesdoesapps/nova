import { describeEstimate, estimate, type EstimateModel } from "../council/estimate";
import type { Template } from "./registry";
import { stepInputChars } from "./registry";

/**
 * What a template run uses, before it starts: one model call per step, at the
 * chosen model's units and published prices. With Auto the model is picked per
 * step, so the range across the models Auto may use is shown.
 */
export function templateEstimate(
  t: Template,
  models: (EstimateModel & { available?: boolean; locked?: boolean })[],
  modelId: string,
  inputs: Record<string, string>,
  overrides: Record<string, string> = {},
  isAuto = false,
): { text: string; calls: number; searches: number } | null {
  const steps = t.steps ?? [];
  if (!steps.length) return null;
  const searches = steps.filter((s) => s.web).length;
  const plan = (m: EstimateModel) => steps.map((s) => ({ model: m, inputChars: stepInputChars(t, s, inputs, overrides[s.id]) + 1500, maxOutputTokens: s.maxOutputTokens }));
  const search = searches ? ` · ${searches} web search${searches === 1 ? "" : "es"} when available` : "";
  if (!isAuto) {
    const m = models.find((x) => x.id === modelId);
    if (!m) return null;
    return { text: describeEstimate(estimate(plan(m))) + search, calls: steps.length, searches };
  }
  const usable = models.filter((m) => m.available !== false && !m.locked && m.units !== undefined);
  if (!usable.length) return { text: `${steps.length} model call${steps.length === 1 ? "" : "s"} (Auto picks the model for each)${search}`, calls: steps.length, searches };
  const runs = usable.map((m) => estimate(plan(m)));
  const lo = Math.min(...runs.map((r) => r.units ?? Infinity));
  const hi = Math.max(...runs.map((r) => r.units ?? 0));
  const priced = runs.filter((r) => r.maxUsd !== null).map((r) => r.maxUsd!);
  const usd = priced.length ? ` · up to ≈ ${fmt(Math.max(...priced))} at list prices` : "";
  const units = Number.isFinite(lo) ? ` · ${lo === hi ? lo : `${lo}–${hi}`} units of your allowance` : "";
  return { text: `${steps.length} model call${steps.length === 1 ? "" : "s"} (Auto picks the model for each)${units}${usd}${search}`, calls: steps.length, searches };
}

const fmt = (usd: number) => (usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`);
