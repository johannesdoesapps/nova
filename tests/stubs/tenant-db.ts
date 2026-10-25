/**
 * An in-memory, multi-tenant stand-in for the Supabase tables Bastion Customer Security uses, with the same
 * row-level rules as the migrations: a user's session only sees (and writes) that user's rows; team members see
 * their team; workspace-role grants are visible to their owner and grantee, and only the owner writes them (for
 * someone in the owner's team). The service client sees everything — and records every query it runs, so tests
 * can check each one was filtered to the workspace being served.
 */

type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;
export interface Query extends PromiseLike<{ data: unknown; error: { code: string; message: string } | null }> {
  select(cols?: string): Query;
  eq(c: string, v: unknown): Query;
  in(c: string, v: unknown[]): Query;
  is(c: string, v: unknown): Query;
  not(c: string, o: string, v: unknown): Query;
  gte(c: string, v: unknown): Query;
  like(c: string, v: unknown): Query;
  order(c: string, o?: { ascending?: boolean }): Query;
  limit(n: number): Query;
  maybeSingle(): Query;
  single(): Query;
  insert(p: Row | Row[]): Query;
  upsert(p: Row | Row[], o?: { onConflict?: string }): Query;
  update(p: Row): Query;
  delete(): Query;
}
export interface QueryLog {
  table: string;
  op: string;
  filters: [string, string, unknown][];
}

const OWNED_BY_USER = new Set(["security_audit", "security_findings", "security_runs", "security_targets", "agents", "conversations", "connector_accounts", "code_projects", "code_agent_runs"]);

export function tenantDb(tables: Tables) {
  let seq = 1000;
  const log: QueryLog[] = [];
  const teamOf = (uid: string) => (tables.team_members ?? []).find((m) => m.user_id === uid)?.team_id ?? null;

  function visible(table: string, uid: string | null, r: Row): boolean {
    if (uid === null) return true; // service role
    if (OWNED_BY_USER.has(table)) return r.user_id === uid;
    if (table === "code_files") return (tables.code_projects ?? []).some((p) => p.id === r.project_id && p.user_id === uid);
    if (table === "team_members") return r.team_id === teamOf(uid);
    if (table === "teams") return r.id === teamOf(uid) || r.owner_id === uid;
    if (table === "bastion_workspace_roles") return r.owner_id === uid || r.user_id === uid;
    return false;
  }
  function mayWrite(table: string, uid: string | null, r: Row): boolean {
    if (uid === null) return true;
    if (OWNED_BY_USER.has(table)) return r.user_id === uid;
    if (table === "bastion_workspace_roles") return r.owner_id === uid && !!teamOf(uid) && teamOf(String(r.user_id)) === teamOf(uid);
    return false;
  }

  function client(uid: string | null) {
    return {
      from(table: string): Query {
        tables[table] ??= [];
        const filters: [string, string, unknown][] = [];
        let op = "select";
        let payload: Row[] = [];
        let onConflict: string[] = [];
        let single: "maybe" | "one" | null = null;
        let limitN = Infinity;
        let order: [string, boolean] | null = null;
        const match = (r: Row) =>
          filters.every(([c, o, v]) => {
            const x = r[c];
            if (o === "eq") return x === v;
            if (o === "in") return (v as unknown[]).includes(x);
            if (o === "is") return v === null ? x === null || x === undefined : x === v;
            if (o === "notnull") return x !== null && x !== undefined;
            if (o === "gte") return String(x) >= String(v);
            if (o === "like")
              return new RegExp(
                `^${String(v)
                  .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
                  .replace(/%/g, ".*")}$`,
              ).test(String(x ?? ""));
            return true;
          });
        const exec = () => {
          if (uid === null) log.push({ table, op, filters: [...filters] });
          const rows = tables[table]!;
          if (op === "insert" || op === "upsert") {
            if (!payload.every((p) => mayWrite(table, uid, p))) return { data: null, error: { code: "42501", message: "new row violates row-level security policy" } };
            const out: Row[] = [];
            for (const p of payload) {
              const existing = op === "upsert" ? rows.find((r) => onConflict.every((k) => r[k] === p[k])) : undefined;
              if (existing) (Object.assign(existing, p), out.push(existing));
              else {
                const row = { id: p.id ?? seq++, created_at: new Date(Date.now() + seq).toISOString(), ...p };
                rows.push(row);
                out.push(row);
              }
            }
            return { data: out, error: null };
          }
          const hits = rows.filter((r) => visible(table, uid, r) && match(r));
          if (op === "delete") {
            tables[table] = rows.filter((r) => !hits.includes(r) || !mayWrite(table, uid, r));
            return { data: hits, error: null };
          }
          if (op === "update") {
            for (const r of hits) if (mayWrite(table, uid, r)) Object.assign(r, payload[0]);
            return { data: hits, error: null };
          }
          let data = [...hits];
          if (order) data.sort((a, b) => (String(a[order![0]]) < String(b[order![0]]) ? -1 : 1) * (order![1] ? 1 : -1));
          data = data.slice(0, limitN);
          if (single) return { data: data[0] ?? null, error: single === "one" && !data[0] ? { code: "PGRST116", message: "no rows" } : null };
          return { data, error: null };
        };
        const q: Record<string, unknown> = {
          select: () => q,
          eq: (c: string, v: unknown) => (filters.push([c, "eq", v]), q),
          in: (c: string, v: unknown[]) => (filters.push([c, "in", v]), q),
          is: (c: string, v: unknown) => (filters.push([c, "is", v]), q),
          not: (c: string, o: string, v: unknown) => (o === "is" && v === null ? filters.push([c, "notnull", null]) : null, q),
          gte: (c: string, v: unknown) => (filters.push([c, "gte", v]), q),
          like: (c: string, v: unknown) => (filters.push([c, "like", v]), q),
          order: (c: string, o?: { ascending?: boolean }) => ((order = [c, o?.ascending !== false]), q),
          limit: (n: number) => ((limitN = n), q),
          maybeSingle: () => ((single = "maybe"), q),
          single: () => ((single = "one"), q),
          insert: (p: Row | Row[]) => ((op = "insert"), (payload = Array.isArray(p) ? p : [p]), q),
          upsert: (p: Row | Row[], o?: { onConflict?: string }) => ((op = "upsert"), (payload = Array.isArray(p) ? p : [p]), (onConflict = (o?.onConflict ?? "id").split(",")), q),
          update: (p: Row) => ((op = "update"), (payload = [p]), q),
          delete: () => ((op = "delete"), q),
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve().then(exec).then(res, rej),
        };
        return q as unknown as Query;
      },
      auth: { admin: { getUserById: async () => ({ data: { user: null } }) } },
    };
  }
  return { tables, log, user: (uid: string) => client(uid), service: client(null) };
}
