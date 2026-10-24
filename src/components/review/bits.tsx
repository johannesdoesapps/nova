"use client";
import { CircleAlert, CircleCheck, CircleDashed, CircleSlash, Loader2 } from "lucide-react";
import type { Severity } from "@/lib/review/review";
import { cn } from "@/lib/utils";

const SEVERITY_STYLE: Record<Severity, string> = {
  critical: "border-s-danger bg-s-danger/10 text-s-danger",
  high: "border-s-danger/60 text-s-danger",
  medium: "border-amber-500/60 text-amber-700 dark:text-amber-400",
  low: "border-s-line-strong text-s-ink-2",
};

/** Severity as a word in a shaped badge, so it never relies on colour alone. */
export function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={cn("inline-flex h-6 items-center rounded-full border px-2 text-[11.5px] font-medium capitalize", SEVERITY_STYLE[severity])}>{severity}</span>;
}

export function SeverityCounts({ counts }: { counts: Record<Severity, number> }) {
  const parts = (["critical", "high", "medium", "low"] as const).filter((s) => counts[s] > 0);
  if (!parts.length) return <span>No open findings</span>;
  return <span>{parts.map((s) => `${counts[s]} ${s}`).join(" · ")}</span>;
}

const STATUS: Record<string, { label: string; icon: typeof CircleCheck; cls: string }> = {
  running: { label: "Reviewing", icon: Loader2, cls: "text-s-ink" },
  completed: { label: "Done", icon: CircleCheck, cls: "text-emerald-700 dark:text-emerald-400" },
  failed: { label: "Stopped with an error", icon: CircleAlert, cls: "text-s-danger" },
  cancelled: { label: "Stopped", icon: CircleSlash, cls: "text-s-ink-3" },
};

export function StatusPill({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, icon: CircleDashed, cls: "text-s-ink-3" };
  return (
    <span className={cn("inline-flex items-center gap-1", s.cls)}>
      <s.icon className={cn("h-3.5 w-3.5", status === "running" && "animate-spin")} aria-hidden />
      {s.label}
    </span>
  );
}
