"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { headline } from "@/lib/usage-glance";
import { WebOnly } from "@/components/common/native-bridge";
import { BillingButton } from "@/components/common/billing-button";

export interface PlanInfo {
  id: "free" | "pro" | "max";
  label: string;
  interval: "month" | "year";
  unlimited: boolean;
  webSearchesLeft: number | null;
  /** Web searches included per month. */
  webSearches?: number;
  upgradeTo: { id: "pro" | "max"; label: string; priceUsd: number } | null;
  /** A payment the user should fix: a failed renewal (plan kept until graceUntil), or a disputed charge. */
  paymentIssue?: { kind: "past_due"; graceUntil: number | null } | { kind: "disputed" } | null;
}

export interface UsageState {
  plan: "free" | "pro" | "max";
  /** Plan details from /api/usage. */
  info?: PlanInfo | null;
  window: { used: number; limit: number; resetsAt: number | null };
  week: { used: number; limit: number; resetsAt: number | null };
  /** Max: the separate weekly limit for premium models. */
  top?: { used: number; limit: number; resetsAt: number | null } | null;
  /** Paid plans: extra usage bought separately, and whether it's used automatically. */
  credits?: { balance: number; auto: boolean } | null;
  /** This month's AI budget: share used, and "economy" (lowest-cost model only) or "exhausted". */
  budget?: {
    usedShare: number;
    state: "ok" | "economy" | "exhausted";
    resetsAt: number;
    /** The part of the allowance for advanced models (Sonnet, Terra, Opus, Sol). Shares only: dollar figures are internal. */
    premium?: { usedShare: number } | null;
    tokens?: { used: number; limit: number } | null;
    today?: { used: number; limit: number } | null;
    byProvider?: Record<string, { inputTokens: number; outputTokens: number; calls: number }>;
  } | null;
}

const PROVIDER_NAME: Record<string, string> = { anthropic: "Claude (Anthropic)", openai: "ChatGPT models (OpenAI)" };
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

/**
 * The allowance for the sidebar: read when the sidebar appears, then again on navigation and when the tab comes
 * back into view (at most every 30 s), so it stays current without polling.
 */
export function useUsageGlance(signedIn: boolean): UsageState | null {
  const [usage, setUsage] = useState<UsageState | null>(null);
  const pathname = usePathname();
  const last = useRef(0);
  const [focus, setFocus] = useState(0);
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && setFocus((n) => n + 1);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  useEffect(() => {
    if (!signedIn || Date.now() - last.current < 30_000) return;
    last.current = Date.now();
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
  }, [signedIn, pathname, focus]);
  return usage;
}

/** One meter above the account menu: how much of the week (or of the 5-hour session, when that's tighter) is used. */
export function SidebarUsage({ usage, rail, onNavigate }: { usage: UsageState; rail: boolean; onNavigate?: () => void }) {
  const h = headline(usage);
  const when = formatReset(h.resetsAt);
  const what = h.scope === "week" ? "this week" : "this 5-hour session";
  const label = h.onCredits ? `${h.scope === "week" ? "Weekly" : "5-hour"} limit reached · using extra usage` : `${h.pct}% of ${what} used`;
  const detail = h.state === "out" ? (when ? `Resets ${when}` : "Used up") : when ? `Resets ${when}` : h.scope === "week" ? "Nothing used this week" : "";
  const bar = cn("h-full rounded-full transition-[width]", h.state === "out" ? "bg-s-danger" : h.state === "low" ? "bg-amber-500" : "bg-s-accent");
  return (
    <Link
      href="/usage"
      onClick={onNavigate}
      aria-label={`Usage: ${label}${detail ? `. ${detail}` : ""}`}
      title={rail ? `${label}${detail ? ` · ${detail}` : ""}` : undefined}
      className={cn("mx-3 mb-1 block rounded-xl px-3 py-2 transition hover:bg-s-hover", rail && "md:mx-auto md:w-9 md:px-1.5")}
    >
      <span className={cn("flex items-baseline justify-between gap-2 text-[12px]", rail && "md:sr-only")}>
        <span className={cn("truncate", h.state === "ok" ? "text-s-ink-3" : "font-medium text-s-ink-2")}>{label}</span>
      </span>
      <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-s-hover" aria-hidden>
        <span className={cn(bar, "block")} style={{ width: `${Math.max(h.pct, 2)}%` }} />
      </span>
      {detail && <span className={cn("mt-1 block text-[11.5px] text-s-ink-3", rail && "md:sr-only")}>{detail}</span>}
    </Link>
  );
}

export function formatReset(at: number | null): string {
  if (at === null) return "";
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  // Within a week the weekday is enough; further out (never for these limits), the date too.
  return at - Date.now() < 6.5 * 86_400_000 ? `${d.toLocaleDateString([], { weekday: "short" })} ${time}` : `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })} ${time}`;
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
  // At the limit with extra usage on: messages keep going, paid from it.
  if (left === 0 && usage.credits?.auto && usage.credits.balance > 0) {
    return (
      <p role="status" className="s-in mt-2 px-3 text-[12.5px] text-s-ink-3">
        You&rsquo;ve reached your {weekly ? "weekly" : "5-hour"} limit{when ? ` (it resets at ${when})` : ""}, so messages now use your extra usage:{" "}
        {usage.credits.balance.toLocaleString("en-US", { maximumFractionDigits: 2 })} units left.
      </p>
    );
  }
  return (
    <p role="status" className={cn("s-in mt-2 px-3 text-[12.5px]", left === 0 ? "text-s-danger" : "text-s-ink-3")}>
      {left === 0
        ? `You've reached your ${weekly ? "weekly" : "5-hour"} limit${when ? `. It resets at ${when}` : ""}.`
        : `About ${Math.floor(left).toLocaleString("en-US")} usage unit${Math.floor(left) === 1 ? "" : "s"} left${when ? ` until ${when}` : ""}.`}
      <UpgradeLink usage={usage} />
    </p>
  );
}

/** One quiet line for the home: the plan and how much of the tighter limit is used (details are in Settings). */
export function UsageSummary({ usage, detailsHref }: { usage: UsageState; detailsHref?: string }) {
  const label = usage.info?.label ?? PLAN_LABEL[usage.plan];
  if (usage.info?.unlimited) return <span>{label} · no usage limits on your account</span>;
  const { pct, scope } = headline(usage);
  const weekly = scope === "week";
  return (
    <span className={cn(pct >= 80 && "text-s-ink-2")}>
      {label} plan · {pct}% of {weekly ? "this week's" : "this 5-hour"} allowance used
      {detailsHref && (
        <>
          {" · "}
          <a href={detailsHref} className="underline-offset-2 hover:text-s-ink hover:underline">
            Details
          </a>
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
    <WebOnly>
      {" "}
      <a href={`/pricing?plan=${up.id}`} className="font-medium text-s-accent underline-offset-2 hover:underline">
        Upgrade to {up.label}
      </a>
    </WebOnly>
  );
}

function Meter({ label, used, limit, resetsAt, idle }: { label: string; used: number; limit: number; resetsAt: number | null; idle: string }) {
  // Rounded down, so the bar shows 100% (and turns red) only when the limit is really reached.
  const pct = Math.min(100, Math.floor((used / limit) * 100));
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
          <p>Larger models, longer messages and bigger files use more of your allowance.{info?.webSearchesLeft != null && info.webSearchesLeft >= 0 && paid ? ` ${info.webSearchesLeft} web searches left this month.` : ""}</p>
        </div>
        {billing && (
          <div className="flex flex-wrap gap-2">
            {info?.upgradeTo && (
              <WebOnly>
                <a href={`/pricing?plan=${info.upgradeTo.id}`} className={cn(btn, "border-transparent bg-s-accent text-white hover:bg-s-accent hover:brightness-110")}>
                  Upgrade to {info.upgradeTo.label} · ${info.upgradeTo.priceUsd}/month
                </a>
              </WebOnly>
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
      <Meter label="This week · all models" used={usage.week.used} limit={usage.week.limit} resetsAt={usage.week.resetsAt} idle="Nothing used this week" />
      {usage.top && <Meter label="This week · premium models (Opus, Sol)" used={usage.top.used} limit={usage.top.limit} resetsAt={usage.top.resetsAt} idle="Nothing used this week" />}
      {usage.budget && <BudgetDetails budget={usage.budget} />}
    </div>
  );
}

/** Monthly allowance (share used), the advanced-model part, tokens, messages today and usage by provider. */
function BudgetDetails({ budget }: { budget: NonNullable<UsageState["budget"]> }) {
  const renews = new Date(budget.resetsAt).toLocaleDateString([], { month: "long", day: "numeric" });
  const providers = Object.entries(budget.byProvider ?? {}).filter(([p]) => p !== "demo");
  return (
    <div className="space-y-3">
      <Meter label="Monthly AI allowance" used={budget.usedShare * 100} limit={100} resetsAt={null} idle={`${Math.round((1 - budget.usedShare) * 100)}% left · renews ${renews}`} />
      {budget.premium && (
        <Meter label="Advanced models (Sonnet, Terra, Opus, Sol)" used={budget.premium.usedShare * 100} limit={100} resetsAt={null} idle={`${Math.round((1 - budget.premium.usedShare) * 100)}% left`} />
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
            </tr>
          </thead>
          <tbody>
            {providers.map(([p, v]) => (
              <tr key={p} className="border-t border-s-line">
                <td className="py-1.5">{PROVIDER_NAME[p] ?? p}</td>
                <td className="py-1.5 text-right">{v.calls.toLocaleString()}</td>
                <td className="py-1.5 text-right">{compact.format(v.inputTokens + v.outputTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface EstimateReply {
  unlimited: boolean;
  label: string;
  weekLeftPct: number | null;
  windowUsedPct: number | null;
  estimate: { typicalPct: number; lowPct: number; highPct: number; runs: number; source: "you" | "everyone" } | null;
}

/**
 * One line before a costly task starts: what one usually uses, as a share of the week (from the user's own recent
 * runs, else everyone's), and how much of the week is left. Nothing for guests or accounts without limits.
 */
export function UsageEstimateLine({ feature, signedIn = true, className }: { feature: string; signedIn?: boolean; className?: string }) {
  const [r, setR] = useState<EstimateReply | null>(null);
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    fetch(`/api/usage/estimate?feature=${encodeURIComponent(feature)}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((j: EstimateReply | null) => alive && setR(j))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [feature, signedIn]);
  const text = estimateText(r);
  if (!text) return null;
  return (
    <p className={cn("text-[12.5px] leading-relaxed", text.warn ? "text-amber-700 dark:text-amber-300" : "text-s-ink-3", className)}>
      {text.line}
      {" · "}
      <a href="/usage" className="underline-offset-2 hover:text-s-ink hover:underline">
        Usage details
      </a>
    </p>
  );
}

/** The sentence for an estimate (exported for tests). */
export function estimateText(r: EstimateReply | null): { line: string; warn: boolean } | null {
  if (!r || r.unlimited) return null;
  const left = r.weekLeftPct;
  const leftText = left === null ? "" : left <= 0 ? " Your week's allowance is used up." : ` ${left}% of your week is left.`;
  const session = r.windowUsedPct !== null && r.windowUsedPct >= 80 ? ` Your 5-hour session is ${r.windowUsedPct}% used.` : "";
  const e = r.estimate;
  if (!e) return { line: `What this ${r.label} uses is counted as it runs.${leftText}${session}`, warn: left !== null && left <= 0 };
  const spread = e.lowPct !== e.highPct ? `${e.lowPct}–${e.highPct}%` : null;
  const basis = e.source === "you" ? ` (${spread ? `${spread} ` : ""}across your last ${e.runs})` : ` (${spread ? `${spread}, ` : ""}going by recent runs on Orbis)`;
  const warn = left !== null && e.typicalPct >= left;
  return { line: `A ${r.label} usually uses about ${e.typicalPct}% of your week${basis}.${leftText}${warn && left > 0 ? " That may be more than you have left." : ""}${session}`, warn };
}
