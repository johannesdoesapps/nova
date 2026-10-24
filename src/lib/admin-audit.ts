import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reportError } from "./observability";
import { redactAll } from "./secrets";

/**
 * The admin audit log (admin_audit): who changed platform-wide settings or agents, and when. Written with the
 * administrator's own session (row-level security: administrators add their own rows and read all; nobody can
 * change or remove one). Details are summaries, with anything that looks like a credential removed.
 *
 * Until the table's migration is applied, nothing is recorded and listing says so; the action itself still happens.
 */

export interface AuditEntry {
  id: number;
  actorId: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

const missingTable = (e: { code?: string; message?: string } | null) => !!e && (e.code === "PGRST205" || e.code === "42P01" || /does not exist|could not find the table/i.test(e.message ?? ""));

/** Record an administrator's action. Never throws: a failure to record is reported, not shown to the administrator as a failed save. */
export async function recordAdminAction(db: SupabaseClient, action: string, target: string | null, detail: Record<string, unknown> = {}): Promise<boolean> {
  try {
    const clean = JSON.parse(redactAll(JSON.stringify(detail))) as Record<string, unknown>;
    const { error } = await db.from("admin_audit").insert({ action: action.slice(0, 60), target: target?.slice(0, 120) ?? null, detail: clean });
    if (error) {
      if (!missingTable(error)) reportError(new Error(error.message), { where: "admin_audit.insert" });
      return false;
    }
    return true;
  } catch (err) {
    reportError(err, { where: "admin_audit.insert" });
    return false;
  }
}

/** The latest entries, newest first; `ready` is false while the table doesn't exist yet. */
export async function listAdminActions(db: SupabaseClient, limit = 50): Promise<{ ready: boolean; entries: AuditEntry[] }> {
  const { data, error } = await db.from("admin_audit").select("id, actor_id, action, target, detail, created_at").order("created_at", { ascending: false }).limit(limit);
  if (missingTable(error)) return { ready: false, entries: [] };
  if (error) throw new Error(`Couldn't read the audit log: ${error.message}`);
  return {
    ready: true,
    entries: ((data ?? []) as { id: number; actor_id: string; action: string; target: string | null; detail: Record<string, unknown>; created_at: string }[]).map((r) => ({
      id: r.id,
      actorId: r.actor_id,
      action: r.action,
      target: r.target,
      detail: r.detail,
      createdAt: r.created_at,
    })),
  };
}

/** What changed between two settings objects: the top-level keys whose values differ (values themselves aren't copied into the log). */
export function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)).sort();
}
