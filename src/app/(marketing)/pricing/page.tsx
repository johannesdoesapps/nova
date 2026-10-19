import { Check } from "lucide-react";
import { BillingButton } from "@/components/common/billing-button";
import { CtaBand, PrimaryCta, StatusBadge } from "@/components/marketing/parts";
import { billingConfigured } from "@/lib/billing/stripe";
import { PRICING } from "@/content/site";
import { LARGE_MODEL_UNITS } from "@/lib/plans";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Pricing",
  description: `NOVA is free to start: ${PRICING.free.window} usage units per 5-hour window and ${PRICING.free.weekly} per week. Pro is $${PRICING.pro.price} per month with ten times the allowance.`,
  path: "/pricing",
});

export default function PricingPage() {
  const onSale = billingConfigured();
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
              {onSale ? <StatusBadge status="available" /> : <span className="rounded-full border border-border-strong px-2.5 py-0.5 text-[11.5px] text-muted">Coming soon</span>}
            </div>
            <p className="mt-4 font-serif text-[52px] leading-none text-fg">
              ${PRICING.pro.price} <span className="font-sans text-base text-muted">per month, USD</span>
            </p>
            <p className="mt-3 text-[15px] leading-relaxed text-muted">For people who use NOVA every day. Cancel any time.</p>
            <ul className="mt-7 space-y-3 text-[15px] text-muted">
              {[`${PRICING.pro.window} usage units per 5-hour window`, `${PRICING.pro.weekly} usage units per week`, "Ten times the Free allowance", "Everything in Free"].map((x) => (
                <li key={x} className="flex gap-2.5">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                  {x}
                </li>
              ))}
            </ul>
            {onSale ? (
              <BillingButton
                action="upgrade"
                className="mt-8 inline-flex h-12 w-full items-center justify-center rounded-full bg-accent px-6 text-[15px] font-medium text-accent-fg transition hover:brightness-110"
              >
                Upgrade to Pro · ${PRICING.pro.price}/month
              </BillingButton>
            ) : (
              <p className="mt-8 rounded-xl border border-border bg-panel-2 p-4 text-sm leading-relaxed text-muted">Payments are being set up. Pro will be available here shortly.</p>
            )}
            <p className="mt-4 text-[13px] leading-relaxed text-muted">
              Fair use: each plan includes a monthly AI budget. If heavy use of larger models uses most of it, NOVA continues on its lowest-cost model until your billing month renews.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="units" className="mx-auto max-w-3xl px-5 py-14 sm:px-8">
        <h2 id="units" className="text-2xl font-medium text-fg">How usage units work</h2>
        <div className="mt-5 space-y-4 text-[15px] leading-relaxed text-muted">
          <p>A message to a low-cost model, such as Claude Haiku, uses 1 unit. Larger models cost the service more to run, so a message to one uses more — {LARGE_MODEL_UNITS} units by default.</p>
          <p>Your 5-hour window starts with your first message and resets five hours later. The weekly limit counts everything you used in the last seven days. Auto always uses the lowest-cost available model; you can pick another model at any time.</p>
          <p>Nova Council and Nova Arena ask several models at once, so each model&rsquo;s reply counts. Your current usage is always shown in the app.</p>
        </div>
      </section>
      <CtaBand />
    </>
  );
}
