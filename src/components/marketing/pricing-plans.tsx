"use client";
import { useState } from "react";
import { BillingButton } from "@/components/common/billing-button";
import { NativePurchaseNote, useNativePlatform } from "@/components/common/native-bridge";
import { PrimaryCta } from "@/components/marketing/parts";
import { PricingSection } from "@/components/ui/pricing";

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

/** The three plan cards with a monthly / yearly switch (the starfield pricing section, with Orbis's real plans and checkout). */
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
  const discount = Math.max(...plans.map((p) => p.annualDiscountPct));
  const subscribed = !!current && current.plan !== "free";
  // Inside the store apps the plans are shown for reference only (see NativePurchaseNote).
  const native = useNativePlatform();

  const button = (p: PricingPlan, interval: "month" | "year", featured: boolean, isCurrent: boolean) => {
    if (native) return null;
    if (p.id === "free")
      return subscribed ? (
        <BillingButton
          action="change"
          plan="free"
          confirm="Cancel your subscription at the end of this billing period? You keep your plan until then, then move to Free."
          className={secondaryBtn}
        >
          Switch to Free at renewal
        </BillingButton>
      ) : signedIn ? (
        <a href="/home" className={secondaryBtn}>
          Open Orbis
        </a>
      ) : (
        <PrimaryCta className="w-full justify-center" />
      );
    if (!onSale) return <p className="rounded-xl border border-border bg-panel-2 p-4 text-sm leading-relaxed text-muted">Payments are being set up. {p.label} will be available here shortly.</p>;
    if (isCurrent)
      return (
        <BillingButton action="manage" className={secondaryBtn}>
          Manage subscription
        </BillingButton>
      );
    return (
      <BillingButton
        action={subscribed ? "change" : "upgrade"}
        plan={p.id}
        interval={interval}
        confirm={subscribed ? `Switch to ${p.label} (${formatUsd(interval === "year" ? p.annualUsd : p.monthlyUsd)} per ${interval})? Upgrades are charged pro-rata now; downgrades are credited to your next invoice.` : undefined}
        className={featured ? primaryBtn : secondaryBtn}
      >
        {subscribed ? `Switch to ${p.label}` : `Get ${p.label}`}
      </BillingButton>
    );
  };

  return (
    <PricingSection
      title={null}
      description={null}
      className="py-6 sm:py-8"
      annualSaving={discount > 0 ? `Save ${discount}%` : null}
      isMonthly={interval === "month"}
      onIntervalChange={(m) => setInterval(m ? "month" : "year")}
      notice={native ? <NativePurchaseNote className="mx-auto mb-6 max-w-xl rounded-xl border border-border bg-panel-2 p-4 text-center text-sm leading-relaxed text-muted" /> : null}
      plans={plans.map((p) => {
        const featured = highlight ? p.id === highlight : p.id === "pro";
        const paid = p.monthlyUsd > 0;
        return {
          id: `plan-${p.id}`,
          name: p.label,
          description: p.blurb,
          price: p.monthlyUsd,
          yearlyPrice: paid ? p.annualUsd / 12 : 0,
          period: "month",
          features: p.features,
          isPopular: featured,
          badge: highlight && p.id === highlight ? "Selected" : "Recommended",
          tag: current?.plan === p.id && (p.id === "free" || current.interval === interval) ? "Your plan" : undefined,
          billingNote: (monthly: boolean) => (!paid ? "Free forever" : monthly ? "Billed monthly · cancel any time" : `${formatUsd(p.annualUsd)} billed yearly`),
          cta: (monthly: boolean) => {
            const i = monthly ? "month" : "year";
            return button(p, i, featured, current?.plan === p.id && (p.id === "free" || current.interval === i));
          },
        };
      })}
    />
  );
}

const primaryBtn = "inline-flex h-12 w-full items-center justify-center rounded-full bg-accent px-6 text-[15px] font-medium text-accent-fg transition hover:brightness-110";
const secondaryBtn = "inline-flex h-12 w-full items-center justify-center rounded-full border border-border-strong px-6 text-[15px] font-medium text-fg transition hover:bg-panel-2";

const whole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

function formatUsd(n: number): string {
  return (Number.isInteger(n) ? whole : cents).format(n);
}
