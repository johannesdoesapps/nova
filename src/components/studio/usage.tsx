"use client";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export interface UsageState {
  plan: "free" | "pro";
  window: { used: number; limit: number; resetsAt: number | null };
  week: { used: number; limit: number; resetsAt: number | null };
}

const PLAN_LABEL = { free: "Free", pro: "Pro" } as const;

/** The signed-in user's allowance; refetched whenever a reply finishes (`busy` turns false). */
export function useUsage(busy = false): UsageState | null {
  const [usage, setUsage] = useState<UsageState | null>(null);
  useEffect(() => {
    if (busy) return;
    let alive = true;
    fetch("/api/usage", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { usage: UsageState | null } | null) => {
        if (alive) setUsage(j?.usage ?? null);
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
        : `${left} message${left === 1 ? "" : "s"} left${when ? ` until ${when}` : ""}.`}
      {usage.plan === "free" ? " Upgrade to Pro for more." : ""}
    </p>
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
export function UsageMeters({ usage }: { usage: UsageState }) {
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-s-ink-3">
        {PLAN_LABEL[usage.plan]} plan. Larger models like Sonnet use more of your allowance per message.
      </p>
      <Meter label="Current 5-hour session" used={usage.window.used} limit={usage.window.limit} resetsAt={usage.window.resetsAt} idle="Starts with your next message" />
      <Meter label="This week" used={usage.week.used} limit={usage.week.limit} resetsAt={usage.week.resetsAt} idle="Nothing used in the last 7 days" />
    </div>
  );
}
