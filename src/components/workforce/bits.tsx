"use client";
import type { ReactNode } from "react";
import { Ban, Check, CircleAlert, CircleDashed, Clock, Loader2, Pause, SkipForward } from "lucide-react";
import { cn } from "@/lib/utils";

export const TASK_LABEL: Record<string, string> = {
  created: "Queued",
  analyzing: "Analyzing",
  planned: "Planned",
  awaiting_approval: "Awaiting approval",
  running: "Running",
  verifying: "Verifying",
  completed: "Completed",
  failed: "Failed",
  blocked: "Blocked",
  cancelled: "Cancelled",
  needs_attention: "Needs attention",
  paused: "Paused",
};

const TONE: Record<string, string> = {
  created: "border-s-line text-s-ink-2",
  analyzing: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/25",
  planned: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/25",
  running: "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/25",
  verifying: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/25",
  awaiting_approval: "bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  needs_attention: "bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  blocked: "bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  completed: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  failed: "bg-red-500/10 text-s-danger border-red-500/30",
  cancelled: "border-s-line text-s-ink-3",
  paused: "border-s-line text-s-ink-2",
};

export function TaskStatusBadge({ status }: { status: string }) {
  const live = ["analyzing", "running", "verifying"].includes(status);
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium", TONE[status] ?? TONE.created)}>
      {live && <span className="s-dot h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {TASK_LABEL[status] ?? status}
    </span>
  );
}

export const STEP_ICON: Record<string, ReactNode> = {
  pending: <CircleDashed className="text-s-ink-3" />,
  running: <Loader2 className="animate-spin text-sky-500" />,
  succeeded: <Check className="text-emerald-500" />,
  failed: <CircleAlert className="text-s-danger" />,
  skipped: <SkipForward className="text-s-ink-3" />,
  cancelled: <Ban className="text-s-ink-3" />,
  blocked: <Pause className="text-amber-500" />,
  waiting: <Clock className="text-amber-500" />,
};

export const usd = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`);
export const dur = (ms: number | null | undefined) => {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m} min ${Math.round((ms % 60_000) / 1000)} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export const ACTIVE = ["created", "analyzing", "running", "verifying"];

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "warn" | "ok" | "bad" }) {
  return (
    <div className="glass rounded-[18px] px-4 py-3.5" title={hint}>
      <p className="text-[12px] text-s-ink-3">{label}</p>
      <p className={cn("mt-1 text-[22px] font-semibold tabular-nums tracking-[-0.01em]", tone === "warn" && "text-amber-600 dark:text-amber-300", tone === "bad" && "text-s-danger", tone === "ok" && "text-emerald-600 dark:text-emerald-400")}>{value}</p>
      {hint && <p className="mt-0.5 line-clamp-2 text-[11.5px] text-s-ink-3">{hint}</p>}
    </div>
  );
}

export function DiffView({ diff, max = 4000 }: { diff: string; max?: number }) {
  const lines = diff.split("\n");
  const shown = lines.slice(0, max);
  return (
    <div className="s-scroll max-h-[560px] overflow-auto rounded-xl border border-s-line bg-s-hover/40 font-mono text-[12px] leading-[1.55]">
      <pre className="min-w-max p-3">
        {shown.map((l, i) => (
          <div
            key={i}
            className={cn(
              "px-1",
              l.startsWith("+") && !l.startsWith("+++") && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
              l.startsWith("-") && !l.startsWith("---") && "bg-red-500/10 text-red-800 dark:text-red-300",
              (l.startsWith("diff ") || l.startsWith("+++") || l.startsWith("---")) && "mt-2 font-semibold text-s-ink",
              l.startsWith("@@") && "text-sky-700 dark:text-sky-300",
            )}
          >
            {l || " "}
          </div>
        ))}
      </pre>
      {lines.length > max && <p className="px-4 pb-3 text-[12px] text-s-ink-3">… {lines.length - max} more lines. Download the patch to see everything.</p>}
    </div>
  );
}

export const btn = "inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line-strong px-3.5 text-[13px] font-medium transition hover:bg-s-hover disabled:pointer-events-none disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4";
export const btnPrimary = "inline-flex h-9 items-center gap-1.5 rounded-xl bg-s-accent px-3.5 text-[13px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:pointer-events-none disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4";
export const field = "w-full rounded-xl border border-s-line bg-transparent px-3 py-2 text-[14px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong";
export const label = "mb-1.5 block text-[12.5px] font-medium text-s-ink-2";
