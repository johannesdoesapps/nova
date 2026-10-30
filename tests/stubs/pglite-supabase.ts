/**
 * A small Supabase-client stand-in over PGlite, for running server code against the real migrations with
 * row-level security: every query runs as the given user (role authenticated, auth.uid() = that user).
 * Supports select/insert/update/upsert/delete with eq/neq/in/is/gte/lte/order/limit/range, single/maybeSingle, counts
 * (select with { count: "exact", head: true }), upserts that ignore duplicates, and rpc (named arguments). Dates, timestamps and numerics come back as strings, as PostgREST returns them.
 * Queries on one database run one at a time (a session's role is set per query), so concurrent callers in a
 * test can't see each other's role.
 */
import type { PGlite } from "@electric-sql/pglite";

type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code: string; message: string } | null; count?: number | null };

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`);
  return `"${s}"`;
};
const cols = (s: string) =>
  s.trim() === "*"
    ? "*"
    : s
        .split(",")
        .map((c) => ident(c.trim()))
        .join(", ");
// Arrays of plain values go to array columns as arrays (PostgREST takes JSON arrays for them); objects go as JSON.
const param = (v: unknown) => (Array.isArray(v) && v.every((x) => x === null || typeof x !== "object") ? v : v !== null && typeof v === "object" ? JSON.stringify(v) : v);

class Query implements PromiseLike<Result> {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private columns = "*";
  private returning: string | null = null;
  private filters: [string, string, unknown][] = [];
  private orderBy: string | null = null;
  private lim: number | null = null;
  private mode: "many" | "single" | "maybe" = "many";
  private payload: Row[] = [];
  private conflict: string | null = null;
  private ignoreDuplicates = false;
  private countOnly = false;
  private off = 0;

  constructor(
    private run: (sql: string, params: unknown[]) => Promise<Row[]>,
    private table: string,
  ) {}

  select(c = "*", o?: { count?: "exact"; head?: boolean }) {
    if (o?.count && o.head) this.countOnly = true;
    if (this.op === "select") this.columns = c;
    else this.returning = c;
    return this;
  }
  insert(p: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(p) ? p : [p];
    return this;
  }
  upsert(p: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.op = "upsert";
    this.payload = Array.isArray(p) ? p : [p];
    this.conflict = o?.onConflict ?? "id";
    this.ignoreDuplicates = !!o?.ignoreDuplicates;
    return this;
  }
  update(p: Row) {
    this.op = "update";
    this.payload = [p];
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(c: string, v: unknown) {
    this.filters.push([c, "=", v]);
    return this;
  }
  neq(c: string, v: unknown) {
    this.filters.push([c, "<>", v]);
    return this;
  }
  in(c: string, v: unknown[]) {
    this.filters.push([c, "= any", v]);
    return this;
  }
  like(c: string, v: string) {
    this.filters.push([c, "like", v]);
    return this;
  }
  is(c: string, v: null | boolean) {
    this.filters.push([c, v === null ? "is null" : `is ${v}`, undefined]);
    return this;
  }
  gte(c: string, v: unknown) {
    this.filters.push([c, ">=", v]);
    return this;
  }
  lte(c: string, v: unknown) {
    this.filters.push([c, "<=", v]);
    return this;
  }
  order(c: string, o?: { ascending?: boolean }) {
    this.orderBy = `${ident(c)} ${o?.ascending === false ? "desc" : "asc"}`;
    return this;
  }
  limit(n: number) {
    this.lim = n;
    return this;
  }
  range(from: number, to: number) {
    this.off = from;
    this.lim = to - from + 1;
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }

  private where(params: unknown[]) {
    if (!this.filters.length) return "";
    return ` where ${this.filters
      .map(([c, op, v]) => {
        if (op.startsWith("is ")) return `${ident(c)} ${op}`;
        params.push(op === "= any" ? v : param(v));
        return op === "= any" ? `${ident(c)} = any($${params.length})` : `${ident(c)} ${op} $${params.length}`;
      })
      .join(" and ")}`;
  }

  private sql(): [string, unknown[]] {
    const t = `public.${ident(this.table)}`;
    const params: unknown[] = [];
    const ret = this.returning ? ` returning ${cols(this.returning)}` : "";
    if (this.op === "select" && this.countOnly) return [`select count(*)::int as n from ${t}${this.where(params)}`, params];
    if (this.op === "select") return [`select ${cols(this.columns)} from ${t}${this.where(params)}${this.orderBy ? ` order by ${this.orderBy}` : ""}${this.lim ? ` limit ${this.lim}` : ""}${this.off ? ` offset ${this.off}` : ""}`, params];
    if (this.op === "delete") return [`delete from ${t}${this.where(params)}${ret}`, params];
    if (this.op === "update") {
      const sets = Object.entries(this.payload[0]!).map(([k, v]) => (params.push(param(v)), `${ident(k)} = $${params.length}`));
      return [`update ${t} set ${sets.join(", ")}${this.where(params)}${ret}`, params];
    }
    const keys = Object.keys(this.payload[0]!);
    const values = this.payload.map((r) => `(${keys.map((k) => (params.push(param(r[k])), `$${params.length}`)).join(", ")})`);
    const target = this.op === "upsert" ? ` on conflict (${this.conflict!.split(",").map((c) => ident(c.trim())).join(", ")})` : "";
    const conflict = !target ? "" : this.ignoreDuplicates ? `${target} do nothing` : `${target} do update set ${keys.map((k) => `${ident(k)} = excluded.${ident(k)}`).join(", ")}`;
    return [`insert into ${t} (${keys.map(ident).join(", ")}) values ${values.join(", ")}${conflict}${ret}`, params];
  }

  async exec(): Promise<Result> {
    try {
      const [sql, params] = this.sql();
      const rows = await this.run(sql, params);
      if (this.countOnly) return { data: null, error: null, count: Number(rows[0]?.n ?? 0) };
      if (this.mode === "single") return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { code: "PGRST116", message: `expected one row, got ${rows.length}` } };
      if (this.mode === "maybe") return rows.length > 1 ? { data: null, error: { code: "PGRST116", message: "more than one row" } } : { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { data: null, error: { code: e.code ?? "XX000", message: e.message ?? "error" } };
    }
  }

  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.exec().then(ok, fail);
  }
}

const queues = new WeakMap<PGlite, Promise<unknown>>();
/** Run `fn` after every earlier query on this database has finished. */
function serial<T>(db: PGlite, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(db) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    db,
    next.catch(() => undefined),
  );
  return next;
}

function client(db: PGlite, userId: string | null) {
  const run = (sql: string, params: unknown[]) =>
    serial(db, async () => {
      await db.exec(userId ? `reset role; select set_config('request.jwt.claim.sub', '${userId}', false); set role authenticated;` : "reset role; select set_config('request.jwt.claim.sub', '', false);");
      try {
        return (await db.query<Row>(sql, params)).rows;
      } finally {
        await db.exec("reset role");
      }
    });
  const rpc = async (fn: string, args: Record<string, unknown> = {}): Promise<Result> => {
    try {
      const keys = Object.keys(args);
      const rows = await run(`select public.${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => param(args[k])));
      return { data: rows[0]?.r ?? null, error: null };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { data: null, error: { code: e.code ?? "XX000", message: e.message ?? "error" } };
    }
  };
  return { from: (table: string) => new Query(run, table), rpc };
}

/** A client whose queries run as `userId` under the migrations' row-level security. */
export function supabaseAs(db: PGlite, userId: string) {
  return client(db, userId);
}

/** The server's service-role client: no row-level security (the database superuser stands in for it). */
export function serviceAs(db: PGlite) {
  return client(db, null);
}

/** PGlite parsers that keep dates, timestamps and numerics as strings (PostgREST's JSON shapes). */
export const POSTGREST_PARSERS = { 1082: (v: string) => v, 1114: (v: string) => v, 1184: (v: string) => v, 1700: (v: string) => v };
