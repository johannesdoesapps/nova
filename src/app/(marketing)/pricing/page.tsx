import { CtaBand } from "@/components/marketing/parts";
import { PricingPlans, type PricingPlan } from "@/components/marketing/pricing-plans";
import { getModels } from "@/lib/ai";
import { getPlatformSettings } from "@/lib/ai/settings";
import { getAuth } from "@/lib/auth";
import { billingConfigured } from "@/lib/billing/stripe";
import { entitlementFor } from "@/lib/entitlements";
import { planCapacity } from "@/lib/billing/scenarios";
import { DEFAULT_BILLING, PLAN_IDS, chargeUsd, modelTier, planOf, resolveBilling, type ModelTier } from "@/lib/plans";
import { pageMetadata } from "@/lib/seo";

export const dynamic = "force-dynamic";

const d = DEFAULT_BILLING.plans;
export const metadata = pageMetadata({
  title: "Pricing",
  description: `Orbis is free to start. Pro is $${d.pro.priceUsd} and Max $${d.max.priceUsd} per month (USD), with more usage and access to larger Claude and GPT models.`,
  path: "/pricing",
});

const BLURBS: Record<PricingPlan["id"], string> = {
  free: "Try Orbis with the fastest, lowest-cost models.",
  pro: "For everyday work, with larger Claude and GPT models.",
  max: "For heavy use, with the most capable models and longer replies.",
};

export default async function PricingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const highlight = (["free", "pro", "max"] as const).find((id) => id === sp.plan) ?? null;
  const initialInterval = sp.interval === "year" || sp.interval === "month" ? sp.interval : null;
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
    // What the plan's monthly AI allowance buys, at the planning assumptions (an estimate, shown as "about").
    const cap = planCapacity(billing, id, live);
    const cheapest = cap.models[0];
    const advanced = cap.models.filter((m) => m.tier !== "standard");
    const roundDown = (n: number) => (n >= 1000 ? Math.floor(n / 100) * 100 : n >= 100 ? Math.floor(n / 10) * 10 : n);
    return {
      id,
      label: p.label,
      blurb: BLURBS[id],
      monthlyUsd: p.priceUsd,
      annualUsd: chargeUsd(p, "year"),
      annualDiscountPct: p.priceUsd > 0 ? p.annualDiscountPct : 0,
      features: [
        prev ? `About ${Math.round(p.weeklyUnits / prev.weeklyUnits)}× the ${prev.label} allowance` : null,
        cheapest ? `Up to about ${roundDown(cheapest.perMonth).toLocaleString("en-US")} messages a month with ${cheapest.name}` : null,
        advanced.length ? `About ${roundDown(advanced.at(-1)!.perMonth).toLocaleString("en-US")}–${roundDown(advanced[0]!.perMonth).toLocaleString("en-US")} messages a month with advanced models` : null,
        p.dailyMessages > 0 ? `${p.dailyMessages} messages a day` : null,
        `${p.windowUnits.toLocaleString("en-US")} usage units per 5-hour window, ${p.weeklyUnits.toLocaleString("en-US")} per week`,
        names.length ? `Models: ${names.join(", ")}` : "Auto (the lowest-cost available model)",
        `Replies up to about ${Math.round((p.maxOutputTokens * 0.75) / 50) * 50} words`,
        p.webSearchesPerPeriod > 0 ? `${p.webSearchesPerPeriod} web searches per month (when search is enabled)` : null,
        p.codeRunsPerPeriod > 0 ? `Run code in chat: ${p.codeRunsPerPeriod.toLocaleString("en-US")} runs a month (Python, JavaScript, TypeScript, Bash)` : null,
        p.workspaceMinutesPerPeriod > 0
          ? `Code workspace: ${p.codeProjects.toLocaleString("en-US")} project${p.codeProjects === 1 ? "" : "s"}, ${p.workspaceMinutesPerPeriod.toLocaleString("en-US")} computer minutes a month, AI file editing and live preview`
          : null,
        "Assistant, agents, Council, Arena and Mission Control",
        id === "free" ? "No credit card needed" : "Cancel or change plan any time",
      ].filter((x): x is string => !!x),
    };
  });

  const current = entitlement ? { plan: entitlement.plan, interval: entitlement.interval } : null;
  const tu = billing.tierUnits;
  const P = Object.fromEntries(PLAN_IDS.map((id) => [id, planOf(billing, id)])) as Record<(typeof PLAN_IDS)[number], ReturnType<typeof planOf>>;
  const fmt = (n: number) => n.toLocaleString("en-US");
  const words = (tokens: number) => `about ${fmt(Math.round((tokens * 0.75) / 50) * 50)} words`;
  const tierNames: Record<ModelTier, string> = { standard: "fast", advanced: "advanced", premium: "premium" };
  const ROWS: { label: string; cells: (id: (typeof PLAN_IDS)[number]) => string }[] = [
    { label: "Price", cells: (id) => (P[id].priceUsd === 0 ? "Free" : `$${fmt(P[id].priceUsd)}/month or $${fmt(chargeUsd(P[id], "year"))}/year`) },
    { label: "Usage per 5 hours", cells: (id) => `${fmt(P[id].windowUnits)} units` },
    { label: "Usage per week", cells: (id) => `${fmt(P[id].weeklyUnits)} units` },
    { label: "Messages per day", cells: (id) => (P[id].dailyMessages > 0 ? fmt(P[id].dailyMessages) : "No daily cap") },
    { label: "Models", cells: (id) => P[id].tiers.map((t) => tierNames[t]).join(", ") },
    { label: "Longest reply", cells: (id) => words(P[id].maxOutputTokens) },
    { label: "Run code in chat", cells: (id) => `${fmt(P[id].codeRunsPerPeriod)} runs/month` },
    { label: "Code projects", cells: (id) => fmt(P[id].codeProjects) },
    { label: "Workspace computer", cells: (id) => `${fmt(P[id].workspaceMinutesPerPeriod)} min/month` },
    { label: "Coding agent", cells: () => "Included (each step counts as a message)" },
    { label: "Web searches", cells: (id) => (P[id].webSearchesPerPeriod > 0 ? `${fmt(P[id].webSearchesPerPeriod)}/month, once search is enabled` : "Not included") },
    { label: "Agents, Council, Arena, Mission Control, Connectors", cells: () => "Included" },
  ];
  return (
    <>
      <section className="mx-auto max-w-5xl px-5 pt-16 pb-6 text-center sm:px-8 sm:pt-20">
        <h1 className="text-balance font-serif text-[44px] leading-[1.05] tracking-[-0.01em] text-fg sm:text-[56px]">Pricing</h1>
        <p className="mx-auto mt-5 max-w-2xl text-[17px] leading-relaxed text-muted">
          Start free. Upgrade for more usage and larger models. Prices in US dollars, plus tax where it applies. No plan is unlimited.
        </p>
      </section>

      <section aria-labelledby="plans" className="mx-auto max-w-6xl px-5 py-10 sm:px-8">
        <h2 id="plans" className="sr-only">Plans</h2>
        <PricingPlans plans={plans} onSale={onSale} current={current} signedIn={auth.mode === "authenticated"} highlight={highlight} initialInterval={initialInterval} />
        <p className="mx-auto mt-6 max-w-3xl text-center text-[13px] leading-relaxed text-muted">
          Each plan includes a monthly AI allowance, with a part reserved for advanced models. Message counts are estimates for a typical message (about{" "}
          {Math.round((billing.scenario.inputTokens * 0.75) / 100) * 100} words of context and a {Math.round((billing.scenario.outputTokens * 0.75) / 50) * 50}-word reply); longer
          conversations use more. When the advanced-model part is used, Auto and the fast models keep working; when the whole
          allowance is used, Orbis pauses until your billing month renews. Upgrades are charged pro-rata right away; downgrades are credited to your next invoice.
        </p>
      </section>

      <section aria-labelledby="compare" className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <h2 id="compare" className="text-2xl font-medium text-fg">Compare plans</h2>
        <p className="mt-2 text-[15px] text-muted">Read from the same settings Orbis uses to enforce limits, so this table always matches what you get.</p>
        <div className="s-scroll mt-6 overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[640px] border-collapse text-left text-[14px]">
            <caption className="sr-only">What each plan includes</caption>
            <thead>
              <tr className="border-b border-border bg-panel">
                <th scope="col" className="w-[28%] px-4 py-3 font-medium text-muted">
                  <span className="sr-only">Feature</span>
                </th>
                {PLAN_IDS.map((id) => (
                  <th key={id} scope="col" className="px-4 py-3 font-medium text-fg">
                    {P[id].label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.label} className="border-b border-border last:border-0">
                  <th scope="row" className="px-4 py-3 align-top font-normal text-muted">
                    {r.label}
                  </th>
                  {PLAN_IDS.map((id) => (
                    <td key={id} className="px-4 py-3 align-top text-fg">
                      {r.cells(id)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
          <p>Orbis Council and Orbis Arena ask several models at once, so each model&rsquo;s reply counts. Your current usage and reset times are always shown in the app.</p>
        </div>

        <h3 className="mt-10 text-lg font-medium text-fg">What different tasks use</h3>
        <p className="mt-2 text-[14px] text-muted">Examples, not guarantees: real use depends on the models you pick and how long your conversations get.</p>
        <dl className="mt-5 divide-y divide-border rounded-2xl border border-border bg-panel text-[15px]">
          {[
            ["A quick question to a fast model", `${tu.standard} unit.`],
            ["The same question to an advanced or premium model", `${tu.advanced} or ${tu.premium} units.`],
            ["A long conversation, or one with big attachments", "The same units per message, but more of your monthly AI allowance, because more text is sent with each message."],
            ["A Council with three models", "One message per model's answer, plus the chair model's summary (and the models' reviews of each other in Deep mode)."],
            ["A coding agent run", "One message per step the agent takes (a small bug fix is typically a handful of steps), plus workspace computer time, counted in 10-minute blocks."],
            ["Running code from a chat reply", "One code run from your monthly runs. It uses no usage units."],
          ].map(([k, v]) => (
            <div key={k} className="grid gap-1 px-5 py-4 sm:grid-cols-[1fr_1.4fr] sm:gap-6">
              <dt className="text-fg">{k}</dt>
              <dd className="text-muted">{v}</dd>
            </div>
          ))}
        </dl>

        <h3 className="mt-10 text-lg font-medium text-fg">When you reach a limit</h3>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[15px] leading-relaxed text-muted marker:text-muted">
          <li>Orbis tells you which limit you reached and when it resets. The 5-hour window and the weekly allowance reset on their own.</li>
          <li>If the advanced-model part of your monthly allowance runs out, Auto and the fast models keep working.</li>
          <li>Nothing is charged automatically and your plan never changes without you. You can cancel or switch plans at any time from your account.</li>
        </ul>
      </section>
      <CtaBand />
    </>
  );
}
