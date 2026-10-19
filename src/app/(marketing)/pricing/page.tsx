import { CtaBand } from "@/components/marketing/parts";
import { PricingPlans, type PricingPlan } from "@/components/marketing/pricing-plans";
import { getModels } from "@/lib/ai";
import { getPlatformSettings } from "@/lib/ai/settings";
import { getAuth } from "@/lib/auth";
import { billingConfigured } from "@/lib/billing/stripe";
import { entitlementFor } from "@/lib/entitlements";
import { DEFAULT_BILLING, PLAN_IDS, chargeUsd, modelTier, planOf, resolveBilling, type ModelTier } from "@/lib/plans";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

const d = DEFAULT_BILLING.plans;
export const metadata = pageMetadata({
  title: "Pricing",
  description: `NOVA is free to start. Pro is $${d.pro.priceUsd} and Max $${d.max.priceUsd} per month (USD), with more usage and access to larger Claude and GPT models.`,
  path: "/pricing",
});

const BLURBS: Record<PricingPlan["id"], string> = {
  free: "Try NOVA with the fastest, lowest-cost models.",
  pro: "For everyday work, with larger Claude and GPT models.",
  max: "For heavy use, with the most capable models and longer replies.",
};

export default async function PricingPage() {
  const onSale = billingConfigured();
  const settings = await getPlatformSettings();
  const billing = resolveBilling(settings.billing);
  const [models, auth] = await Promise.all([getModels(settings), getAuth()]);
  const entitlement = await entitlementFor(auth);
  const live = models.filter((m) => m.available && m.provider !== "demo");
  const namesFor = (tiers: ModelTier[]) => live.filter((m) => tiers.includes(modelTier(m))).map((m) => m.displayName);

  const plans: PricingPlan[] = PLAN_IDS.map((id) => {
    const p = planOf(billing, id);
    const names = namesFor(p.tiers);
    const prev = id === "max" ? planOf(billing, "pro") : id === "pro" ? planOf(billing, "free") : null;
    return {
      id,
      label: p.label,
      blurb: BLURBS[id],
      monthlyUsd: p.priceUsd,
      annualUsd: chargeUsd(p, "year"),
      annualDiscountPct: p.priceUsd > 0 ? p.annualDiscountPct : 0,
      features: [
        prev ? `About ${Math.round(p.weeklyUnits / prev.weeklyUnits)}× the ${prev.label} allowance` : null,
        `${p.windowUnits.toLocaleString("en-US")} usage units per 5-hour window, ${p.weeklyUnits.toLocaleString("en-US")} per week`,
        names.length ? `Models: ${names.join(", ")}` : "Auto (the lowest-cost available model)",
        `Replies up to about ${Math.round((p.maxOutputTokens * 0.75) / 50) * 50} words`,
        p.webSearchesPerPeriod > 0 ? `${p.webSearchesPerPeriod} web searches per month (when search is enabled)` : null,
        "Assistant, agents, Council, Arena and Mission Control",
        id === "free" ? "No credit card needed" : "Cancel or change plan any time",
      ].filter((x): x is string => !!x),
    };
  });

  const current = entitlement ? { plan: entitlement.plan, interval: entitlement.interval } : null;
  const tu = billing.tierUnits;
  return (
    <>
      <section className="mx-auto max-w-5xl px-5 pt-16 pb-6 text-center sm:px-8 sm:pt-20">
        <h1 className="text-balance font-serif text-[44px] leading-[1.05] tracking-[-0.01em] text-fg sm:text-[56px]">Pricing</h1>
        <p className="mx-auto mt-5 max-w-2xl text-[17px] leading-relaxed text-muted">
          Start free. Upgrade for more usage and larger models. Prices in US dollars; no plan is unlimited.
        </p>
      </section>

      <section aria-labelledby="plans" className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
        <h2 id="plans" className="sr-only">Plans</h2>
        <PricingPlans plans={plans} onSale={onSale} current={current} signedIn={auth.mode === "authenticated"} />
        <p className="mx-auto mt-6 max-w-3xl text-center text-[13px] leading-relaxed text-muted">
          Fair use: each plan includes a monthly AI budget. If heavy use of larger models uses most of it, NOVA continues on the plan&rsquo;s lowest-cost model, and
          pauses when the budget is used, until your billing month renews. Upgrades are charged pro-rata right away; downgrades are credited to your next invoice.
        </p>
      </section>

      <section aria-labelledby="units" className="mx-auto max-w-3xl px-5 py-14 sm:px-8">
        <h2 id="units" className="text-2xl font-medium text-fg">How usage units work</h2>
        <div className="mt-5 space-y-4 text-[15px] leading-relaxed text-muted">
          <p>
            A message to a fast, low-cost model (such as Claude Haiku 5.5 or GPT-5.6 Luna) uses {tu.standard} unit. Larger models cost more to run: a message to an advanced model uses{" "}
            {tu.advanced} units and to a premium model {tu.premium}.
          </p>
          <p>
            Your 5-hour window starts with your first message and resets five hours later. The weekly limit counts the last seven days. Auto always uses the lowest-cost model your
            plan includes; a model you pick yourself is kept until you change it.
          </p>
          <p>Nova Council and Nova Arena ask several models at once, so each model&rsquo;s reply counts. Your current usage and reset times are always shown in the app.</p>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
