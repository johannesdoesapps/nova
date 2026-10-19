"use client";
import { useMemo } from "react";
import type { ModelWithStatus } from "@/lib/ai/types";
import {
  MODEL_TIERS,
  PLAN_IDS,
  chargeUsd,
  modelTier,
  planEconomics,
  planOf,
  priceForBudget,
  resolveBilling,
  typicalRequestUsd,
  type BillingSettings,
  type ModelTier,
  type PlanId,
} from "@/lib/plans";
import { cn } from "@/lib/utils";

const input =
  "h-9 w-full rounded-xl border border-s-line-strong bg-transparent px-2.5 text-[13.5px] tabular-nums text-s-ink outline-none transition focus:border-[color-mix(in_srgb,var(--s-accent)_45%,transparent)]";
const TIER_LABEL: Record<ModelTier, string> = { standard: "Standard", advanced: "Advanced", premium: "Premium" };
const usd = (x: number, d = 2) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d }).format(x);

function Num({ label, value, onChange, step = 1, hint }: { label: string; value: number; onChange: (v: number) => void; step?: number; hint?: string }) {
  return (
    <label className="block text-[12px] text-s-ink-3">
      {label}
      <input
        type="number"
        name={label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}
        autoComplete="off"
        inputMode={Number.isInteger(step) ? "numeric" : "decimal"}
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cn(input, "mt-1")}
      />
      {hint && <span className="mt-0.5 block text-[11px]">{hint}</span>}
    </label>
  );
}

/**
 * Admin → Plans & pricing: prices, allowances, model access, costs and the
 * margin, with a live preview of each plan's economics. Saved with the rest
 * of the platform settings and validated again on the server.
 */
export function PlansEditor({ stored, models, onChange }: { stored: Record<string, unknown> | undefined; models: ModelWithStatus[]; onChange: (b: BillingSettings) => void }) {
  const b = useMemo(() => resolveBilling(stored), [stored]);
  const live = models.filter((m) => m.provider !== "demo" && m.available);
  const setPlan = (id: PlanId, p: Partial<BillingSettings["plans"][PlanId]>) => onChange({ ...b, plans: { ...b.plans, [id]: { ...b.plans[id], ...p } } });
  const set = (p: Partial<BillingSettings>) => onChange({ ...b, ...p });
  const tierOf = (m: ModelWithStatus) => b.modelTiers[m.id] ?? modelTier(m);

  return (
    <section aria-labelledby="plans-h" className="glass rounded-[22px] p-5">
      <h2 id="plans-h" className="text-[15px] font-semibold">
        Plans & pricing
      </h2>
      <p className="mt-1 text-[13px] text-s-ink-3">
        Prices in USD. Each paid plan&rsquo;s monthly AI budget is derived from its price so the target margin holds after fees, hosting and the safety buffer. Changes apply to new requests after you save;
        Stripe prices for a new amount are created on the next checkout.
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {PLAN_IDS.map((id) => {
          const p = b.plans[id];
          const month = planEconomics(b, id, "month");
          const year = planEconomics(b, id, "year");
          const cheap = live.filter((m) => p.tiers.includes(tierOf(m))).map((m) => ({ m, c: typicalRequestUsd(m) })).filter((x) => x.c !== null) as { m: ModelWithStatus; c: number }[];
          cheap.sort((a, z) => a.c - z.c);
          const lo = cheap[0];
          const hi = cheap.at(-1);
          const warn = id !== "free" && month.aiBudgetUsd <= 0;
          return (
            <div key={id} className="rounded-2xl border border-s-line p-4">
              <input aria-label="Plan name" name={`${id}-label`} autoComplete="off" value={p.label} onChange={(e) => setPlan(id, { label: e.target.value })} className={cn(input, "font-semibold")} />
              <div className="mt-3 grid grid-cols-2 gap-2">
                {id !== "free" ? (
                  <>
                    <Num label="Price / month" value={p.priceUsd} step={1} onChange={(v) => setPlan(id, { priceUsd: v })} />
                    <Num label="Yearly discount %" value={p.annualDiscountPct} onChange={(v) => setPlan(id, { annualDiscountPct: v })} hint={`${usd(chargeUsd(planOf(b, id), "year"), 0)} / year`} />
                  </>
                ) : (
                  <Num label="AI budget / month" value={p.aiBudgetUsd ?? 0} step={0.05} onChange={(v) => setPlan(id, { aiBudgetUsd: v })} />
                )}
                <Num label="Units / 5 hours" value={p.windowUnits} onChange={(v) => setPlan(id, { windowUnits: v })} />
                <Num label="Units / week" value={p.weeklyUnits} onChange={(v) => setPlan(id, { weeklyUnits: v })} />
                <Num label="Max reply tokens" value={p.maxOutputTokens} step={100} onChange={(v) => setPlan(id, { maxOutputTokens: v })} />
                <Num label="History characters" value={p.historyChars} step={1000} onChange={(v) => setPlan(id, { historyChars: v })} />
                <Num label="Web searches / month" value={p.webSearchesPerPeriod} onChange={(v) => setPlan(id, { webSearchesPerPeriod: v })} />
              </div>
              <fieldset className="mt-3">
                <legend className="text-[12px] text-s-ink-3">Model tiers included</legend>
                <div className="mt-1 flex flex-wrap gap-3 text-[13px]">
                  {MODEL_TIERS.map((t) => (
                    <label key={t} className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={p.tiers.includes(t)}
                        disabled={id === "free" && t === "standard"}
                        onChange={(e) => setPlan(id, { tiers: e.target.checked ? [...new Set([...p.tiers, t])] : p.tiers.filter((x) => x !== t) })}
                      />
                      {TIER_LABEL[t]}
                    </label>
                  ))}
                </div>
              </fieldset>
              <dl className="mt-3 space-y-0.5 rounded-xl bg-s-hover/50 p-2.5 text-[12px] tabular-nums text-s-ink-2">
                {id !== "free" && (
                  <>
                    <div className="flex justify-between">
                      <dt>Revenue / month</dt>
                      <dd>{usd(month.revenueUsd)}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Fees · hosting · Free share</dt>
                      <dd>
                        {usd(month.feesUsd)} · {usd(month.overheadUsd)}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt>Safety buffer</dt>
                      <dd>{usd(month.bufferUsd)}</dd>
                    </div>
                  </>
                )}
                <div className={cn("flex justify-between font-medium", warn ? "text-s-danger" : "text-s-ink")}>
                  <dt>AI budget / month</dt>
                  <dd>
                    {usd(month.aiBudgetUsd)}
                    {id !== "free" ? ` (yearly ${usd(year.aiBudgetUsd)})` : ""}
                  </dd>
                </div>
                {lo && (
                  <div className="flex justify-between">
                    <dt>≈ requests on {lo.m.displayName}</dt>
                    <dd>{Math.floor(month.aiBudgetUsd / lo.c).toLocaleString("en-US")}</dd>
                  </div>
                )}
                {hi && hi !== lo && (
                  <div className="flex justify-between">
                    <dt>≈ requests on {hi.m.displayName}</dt>
                    <dd>{Math.floor(month.aiBudgetUsd / hi.c).toLocaleString("en-US")}</dd>
                  </div>
                )}
              </dl>
              {warn && (
                <p className="mt-2 text-[12px] text-s-danger">
                  This price leaves no AI budget at a {Math.round(b.targetMargin * 100)}% margin. Raise it to at least {usd(priceForBudget(b, 1) ?? 0)} for a $1 budget.
                </p>
              )}
              {!warn && hi && id !== "free" && month.aiBudgetUsd / hi.c < 50 && (
                <p className="mt-2 text-[12px] text-s-ink-3">
                  Few requests on {hi.m.displayName}. For 100, the price would be about {usd(priceForBudget(b, hi.c * 100) ?? 0)}; or leave the most expensive tier to a higher plan.
                </p>
              )}
            </div>
          );
        })}
      </div>

      <h3 className="mt-5 text-[13.5px] font-semibold">Costs and margin</h3>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Num label="Target margin %" value={Math.round(b.targetMargin * 100)} onChange={(v) => set({ targetMargin: v / 100 })} />
        <Num label="Payment fee %" value={b.paymentFeePercent} step={0.1} onChange={(v) => set({ paymentFeePercent: v })} hint="Card + Stripe Billing" />
        <Num label="Payment fee fixed $" value={b.paymentFeeFixedUsd} step={0.05} onChange={(v) => set({ paymentFeeFixedUsd: v })} />
        <Num label="Safety buffer %" value={b.safetyBufferPct} onChange={(v) => set({ safetyBufferPct: v })} />
        <Num label="Hosting / subscriber $" value={b.overheadPerSubscriberUsd} step={0.1} onChange={(v) => set({ overheadPerSubscriberUsd: v })} />
        <Num label="Free users / subscriber $" value={b.freeSubsidyPerSubscriberUsd} step={0.1} onChange={(v) => set({ freeSubsidyPerSubscriberUsd: v })} />
        <Num label="Web search cost $" value={b.webSearchCostUsd} step={0.001} onChange={(v) => set({ webSearchCostUsd: v })} />
        <Num label="Economy mode from %" value={Math.round(b.premiumBudgetShare * 100)} onChange={(v) => set({ premiumBudgetShare: v / 100 })} hint="of the AI budget" />
      </div>

      <h3 className="mt-5 text-[13.5px] font-semibold">Usage units per message, by tier</h3>
      <div className="mt-2 grid grid-cols-3 gap-2 sm:max-w-md">
        {MODEL_TIERS.map((t) => (
          <Num key={t} label={TIER_LABEL[t]} value={b.tierUnits[t]} onChange={(v) => set({ tierUnits: { ...b.tierUnits, [t]: v } })} />
        ))}
      </div>

      <h3 className="mt-5 text-[13.5px] font-semibold">Model tiers</h3>
      <p className="mt-1 text-[12px] text-s-ink-3">Which plans include each model. Cost per typical request ({"5,000"} input + 960 output tokens) at official prices.</p>
      <ul className="mt-2 divide-y divide-s-line rounded-xl border border-s-line">
        {models
          .filter((m) => m.provider !== "demo")
          .map((m) => {
            const c = typicalRequestUsd(m);
            return (
              <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                <span className={cn("min-w-0 flex-1 truncate", !m.available && "text-s-ink-3")}>
                  {m.displayName}
                  {!m.available && " (not configured)"}
                </span>
                <span className="w-20 text-right tabular-nums text-s-ink-3">{c === null ? "no price" : usd(c, 4)}</span>
                <select
                  aria-label={`Tier for ${m.displayName}`}
                  value={tierOf(m)}
                  onChange={(e) => set({ modelTiers: { ...b.modelTiers, [m.id]: e.target.value as ModelTier } })}
                  className="h-8 rounded-lg border border-s-line-strong bg-s-bg px-2 text-[12.5px] text-s-ink"
                >
                  {MODEL_TIERS.map((t) => (
                    <option key={t} value={t}>
                      {TIER_LABEL[t]}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
      </ul>
    </section>
  );
}
