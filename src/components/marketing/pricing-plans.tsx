"use client";
import { Check } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
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
  highlight,
  initialInterval,
}: {
  plans: PricingPlan[];
  onSale: boolean;
  current: { plan: "free" | "pro" | "max"; interval: "month" | "year" } | null;
  signedIn: boolean;
  /** The plan a link pointed to (?plan=). */
  highlight?: PricingPlan["id"] | null;
  /** From ?interval=. */
  initialInterval?: "month" | "year" | null;
}) {
  const [interval, setIntervalState] = useState<"month" | "year">(
    initialInterval ?? (current?.plan !== "free" && current?.interval === "year" ? "year" : "month"),
  );
  // Keep the choice in the URL so the page can be shared or reloaded as shown.
  const setInterval = (i: "month" | "year") => {
    setIntervalState(i);
    const url = new URL(window.location.href);
    url.searchParams.set("interval", i);
    window.history.replaceState(null, "", url);
  };
  const onRadioKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const next = interval === "month" ? "year" : "month";
    setInterval(next);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-interval="${next}"]`)?.focus();
  };
  const discount = Math.max(...plans.map((p) => p.annualDiscountPct));
  const subscribed = !!current && current.plan !== "free";
  return (
    <div>
      <div className="mb-8 flex justify-center">
        <div role="radiogroup" aria-label="Billing period" onKeyDown={onRadioKey} className="inline-flex rounded-full border border-border bg-panel p-1 text-[14px]">
          {(["month", "year"] as const).map((i) => (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={interval === i}
              tabIndex={interval === i ? 0 : -1}
              data-interval={i}
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
          const featured = highlight ? p.id === highlight : p.id === "pro";
          const perMonth = interval === "year" && p.monthlyUsd > 0 ? p.annualUsd / 12 : p.monthlyUsd;
          return (
            <div key={p.id} id={`plan-${p.id}`} className={cn("scroll-mt-24 flex flex-col rounded-[22px] p-7", featured ? "border-2 border-accent bg-panel" : "lux-card")}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-2xl font-medium text-fg">{p.label}</h3>
                {isCurrent ? (
                  <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-[11.5px] font-medium text-accent">Your plan</span>
                ) : p.id === "pro" ? (
                  <span className="rounded-full border border-border-strong px-2.5 py-0.5 text-[11.5px] text-muted">Recommended</span>
                ) : null}
              </div>
              <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{p.blurb}</p>
              <p className="mt-5 font-serif text-[48px] leading-none text-fg">
                {formatUsd(perMonth)} <span className="font-sans text-base text-muted">{p.monthlyUsd === 0 ? "forever" : "per month, USD"}</span>
              </p>
              <p className="mt-2 h-5 text-[13px] text-muted">
                {p.monthlyUsd > 0 && interval === "year" ? `${formatUsd(p.annualUsd)} billed yearly` : p.monthlyUsd > 0 ? "Billed monthly · cancel any time" : ""}
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
                    <BillingButton
                      action="change"
                      plan="free"
                      confirm="Cancel your subscription at the end of this billing period? You keep your plan until then, then move to Free."
                      className={secondaryBtn}
                    >
                      Switch to Free at renewal
                    </BillingButton>
                  ) : signedIn ? (
                    <a href="/chat" className={secondaryBtn}>
                      Open Orbis
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
                  <BillingButton
                    action={subscribed ? "change" : "upgrade"}
                    plan={p.id}
                    interval={interval}
                    confirm={subscribed ? `Switch to ${p.label} (${formatUsd(interval === "year" ? p.annualUsd : p.monthlyUsd)} per ${interval})? Upgrades are charged pro-rata now; downgrades are credited to your next invoice.` : undefined}
                    className={featured ? primaryBtn : secondaryBtn}
                  >
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

const whole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

function formatUsd(n: number): string {
  return (Number.isInteger(n) ? whole : cents).format(n);
}
