"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { jsonFetch } from "@/hooks/use-ndjson";
import { featureLabel, groupUsage, type UsageRow } from "@/lib/usage-labels";
import { cn } from "@/lib/utils";
import { StudioHeader, useStudio } from "./frame";
import { BillingButton } from "@/components/common/billing-button";
import { formatReset, UsageMeters, type PlanInfo, type UsageState } from "./usage";
import { ExtraUsage } from "./extra-usage";

type View = "requests" | "day" | "model" | "feature";
const VIEWS: { id: View; label: string }[] = [
  { id: "requests", label: "Requests" },
  { id: "day", label: "By day" },
  { id: "model", label: "By model" },
  { id: "feature", label: "By feature" },
];

/**
 * The usage page: the allowance as the server computes it (remaining units,
 * the 5-hour and weekly limits and when each resets, this month's AI
 * allowance), then the user's own requests from the usage records, by
 * request, day, model or feature. Everything shown comes from the server.
 */
export function UsagePage() {
  const { user, integrations } = useApp();
  const studio = useStudio();
  const [overview, setOverview] = useState<{ usage: UsageState | null; plan: PlanInfo | null } | "error" | null>(null);
  const [history, setHistory] = useState<{ rows: UsageRow[]; truncated: boolean; days: number } | { error: string } | null>(null);
  const [days, setDays] = useState(30);
  const [view, setView] = useState<View>("requests");
  const [feature, setFeature] = useState("");
  const [reload, setReload] = useState(0);
  // Back from Stripe Checkout after buying extra usage or a plan.
  const params = useSearchParams();
  const creditsBought = params.get("credits") === "bought";
  const upgraded = params.get("upgraded");
  const sessionId = params.get("session_id");
  const [activation, setActivation] = useState<"working" | "done" | "later" | null>(sessionId ? "working" : null);

  // Confirm the checkout with Stripe now, so the new plan or extra usage shows without waiting for Stripe's notification.
  useEffect(() => {
    if (!user || !sessionId) return;
    let alive = true;
    jsonFetch<{ applied: string }>("/api/billing/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId }) })
      .then((j) => {
        if (!alive) return;
        setActivation(j.applied === "pending" ? "later" : "done");
        setReload((n) => n + 1);
      })
      .catch(() => alive && setActivation("later"));
    return () => {
      alive = false;
    };
  }, [user, sessionId]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    jsonFetch<{ usage: Omit<UsageState, "budget" | "info"> | null; budget: UsageState["budget"]; plan: PlanInfo | null }>("/api/usage")
      .then((j) => alive && setOverview({ usage: j.usage ? { ...j.usage, budget: j.budget, info: j.plan } : null, plan: j.plan }))
      .catch(() => alive && setOverview("error"));
    return () => {
      alive = false;
    };
  }, [user, reload]);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    jsonFetch<{ rows: UsageRow[]; truncated: boolean; days: number }>(`/api/usage/history?days=${days}`)
      .then((j) => alive && setHistory(j))
      .catch((e: Error) => alive && setHistory({ error: e.message }));
    return () => {
      alive = false;
    };
  }, [user, days, reload]);

  const rows = useMemo(() => (history && "rows" in history ? history.rows : []), [history]);
  const features = useMemo(() => [...new Set(rows.map((r) => featureLabel(r.feature)))].sort(), [rows]);
  const shown = feature ? rows.filter((r) => featureLabel(r.feature) === feature) : rows;
  const total = shown.reduce((n, r) => n + (r.notCounted ? 0 : (r.units ?? 0)), 0);
  const unlimited = overview && overview !== "error" ? !!overview.plan?.unlimited : false;

  return (
    <>
      <StudioHeader>
        <h1 className="text-[14px] font-medium text-s-ink-2">Usage</h1>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-24 pt-2 sm:px-8">
          <h2 className="font-serif text-[clamp(30px,5vw,40px)] leading-tight">Usage</h2>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-s-ink-3">
            What you’ve used and what’s left, from Orbis’s own records. Each message to a model uses units from your allowance; larger models use more.{" "}
            <Link href="/pricing#units" className="text-s-ink-2 underline-offset-2 hover:text-s-ink hover:underline">
              How units work
            </Link>
          </p>

          {activation && (upgraded || creditsBought) && (
            <p role="status" className="glass mt-4 rounded-[16px] px-4 py-3 text-[13.5px] text-s-ink-2">
              {activation === "working"
                ? "Confirming your payment with Stripe…"
                : activation === "done"
                  ? upgraded
                    ? "Payment confirmed. Your new plan is active now."
                    : "Payment confirmed. Your extra usage has been added."
                  : "Your payment is being confirmed. It usually appears within a minute; refresh this page if it doesn’t."}
            </p>
          )}
          {overview && overview !== "error" && overview.plan?.paymentIssue && <PaymentIssue issue={overview.plan.paymentIssue} inGrace={overview.plan.id !== "free"} />}

          {!user ? (
            <section aria-label="Sign in to see your usage" className="glass mt-6 rounded-[22px] p-5 sm:p-6">
              <p className="max-w-xl text-[14.5px] leading-relaxed text-s-ink-2">
                Once you’re signed in, this page shows your plan’s allowance, what you’ve used today and this month, and a history of every request with the model that answered it.
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <Link href="/login?next=/usage" className="inline-flex h-10 items-center rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink transition hover:brightness-110">
                  Sign in to see your usage
                </Link>
                <Link href="/pricing" className="text-[13.5px] text-s-ink-2 underline-offset-4 hover:text-s-ink hover:underline">
                  Compare plans
                </Link>
              </div>
            </section>
          ) : (
            <>
              <section aria-labelledby="usage-now" className="glass mt-6 rounded-[22px] p-4 sm:p-5">
                <div className="mb-3 flex items-center gap-2">
                  <h3 id="usage-now" className="text-[14px] font-semibold">
                    Your allowance
                  </h3>
                  <button
                    type="button"
                    onClick={() => setReload((n) => n + 1)}
                    aria-label="Refresh"
                    title="Refresh"
                    className="ml-auto grid h-8 w-8 place-items-center rounded-lg text-s-ink-3 hover:bg-s-hover hover:text-s-ink"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </button>
                </div>
                {overview === null ? (
                  <div className="space-y-2" role="status" aria-label="Loading">
                    <div className="s-skeleton h-4 w-1/2" />
                    <div className="s-skeleton h-2 w-full" />
                    <div className="s-skeleton h-2 w-full" />
                  </div>
                ) : overview === "error" ? (
                  <p className="text-[13.5px] text-s-ink-2">Your allowance couldn’t load. Try again with the refresh button.</p>
                ) : unlimited ? (
                  <p className="text-[13.5px] text-s-ink-2">Your account has no usage limits. Requests are still recorded below, marked “not counted”.</p>
                ) : overview.usage ? (
                  <>
                    <Remaining usage={overview.usage} />
                    <div className="mt-4">
                      <UsageMeters usage={overview.usage} billing={integrations.billing} />
                    </div>
                    <p className="mt-4 text-[12.5px] leading-relaxed text-s-ink-3">
                      How it works: a typical message uses the units shown in the model menu; longer messages, bigger files and longer conversations use more, short ones less. The 5-hour limit counts
                      from your first message in a session and resets 5 hours later. The weekly limit resets at the same time each week for your account
                      {overview.usage.top ? ", for all models and separately for premium models" : ""}. Failed requests with no reply aren’t charged.
                    </p>
                    {overview.usage.credits && <ExtraUsage credits={overview.usage.credits} bought={creditsBought} onChanged={() => setReload((n) => n + 1)} />}
                  </>
                ) : (
                  <p className="text-[13.5px] text-s-ink-2">No allowance information for your account.</p>
                )}
              </section>

              <section aria-labelledby="usage-history" className="mt-6">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 id="usage-history" className="text-[14px] font-semibold">
                    History
                  </h3>
                  <label className="ml-auto flex items-center gap-1.5 text-[12.5px] text-s-ink-3">
                    <span className="sr-only">Period</span>
                    <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="h-8 rounded-lg border border-s-line bg-transparent px-2 text-[12.5px] text-s-ink">
                      {[7, 30, 90].map((d) => (
                        <option key={d} value={d} className="bg-s-bg">
                          Last {d} days
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-1.5 text-[12.5px] text-s-ink-3">
                    <span className="sr-only">Feature</span>
                    <select value={feature} onChange={(e) => setFeature(e.target.value)} className="h-8 max-w-[180px] rounded-lg border border-s-line bg-transparent px-2 text-[12.5px] text-s-ink">
                      <option value="" className="bg-s-bg">
                        All features
                      </option>
                      {features.map((f) => (
                        <option key={f} value={f} className="bg-s-bg">
                          {f}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div role="tablist" aria-label="Show usage" className="mt-3 flex gap-1 overflow-x-auto">
                  {VIEWS.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      role="tab"
                      aria-selected={view === v.id}
                      onClick={() => setView(v.id)}
                      className={cn("shrink-0 rounded-full px-3 py-1.5 text-[12.5px]", view === v.id ? "bg-s-hover text-s-ink" : "text-s-ink-3 hover:text-s-ink")}
                    >
                      {v.label}
                    </button>
                  ))}
                </div>

                <div className="glass mt-3 rounded-[22px] p-2 sm:p-3">
                  {history === null ? (
                    <div className="space-y-2 p-2" role="status" aria-label="Loading">
                      {[1, 2, 3, 4].map((i) => (
                        <div key={i} className="s-skeleton h-9 w-full" />
                      ))}
                    </div>
                  ) : "error" in history ? (
                    <p className="p-3 text-[13.5px] text-s-ink-2">{history.error}</p>
                  ) : shown.length === 0 ? (
                    <p className="p-3 text-[13.5px] text-s-ink-3">No requests in this period{feature ? ` for ${feature}` : ""}.</p>
                  ) : view === "requests" ? (
                    <Requests rows={shown} />
                  ) : (
                    <Grouped rows={groupUsage(shown, view)} by={view} />
                  )}
                </div>
                {history && "rows" in history && shown.length > 0 && (
                  <p className="mt-2 px-1 text-[12px] text-s-ink-3">
                    {shown.length} request{shown.length === 1 ? "" : "s"}
                    {unlimited ? "" : ` · ${fmt(total)} unit${total === 1 ? "" : "s"} charged`}
                    {history.truncated ? " · showing the latest 500" : ""}. Units are as recorded when each request finished.
                  </p>
                )}
              </section>
            </>
          )}
          {user && (
            <p className="mt-6 text-[12.5px] text-s-ink-3">
              Questions about a charge?{" "}
              <button type="button" onClick={studio.openSettings} className="underline-offset-2 hover:text-s-ink hover:underline">
                Settings
              </button>{" "}
              has your plan;{" "}
              <Link href="/pricing" className="underline-offset-2 hover:text-s-ink hover:underline">
                Plans and pricing
              </Link>{" "}
              explains what each includes.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The tighter of the two limits: what can be used right now, and when it frees up. */
function Remaining({ usage }: { usage: UsageState }) {
  const windowLeft = Math.max(0, usage.window.limit - usage.window.used);
  const weekLeft = Math.max(0, usage.week.limit - usage.week.used);
  const weekly = weekLeft < windowLeft;
  const left = Math.min(windowLeft, weekLeft);
  const at = weekly ? usage.week.resetsAt : usage.window.resetsAt;
  return (
    <p className="text-[14px]">
      <span className="font-serif text-[28px] leading-none">{fmt(left)}</span> <span className="text-s-ink-2">unit{left === 1 ? "" : "s"} left right now</span>
      <span className="block text-[12.5px] text-s-ink-3">
        Set by your {weekly ? "weekly" : "5-hour"} limit{at ? ` · more from ${formatReset(at)}` : ""}.
      </span>
    </p>
  );
}

function Requests({ rows }: { rows: UsageRow[] }) {
  return (
    <ul className="divide-y divide-s-line">
      {rows.map((r, i) => (
        <li key={`${r.at}-${i}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-2 py-2.5 text-[13px]">
          <time dateTime={r.at} className="w-[132px] shrink-0 text-s-ink-3">
            {new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </time>
          <span className="min-w-0 flex-1">
            <span className="text-s-ink">{featureLabel(r.feature)}</span>
            <span className="text-s-ink-3"> · {r.model}</span>
            {r.fallbackFrom && <span className="block text-[12px] text-s-ink-3">Backup for {r.fallbackFrom}</span>}
            {r.requested && !r.fallbackFrom && <span className="block text-[12px] text-s-ink-3">Chosen by Auto</span>}
          </span>
          <span className={cn("shrink-0 text-[12px]", r.status === "error" ? "text-s-danger" : "text-s-ink-3")}>
            {r.status === "error" ? `Failed${r.errorCode ? ` (${r.errorCode})` : ""}` : "Done"}
          </span>
          <span className="w-[92px] shrink-0 text-right font-medium tabular-nums text-s-ink">
            {r.notCounted ? "not counted" : r.units === null ? "—" : `${fmt(r.units)} unit${r.units === 1 ? "" : "s"}`}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Grouped({ rows, by }: { rows: ReturnType<typeof groupUsage>; by: "day" | "model" | "feature" }) {
  const max = Math.max(1, ...rows.map((r) => r.units));
  return (
    <ul className="divide-y divide-s-line">
      {rows.map((g) => (
        <li key={g.key} className="px-2 py-2.5 text-[13px]">
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate text-s-ink">{g.key}</span>
            <span className="shrink-0 text-[12px] text-s-ink-3">
              {g.requests} request{g.requests === 1 ? "" : "s"}
              {g.failed ? ` · ${g.failed} failed` : ""}
            </span>
            <span className="w-[80px] shrink-0 text-right font-medium tabular-nums">{fmt(g.units)} units</span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-s-hover" aria-hidden>
            <div className="h-full rounded-full bg-s-accent" style={{ width: `${(g.units / max) * 100}%` }} />
          </div>
        </li>
      ))}
      {by === "day" && <li className="px-2 pt-2 text-[12px] text-s-ink-3">Days with no requests aren’t listed.</li>}
    </ul>
  );
}

function PaymentIssue({ issue, inGrace }: { issue: NonNullable<PlanInfo["paymentIssue"]>; inGrace: boolean }) {
  // The server keeps the paid plan only during the grace period, so a paid plan here means it's still running.
  const until = issue.kind === "past_due" && inGrace && issue.graceUntil ? formatReset(issue.graceUntil) : null;
  return (
    <section role="alert" className="mt-4 rounded-[16px] border border-warning/40 bg-warning/10 px-4 py-3 text-[13.5px] leading-relaxed text-s-ink">
      {issue.kind === "past_due" ? (
        <>
          <p className="font-medium">Your last payment didn’t go through.</p>
          <p className="mt-0.5 text-s-ink-2">
            {until ? `Your plan keeps working until ${until} while we try your card again.` : "Your account is on the Free plan until the payment goes through."} Update your card to keep your plan.
          </p>
        </>
      ) : (
        <>
          <p className="font-medium">A payment on your account is disputed.</p>
          <p className="mt-0.5 text-s-ink-2">Paid features are paused while the dispute is open. If this is a mistake, contact your bank or reply to your Orbis receipt.</p>
        </>
      )}
      <div className="mt-2">
        <BillingButton action="manage" className="inline-flex h-9 items-center rounded-full bg-s-accent px-4 text-[13px] font-medium text-s-accent-ink transition hover:brightness-110">
          Update payment details
        </BillingButton>
      </div>
    </section>
  );
}
