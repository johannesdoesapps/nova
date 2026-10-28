import { WAITING } from "@/lib/agent-platform/activity";
import type { InboxKind } from "@/lib/inbox";
import type { RunStatus } from "./types";

type RunLike = { id: string; project_id: string; request: string; status: RunStatus; steps: number; summary: string | null; error: string | null; pending: unknown };

/**
 * The update for a coding task whose status just changed: it finished, stopped, or waits for the user. Null for
 * every other status. One per run, status and step (`key`), so a repeat save doesn't notify twice. Pure.
 */
export function runNotice(r: RunLike): { kind: InboxKind; key: string; title: string; body: string | null; href: string } | null {
  const href = `/code/${r.project_id}?run=${r.id}`;
  const title = r.request.replace(/\s+/g, " ").trim().slice(0, 100) || "Coding task";
  const key = `code_run:${r.id}:${r.status}:${r.steps}`;
  if (r.status === "completed") return { kind: "task_done", key, title, body: r.summary?.slice(0, 400) ?? null, href };
  if (r.status === "failed") return { kind: "task_failed", key, title, body: r.error?.slice(0, 400) ?? null, href };
  if (r.status === "awaiting_approval" || r.status === "needs_input") {
    const kind = (r.pending as { kind?: string } | null)?.kind;
    return { kind: "task_waiting", key, title, body: (kind && WAITING[kind]) || "It's waiting for you.", href };
  }
  return null;
}
