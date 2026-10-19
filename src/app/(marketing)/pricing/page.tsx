import { Check } from "lucide-react";
import { CtaBand, PrimaryCta, StatusBadge } from "@/components/marketing/parts";
import { PRICING } from "@/content/site";
import { LARGE_MODEL_UNITS } from "@/lib/plans";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Pricing",
  description: `NOVA is free to start: ${PRICING.free.window} usage units per 5-hour window and ${PRICING.free.weekly} per week. How usage units work, and what's coming in the Pro plan.`,
  path: "/pricing",
});

export default function PricingPage() {
  return (
    <>
      <section className="mx-auto max-w-5xl px-5 pt-16 pb-6 text-center sm:px-8 sm:pt-20">
        <h1 className="text-balance font-serif text-[44px] leading-[1.05] tracking-[-0.01em] text-fg sm:text-[56px]">Pricing</h1>
        <p className="mx-auto mt-5 max-w-2xl text-[17px] leading-relaxed text-muted">
          NOVA is free to start. Everyone gets the same features; plans differ only in how much you can use them.
        </p>
      </section>

      <section aria-labelledby="plans" className="mx-auto max-w-5xl px-5 py-10 sm:px-8">
        <h2 id="plans" className="sr-only">Plans</h2>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="lux-card rounded-[22px] p-8">
            <div className="flex items-center justify-between">
              <h3 className="text-2xl font-medium text-fg">{PRICING.free.name}</h3>
              <StatusBadge status="available" />
            </div>
            <p className="mt-4 font-serif text-[52px] leading-none text-fg">
              $0 <span className="font-sans text-base text-muted">forever</span>
            </p>
            <ul className="mt-7 space-y-3 text-[15px] text-muted">
              {[
                `${PRICING.free.window} usage units per 5-hour window`,
                `${PRICING.free.weekly} usage units per week`,
                "Claude and GPT models with the Smart Router",
                "Built-in and custom agents",
                "Nova Council, Nova Arena and Mission Control",
                "Security Team (beta)",
                "No credit card needed",
              ].map((x) => (
                <li key={x} className="flex gap-2.5">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                  {x}
                </li>
              ))}
            </ul>
            <PrimaryCta className="mt-8 w-full justify-center" />
          </div>
          <div className="rounded-[22px] border border-border bg-panel p-8">
            <div className="flex items-center justify-between">
              <h3 className="text-2xl font-medium text-fg">{PRICING.pro.name}</h3>
              <span className="rounded-full border border-border-strong px-2.5 py-0.5 text-[11.5px] text-muted">Not on sale yet</span>
            </div>
            <p className="mt-4 text-[15px] leading-relaxed text-muted">For people who use NOVA every day.</p>
            <ul className="mt-7 space-y-3 text-[15px] text-muted">
              {[`${PRICING.pro.window} usage units per 5-hour window`, `${PRICING.pro.weekly} usage units per week`, "Everything in Free"].map((x) => (
                <li key={x} className="flex gap-2.5">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-faint" aria-hidden />
                  {x}
                </li>
              ))}
            </ul>
            <p className="mt-8 rounded-xl border border-border bg-panel-2 p-4 text-sm leading-relaxed text-muted">
              Pro can&rsquo;t be bought yet. Its price will be published on this page before it becomes available.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="units" className="mx-auto max-w-3xl px-5 py-14 sm:px-8">
        <h2 id="units" className="text-2xl font-medium text-fg">How usage units work</h2>
        <div className="mt-5 space-y-4 text-[15px] leading-relaxed text-muted">
          <p>A message to a low-cost model, such as Claude Haiku, uses 1 unit. Larger models cost the service more to run, so a message to one uses more — {LARGE_MODEL_UNITS} units by default.</p>
          <p>Your 5-hour window starts with your first message and resets five hours later. The weekly limit counts everything you used in the last seven days. When you&rsquo;re close to a limit, Auto mode prefers low-cost models and tells you so.</p>
          <p>Nova Council and Nova Arena ask several models at once, so each model&rsquo;s reply counts. Your current usage is always shown in the app.</p>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
