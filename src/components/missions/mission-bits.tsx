"use client";
import { cn } from "@/lib/utils";

export const TASK_LABEL: Record<string, string> = {
  pending: "To do",
  in_progress: "In progress",
  completed: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

export const MISSION_LABEL: Record<string, string> = { active: "Active", paused: "Paused", completed: "Completed", archived: "Archived" };

export function progressOf(c: Record<string, number>) {
  const total = (c.pending ?? 0) + (c.in_progress ?? 0) + (c.completed ?? 0) + (c.blocked ?? 0);
  const done = c.completed ?? 0;
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
}

export function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11.5px]",
        status === "completed" && "bg-s-accent-soft text-s-ink",
        status === "in_progress" && "bg-s-hover text-s-ink",
        status === "active" && "bg-s-hover text-s-ink-2",
        status === "blocked" && "border border-[color-mix(in_srgb,var(--s-danger)_40%,transparent)] text-s-danger",
        (status === "paused" || status === "pending" || status === "archived" || status === "cancelled") && "border border-s-line text-s-ink-3",
      )}
    >
      {TASK_LABEL[status] ?? MISSION_LABEL[status] ?? status}
    </span>
  );
}
