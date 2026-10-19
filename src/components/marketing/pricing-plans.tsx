"use client";
import { Check } from "lucide-react";
import { useState } from "react";
import { BillingButton } from "@/components/common/billing-button";
import { PrimaryCta } from "@/components/marketing/parts";
import { cn } from "@/lib/utils";

export interface PricingPlan {
  id: "free" | "pro" | "max";
  label: string;
  blurb: string;
  monthlyUsd: number;
  /** Charged once a year (already discounted). */
  annualUsd: number;
  annualDiscountPct: number;
  features: string[];
}

/** The three plan cards with a monthly / yearly switch. */
export function PricingPlans({
  plans,
  onSale,
  current,
  signedIn,
}: {
  plans: PricingPlan[];
  onSale: boolean;
  current: { plan: "free" | "pro" | "max"; interval: "month" | "year" } | null;
  signedIn: boolean;
}) {
  const [interval, setInterval] = useState<"month" | "year">(current?.plan !== "free" && current?.interval === "year" ? "year" : "month");
  const discount = Math.max(...plans.map((p) => p.annualDiscountPct));
  const subscribed = !!current && current.plan !== "free";
  return (
    <div>
      <div className="mb-8 flex justify-center">
        <div role="radiogroup" aria-label="Billing period" className="inline-flex rounded-full border border-border bg-panel p-1 text-[14px]">
          {(["month", "year"] as const).map((i) => (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={interval === i}
              onClick={() => setInterval(i)}
              className={cn("rounded-full px-4 py-1.5 transition", interval === i ? "bg-accent text-accent-fg" : "text-muted hover:text-fg")}
            >
              {i === "month" ? "Monthly" : `Yearly${discount > 0 ? ` · save ${discount}%` : ""}`}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-3">
        {plans.map((p) => {
          const isCurrent = current?.plan === p.id && (p.id === "free" || current.interval === interval);
          const featured = p.id === "pro";
          const perMonth = interval === "year" && p.monthlyUsd > 0 ? p.annualUsd / 12 : p.monthlyUsd;
          return (
            <div key={p.id} className={cn("flex flex-col rounded-[22px] p-7", featured ? "border-2 border-accent bg-panel" : "lux-card")}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-2xl font-medium text-fg">{p.label}</h3>
                {isCurrent ? (
                  <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-[11.5px] font-medium text-accent">Your plan</span>
                ) : featured ? (
                  <span className="rounded-full border border-border-strong px-2.5 py-0.5 text-[11.5px] text-muted">Most popular</span>
                ) : null}
              </div>
              <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{p.blurb}</p>
              <p className="mt-5 font-serif text-[48px] leading-none text-fg">
                ${formatUsd(perMonth)} <span className="font-sans text-base text-muted">{p.monthlyUsd === 0 ? "forever" : "per month, USD"}</span>
              </p>
              <p className="mt-2 h-5 text-[13px] text-muted">
                {p.monthlyUsd > 0 && interval === "year" ? `$${formatUsd(p.annualUsd)} billed yearly` : p.monthlyUsd > 0 ? "Billed monthly · cancel any time" : ""}
              </p>
              <ul className="mt-6 flex-1 space-y-3 text-[15px] text-muted">
                {p.features.map((x) => (
                  <li key={x} className="flex gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
                    {x}
                  </li>
                ))}
              </ul>
              <div className="mt-8">
                {p.id === "free" ? (
                  subscribed ? (
                    <BillingButton action="change" plan="free" className={secondaryBtn}>
                      Switch to Free at renewal
                    </BillingButton>
                  ) : signedIn ? (
                    <a href="/chat" className={secondaryBtn}>
                      Open NOVA
                    </a>
                  ) : (
                    <PrimaryCta className="w-full justify-center" />
                  )
                ) : !onSale ? (
                  <p className="rounded-xl border border-border bg-panel-2 p-4 text-sm leading-relaxed text-muted">Payments are being set up. {p.label} will be available here shortly.</p>
                ) : isCurrent ? (
                  <BillingButton action="manage" className={secondaryBtn}>
                    Manage subscription
                  </BillingButton>
                ) : (
                  <BillingButton action={subscribed ? "change" : "upgrade"} plan={p.id} interval={interval} className={featured ? primaryBtn : secondaryBtn}>
                    {subscribed ? `Switch to ${p.label}` : `Get ${p.label}`}
                  </BillingButton>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const primaryBtn = "inline-flex h-12 w-full items-center justify-center rounded-full bg-accent px-6 text-[15px] font-medium text-accent-fg transition hover:brightness-110";
const secondaryBtn = "inline-flex h-12 w-full items-center justify-center rounded-full border border-border-strong px-6 text-[15px] font-medium text-fg transition hover:bg-panel-2";

function formatUsd(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
