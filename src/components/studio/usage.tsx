"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { BillingButton } from "@/components/common/billing-button";

export interface PlanInfo {
  id: "free" | "pro" | "max";
  label: string;
  interval: "month" | "year";
  unlimited: boolean;
  webSearchesLeft: number | null;
  upgradeTo: { id: "pro" | "max"; label: string; priceUsd: number } | null;
}

export interface UsageState {
  plan: "free" | "pro" | "max";
  /** Plan details from /api/usage. */
  info?: PlanInfo | null;
  window: { used: number; limit: number; resetsAt: number | null };
  week: { used: number; limit: number; resetsAt: number | null };
  /** This month's AI budget: share used, and "economy" (lowest-cost model only) or "exhausted". */
  budget?: {
    usedShare: number;
    state: "ok" | "economy" | "exhausted";
    resetsAt: number;
    limitUsd?: number;
    remainingUsd?: number;
    /** The part of the allowance for advanced models (Sonnet, Terra, Opus, Sol). */
    premium?: { usedShare: number; remainingUsd: number; limitUsd: number } | null;
    tokens?: { used: number; limit: number } | null;
    today?: { used: number; limit: number } | null;
    byProvider?: Record<string, { costUsd: number; inputTokens: number; outputTokens: number; calls: number }>;
  } | null;
}

const PROVIDER_NAME: Record<string, string> = { anthropic: "Claude (Anthropic)", openai: "ChatGPT models (OpenAI)" };
const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

const PLAN_LABEL = { free: "Free", pro: "Pro", max: "Max" } as const;

/** The signed-in user's allowance; refetched whenever a reply finishes (`busy` turns false). */
export function useUsage(busy = false): UsageState | null {
  const [usage, setUsage] = useState<UsageState | null>(null);
  useEffect(() => {
    if (busy) return;
    let alive = true;
    fetch("/api/usage", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { usage: UsageState | null; budget?: UsageState["budget"]; plan?: PlanInfo | null } | null) => {
        if (alive) setUsage(j?.usage ? { ...j.usage, budget: j.budget ?? null, info: j.plan ?? null } : null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [busy]);
  return usage;
}

export function formatReset(at: number | null): string {
  if (at === null) return "";
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** One line under the composer when the allowance is running low or used up. */
export function UsageNotice({ usage }: { usage: UsageState | null }) {
  if (!usage) return null;
  if (usage.budget && usage.budget.state !== "ok") {
    const renews = new Date(usage.budget.resetsAt).toLocaleDateString([], { month: "short", day: "numeric" });
    return (
      <p role="status" className={cn("s-in mt-2 px-3 text-[12.5px]", usage.budget.state === "exhausted" ? "text-s-danger" : "text-s-ink-3")}>
        {usage.budget.state === "exhausted"
          ? `You've used this month's AI allowance. It renews on ${renews}.`
          : `This month's allowance for advanced models is used. Auto and the fast models still work until ${renews}.`}
        <UpgradeLink usage={usage} />
      </p>
    );
  }
  const weekLeft = usage.week.limit - usage.week.used;
  const windowLeft = usage.window.limit - usage.window.used;
  const weekly = weekLeft <= windowLeft;
  const left = Math.max(0, weekly ? weekLeft : windowLeft);
  const limit = weekly ? usage.week.limit : usage.window.limit;
  const resetsAt = weekly ? usage.week.resetsAt : usage.window.resetsAt;
  if (left > limit * 0.2) return null;
  const when = formatReset(resetsAt);
  return (
    <p role="status" className={cn("s-in mt-2 px-3 text-[12.5px]", left === 0 ? "text-s-danger" : "text-s-ink-3")}>
      {left === 0
        ? `You've reached your ${weekly ? "weekly" : "5-hour"} limit${when ? `. It resets at ${when}` : ""}.`
        : `${left} usage unit${left === 1 ? "" : "s"} left${when ? ` until ${when}` : ""}.`}
      <UpgradeLink usage={usage} />
    </p>
  );
}

/** One quiet line for the home: the plan and how much of the tighter limit is used (details are in Settings). */
export function UsageSummary({ usage, onDetails }: { usage: UsageState; onDetails?: () => void }) {
  const label = usage.info?.label ?? PLAN_LABEL[usage.plan];
  if (usage.info?.unlimited) return <span>{label} · no usage limits on your account</span>;
  const weekShare = usage.week.limit ? usage.week.used / usage.week.limit : 0;
  const windowShare = usage.window.limit ? usage.window.used / usage.window.limit : 0;
  const weekly = weekShare >= windowShare;
  const pct = Math.min(100, Math.round((weekly ? weekShare : windowShare) * 100));
  return (
    <span className={cn(pct >= 80 && "text-s-ink-2")}>
      {label} plan · {pct}% of {weekly ? "this week's" : "this 5-hour"} allowance used
      {onDetails && (
        <>
          {" · "}
          <button type="button" onClick={onDetails} className="underline-offset-2 hover:text-s-ink hover:underline">
            Details
          </button>
        </>
      )}
      <UpgradeLink usage={usage} />
    </span>
  );
}

function UpgradeLink({ usage }: { usage: UsageState }) {
  const up = usage.info?.upgradeTo;
  if (!up) return null;
  return (
    <>
      {" "}
      <a href={`/pricing?plan=${up.id}`} className="font-medium text-s-accent underline-offset-2 hover:underline">
        Upgrade to {up.label}
      </a>
    </>
  );
}

function Meter({ label, used, limit, resetsAt, idle }: { label: string; used: number; limit: number; resetsAt: number | null; idle: string }) {
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return (
    <div>
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="font-medium">{label}</span>
        <span className="text-s-ink-3">{pct}% used</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-s-hover" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn("h-full rounded-full transition-[width]", pct >= 100 ? "bg-s-danger" : "bg-s-accent")} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[12px] text-s-ink-3">{resetsAt ? `Resets ${formatReset(resetsAt)}` : idle}</p>
    </div>
  );
}

/** Plan allowance for the Settings dialog. */
export function UsageMeters({ usage, billing = false }: { usage: UsageState; billing?: boolean }) {
  const info = usage.info;
  const paid = usage.plan !== "free";
  const btn = "inline-flex h-8 items-center rounded-xl border border-s-line-strong px-3 text-[12.5px] font-medium transition hover:bg-s-hover";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[12.5px] text-s-ink-3">
          <p>
            <span className="font-medium text-s-ink">{info?.label ?? PLAN_LABEL[usage.plan]} plan</span>
            {paid && info ? ` · billed ${info.interval === "year" ? "yearly" : "monthly"}` : ""}
            {usage.budget && paid ? ` · renews ${new Date(usage.budget.resetsAt).toLocaleDateString([], { month: "short", day: "numeric" })}` : ""}
          </p>
          <p>Larger models use more of your allowance per message.{info?.webSearchesLeft != null && info.webSearchesLeft >= 0 && paid ? ` ${info.webSearchesLeft} web searches left this month.` : ""}</p>
        </div>
        {billing && (
          <div className="flex flex-wrap gap-2">
            {info?.upgradeTo && (
              <a href={`/pricing?plan=${info.upgradeTo.id}`} className={cn(btn, "border-transparent bg-s-accent text-white hover:bg-s-accent hover:brightness-110")}>
                Upgrade to {info.upgradeTo.label} · ${info.upgradeTo.priceUsd}/month
              </a>
            )}
            {paid && (
              <BillingButton action="manage" className={btn}>
                Manage subscription
              </BillingButton>
            )}
          </div>
        )}
      </div>
      <Meter label="Current 5-hour session" used={usage.window.used} limit={usage.window.limit} resetsAt={usage.window.resetsAt} idle="Starts with your next message" />
      <Meter label="This week" used={usage.week.used} limit={usage.week.limit} resetsAt={usage.week.resetsAt} idle="Nothing used in the last 7 days" />
      {usage.budget && <BudgetDetails budget={usage.budget} />}
    </div>
  );
}

/** Monthly allowance in USD, the advanced-model part, tokens, messages today and usage by provider. */
function BudgetDetails({ budget }: { budget: NonNullable<UsageState["budget"]> }) {
  const renews = new Date(budget.resetsAt).toLocaleDateString([], { month: "long", day: "numeric" });
  const providers = Object.entries(budget.byProvider ?? {}).filter(([p]) => p !== "demo");
  return (
    <div className="space-y-3">
      <Meter label="Monthly AI allowance" used={budget.usedShare * 100} limit={100} resetsAt={null} idle={budget.remainingUsd !== undefined && budget.limitUsd !== undefined ? `${usdFmt.format(budget.remainingUsd)} of ${usdFmt.format(budget.limitUsd)} left · renews ${renews}` : `Renews ${renews}`} />
      {budget.premium && (
        <Meter label="Advanced models (Sonnet, Terra, Opus, Sol)" used={budget.premium.usedShare * 100} limit={100} resetsAt={null} idle={`${usdFmt.format(budget.premium.remainingUsd)} of ${usdFmt.format(budget.premium.limitUsd)} left`} />
      )}
      {budget.tokens && <Meter label="Tokens this month" used={budget.tokens.used} limit={budget.tokens.limit} resetsAt={null} idle={`${compact.format(budget.tokens.used)} of ${compact.format(budget.tokens.limit)} used`} />}
      {budget.today && <Meter label="Messages today" used={budget.today.used} limit={budget.today.limit} resetsAt={null} idle={`${budget.today.used} of ${budget.today.limit} · resets at midnight UTC`} />}
      {providers.length > 0 && (
        <table className="w-full text-left text-[12.5px] tabular-nums">
          <caption className="sr-only">Usage by provider this month</caption>
          <thead className="text-[11.5px] text-s-ink-3">
            <tr>
              <th className="py-1 font-medium">This month</th>
              <th className="py-1 text-right font-medium">Replies</th>
              <th className="py-1 text-right font-medium">Tokens</th>
              <th className="py-1 text-right font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {providers.map(([p, v]) => (
              <tr key={p} className="border-t border-s-line">
                <td className="py-1.5">{PROVIDER_NAME[p] ?? p}</td>
                <td className="py-1.5 text-right">{v.calls.toLocaleString()}</td>
                <td className="py-1.5 text-right">{compact.format(v.inputTokens + v.outputTokens)}</td>
                <td className="py-1.5 text-right">{usdFmt.format(v.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
