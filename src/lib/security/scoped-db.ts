import type { SupabaseClient } from "@supabase/supabase-js";
import type { ServerSupabase } from "../supabase/server";

/**
 * A service-role database client narrowed to one person, for background work that has no session (scheduled
 * audits). The service role bypasses row-level security, so isolation is enforced here instead: only the tables
 * audits use are reachable, every read, update and delete is filtered by the person's user id, every insert and
 * upsert has its user id forced, a patch can't move a row to someone else, and RPCs are refused.
 */

export const SCOPED_TABLES = new Set(["security_runs", "security_findings", "security_audit", "security_targets", "connector_accounts", "admins"]);

type Row = Record<string, unknown>;

export function userScopedDb(db: Pick<SupabaseClient, "from">, userId: string): ServerSupabase {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("A scoped client needs a user id.");
  const own = (rows: Row | Row[]): Row | Row[] => (Array.isArray(rows) ? rows.map((r) => ({ ...r, user_id: userId })) : { ...rows, user_id: userId });
  const scoped = {
    from(table: string) {
      if (!SCOPED_TABLES.has(table)) throw new Error(`Background audits can't use the ${table} table.`);
      const q = db.from(table);
      return {
        select: (cols?: string, opts?: Parameters<typeof q.select>[1]) => q.select(cols, opts).eq("user_id", userId),
        insert: (rows: Row | Row[], opts?: Parameters<typeof q.insert>[1]) => q.insert(own(rows), opts),
        upsert: (rows: Row | Row[], opts?: Parameters<typeof q.upsert>[1]) => q.upsert(own(rows), opts),
        update: (patch: Row, opts?: Parameters<typeof q.update>[1]) => {
          const { user_id: _drop, ...rest } = patch;
          void _drop;
          return q.update(rest, opts).eq("user_id", userId);
        },
        delete: (opts?: Parameters<typeof q.delete>[0]) => q.delete(opts).eq("user_id", userId),
      };
    },
    rpc() {
      throw new Error("Background audits can't call database functions.");
    },
  };
  return scoped as unknown as ServerSupabase;
}
