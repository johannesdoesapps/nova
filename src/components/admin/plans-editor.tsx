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
  type BillingSettings,
  type ModelTier,
  type PlanId,
} from "@/lib/plans";
import { MESSAGES_PER_DAY, messageCostUsd, modelCostTable } from "@/lib/billing/scenarios";
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
          const cheap = live.filter((m) => p.tiers.includes(tierOf(m))).map((m) => ({ m: { ...m, tier: tierOf(m) }, c: messageCostUsd({ ...m, tier: tierOf(m) }, b.scenario) })).filter((x) => x.c !== null) as { m: ModelWithStatus; c: number }[];
          cheap.sort((a, z) => a.c - z.c);
          const lo = cheap[0];
          const hi = cheap.at(-1);
          const warn = id !== "free" && month.aiBudgetUsd <= 0;
          const hiBudget = hi && tierOf(hi.m) !== "standard" ? Math.min(month.aiBudgetUsd, month.premiumBudgetUsd) : month.aiBudgetUsd;
          return (
            <div key={id} className="s-card rounded-2xl p-4">
              <input aria-label="Plan name" name={`${id}-label`} autoComplete="off" value={p.label} onChange={(e) => setPlan(id, { label: e.target.value })} className={cn(input, "font-semibold")} />
              <div className="mt-3 grid grid-cols-2 gap-2">
                {id !== "free" ? (
                  <>
                    <Num label="Price / month" value={p.priceUsd} step={1} onChange={(v) => setPlan(id, { priceUsd: v })} />
                    <Num label="Yearly discount %" value={p.annualDiscountPct} onChange={(v) => setPlan(id, { annualDiscountPct: v })} hint={`${usd(chargeUsd(planOf(b, id), "year"), 0)} / year`} />
                    <Num label="Minimum AI budget / month" value={p.minAiBudgetUsd} step={0.5} onChange={(v) => setPlan(id, { minAiBudgetUsd: v })} hint="0 = from the margin target" />
                  </>
                ) : (
                  <Num label="AI budget / month" value={p.aiBudgetUsd ?? 0} step={0.05} onChange={(v) => setPlan(id, { aiBudgetUsd: v })} />
                )}
                <Num label="Units / 5 hours" value={p.windowUnits} onChange={(v) => setPlan(id, { windowUnits: v })} />
                <Num label="Units / week" value={p.weeklyUnits} onChange={(v) => setPlan(id, { weeklyUnits: v })} />
                <Num label="Premium units / week" value={p.topWeeklyUnits} onChange={(v) => setPlan(id, { topWeeklyUnits: v })} hint="0 = no separate limit" />
                <Num label="Max reply tokens" value={p.maxOutputTokens} step={100} onChange={(v) => setPlan(id, { maxOutputTokens: v })} />
                <Num label="History characters" value={p.historyChars} step={1000} onChange={(v) => setPlan(id, { historyChars: v })} />
                <Num label="Web searches / month" value={p.webSearchesPerPeriod} onChange={(v) => setPlan(id, { webSearchesPerPeriod: v })} />
                <Num label="Code runs / month" value={p.codeRunsPerPeriod} onChange={(v) => setPlan(id, { codeRunsPerPeriod: v })} hint="Run button; 0 = off" />
                <Num label="Workspace minutes / month" value={p.workspaceMinutesPerPeriod} step={10} onChange={(v) => setPlan(id, { workspaceMinutesPerPeriod: v })} hint="Code page computer time; 0 = off" />
                <Num label="Code projects" value={p.codeProjects} onChange={(v) => setPlan(id, { codeProjects: v })} />
                <Num label="Advanced-model share %" value={p.premiumBudgetPct} onChange={(v) => setPlan(id, { premiumBudgetPct: v })} hint="of the AI budget" />
                <Num label="Messages / day (0 = no cap)" value={p.dailyMessages} onChange={(v) => setPlan(id, { dailyMessages: v })} />
                <Num label="Tokens / month (0 = no cap)" value={p.monthlyTokens} step={100000} onChange={(v) => setPlan(id, { monthlyTokens: v })} />
                <Num label="Daily share of budget % (0 = none)" value={p.dailyBudgetPct} onChange={(v) => setPlan(id, { dailyBudgetPct: v })} />
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
                      <dt>Revenue / month (ex. tax, refunds)</dt>
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
                {month.premiumBudgetUsd > 0 && (
                  <div className="flex justify-between">
                    <dt>… of which advanced models</dt>
                    <dd>{usd(month.premiumBudgetUsd)}</dd>
                  </div>
                )}
                {id !== "free" && (
                  <div className="flex justify-between">
                    <dt>Contribution if fully used</dt>
                    <dd>
                      {usd(month.contributionUsd)} ({Math.round((month.contributionUsd / Math.max(month.revenueUsd, 0.01)) * 100)}%)
                    </dd>
                  </div>
                )}
                {lo && (
                  <div className="flex justify-between">
                    <dt>≈ messages / month on {lo.m.displayName}</dt>
                    <dd>{Math.floor(month.aiBudgetUsd / lo.c).toLocaleString("en-US")}</dd>
                  </div>
                )}
                {hi && hi !== lo && (
                  <div className="flex justify-between">
                    <dt>≈ messages / month on {hi.m.displayName}</dt>
                    <dd>{Math.floor(hiBudget / hi.c).toLocaleString("en-US")}</dd>
                  </div>
                )}
              </dl>
              {warn && (
                <p className="mt-2 text-[12px] text-s-danger">
                  This price leaves no AI budget at a {Math.round(b.targetMargin * 100)}% margin. Raise it to at least {usd(priceForBudget(b, 1, p) ?? 0)} for a $1 budget.
                </p>
              )}
              {!warn && hi && id !== "free" && hiBudget / hi.c < 50 && (
                <p className="mt-2 text-[12px] text-s-ink-3">
                  Few messages on {hi.m.displayName}. Raise the advanced-model share or the price (about {usd(priceForBudget(b, (hi.c * 100) / Math.max(p.premiumBudgetPct / 100, 0.01), p) ?? 0)} for 100), or leave this tier to a higher plan.
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
        <Num label="Tax included in prices %" value={b.taxIncludedPct} step={0.5} onChange={(v) => set({ taxIncludedPct: v })} hint="0 = tax added at checkout" />
        <Num label="Refunds %" value={b.refundRatePct} step={0.5} onChange={(v) => set({ refundRatePct: v })} hint="of revenue" />
        <Num label="Fixed overhead / month $" value={b.fixedOverheadMonthlyUsd} step={10} onChange={(v) => set({ fixedOverheadMonthlyUsd: v })} hint="shown apart from contribution" />
      </div>

      <h3 className="mt-5 text-[13.5px] font-semibold">Spending protection</h3>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Num label="Max cost of one request $" value={b.maxRequestCostUsd} step={0.1} onChange={(v) => set({ maxRequestCostUsd: v })} hint="0 = no cap" />
        <Num label="Site-wide monthly cap $" value={b.siteMonthlyCapUsd} step={10} onChange={(v) => set({ siteMonthlyCapUsd: v })} hint="0 = none; stops new requests" />
        <Num label="Extra usage pack: units" value={b.creditPackUnits} step={50} onChange={(v) => set({ creditPackUnits: v })} hint="0 = not on sale" />
        <Num label="Extra usage pack: price $" value={b.creditPackPriceUsd} step={1} onChange={(v) => set({ creditPackPriceUsd: v })} hint="Pro and Max can buy it once Stripe is set up" />
        <Num label="Code runs / month, whole site" value={b.codeRunsSiteMonthly} step={100} onChange={(v) => set({ codeRunsSiteMonthly: v })} hint="0 = none; Vercel Hobby allows 5,000 sandboxes" />
        <Num label="Code run time limit (s)" value={b.codeRunSeconds} onChange={(v) => set({ codeRunSeconds: v })} hint="5–120; sets each plan's worst-case run cost" />
        <Num label="Workspace minutes / month, whole site" value={b.workspaceSiteMonthlyMinutes} step={100} onChange={(v) => set({ workspaceSiteMonthlyMinutes: v })} hint="0 = none" />
        <Num label="Workspace block (minutes)" value={b.workspaceBlockMinutes} onChange={(v) => set({ workspaceBlockMinutes: v })} hint="5–40; time is started and counted in blocks" />
        <Num label="Workspaces running at once, whole site" value={b.workspaceSiteConcurrent} onChange={(v) => set({ workspaceSiteConcurrent: v })} hint="0 = none; Vercel Hobby allows 10 sandboxes at a time" />
      </div>
      <label className="mt-3 flex items-start gap-2 text-[13px]">
        <input type="checkbox" checked={b.aiPaused} onChange={(e) => set({ aiPaused: e.target.checked })} className="mt-0.5" />
        <span>
          <span className="font-medium">Emergency stop</span>
          <span className="block text-[12px] text-s-ink-3">Pause all new AI requests for everyone except administrators. Users see that AI is paused for a moment.</span>
        </span>
      </label>
      <label className="mt-2 flex items-start gap-2 text-[13px]">
        <input type="checkbox" checked={b.premiumPaused} onChange={(e) => set({ premiumPaused: e.target.checked })} className="mt-0.5" />
        <span>
          <span className="font-medium">Premium models off</span>
          <span className="block text-[12px] text-s-ink-3">Turn off the most expensive models for everyone except administrators; other models keep working.</span>
        </span>
      </label>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Num label="Grace days after a failed payment" value={b.paymentGraceDays} onChange={(v) => set({ paymentGraceDays: v })} hint="0–30; the plan keeps working while Stripe retries the card" />
      </div>

      <h3 className="mt-5 text-[13.5px] font-semibold">Usage units per message, by tier</h3>
      <div className="mt-2 grid grid-cols-3 gap-2 sm:max-w-md">
        {MODEL_TIERS.map((t) => (
          <Num key={t} label={TIER_LABEL[t]} value={b.tierUnits[t]} onChange={(v) => set({ tierUnits: { ...b.tierUnits, [t]: v } })} />
        ))}
      </div>

      <h3 className="mt-5 text-[13.5px] font-semibold">Usage calculator</h3>
      <p className="mt-1 text-[12px] text-s-ink-3">
        Cost of a user message on each model from verified prices. One message can make several model calls (agents, Council, retries). After launch, compare with the real averages in Finance.
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Num label="Input tokens / call" value={b.scenario.inputTokens} step={100} onChange={(v) => set({ scenario: { ...b.scenario, inputTokens: v } })} />
        <Num label="Output tokens / call" value={b.scenario.outputTokens} step={100} onChange={(v) => set({ scenario: { ...b.scenario, outputTokens: v } })} />
        <Num label="Model calls / message" value={b.scenario.callsPerMessage} step={0.05} onChange={(v) => set({ scenario: { ...b.scenario, callsPerMessage: v } })} />
        <Num label="Cached input %" value={b.scenario.cachedInputPct} onChange={(v) => set({ scenario: { ...b.scenario, cachedInputPct: v } })} />
      </div>
      <div tabIndex={0} role="region" aria-label="Plans table" className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[12.5px] tabular-nums">
          <thead className="text-[11.5px] text-s-ink-3">
            <tr>
              <th className="py-1.5 pr-2 font-medium">Model</th>
              <th className="py-1.5 pr-2 font-medium">Per message</th>
              <th className="py-1.5 pr-2 font-medium">Per 1,000</th>
              {MESSAGES_PER_DAY.map((d) => (
                <th key={d} className="py-1.5 pr-2 font-medium">
                  {d}/day · month
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modelCostTable(
              live.map((m) => ({ ...m, tier: tierOf(m) })),
              b.scenario,
            ).map((r) => (
              <tr key={r.id} className="border-t border-s-line">
                <td className="py-1.5 pr-2">
                  {r.name} <span className="text-s-ink-3">· {TIER_LABEL[r.tier as ModelTier]}</span>
                </td>
                <td className="py-1.5 pr-2">{usd(r.perMessageUsd, 5)}</td>
                <td className="py-1.5 pr-2">{usd(r.per1000Usd)}</td>
                {r.byVolume.map((v) => (
                  <td key={v.perDay} className="py-1.5 pr-2">
                    {usd(v.monthlyUsd)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-5 text-[13.5px] font-semibold">Model tiers</h3>
      <p className="mt-1 text-[12px] text-s-ink-3">Which plans include each model. Cost per message with the calculator&rsquo;s assumptions, at official prices.</p>
      <ul className="mt-2 divide-y divide-s-line rounded-xl border border-s-line">
        {models
          .filter((m) => m.provider !== "demo")
          .map((m) => {
            const c = messageCostUsd({ ...m, tier: tierOf(m) }, b.scenario);
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
