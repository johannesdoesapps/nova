/**
 * A small in-memory stand-in for the Supabase query builder, for tests of the
 * data layer. Each client acts as one user: rows are limited the way the real
 * row-level security policies limit them (owner only; messages through their
 * conversation). Supports the calls the chat and project code makes.
 */

type Row = Record<string, unknown>;
export type Tables = Record<string, Row[]>;

/** Which rows a user may see, per table (mirrors the owner-only policies). */
function visible(tables: Tables, table: string, uid: string): Row[] {
  const rows = tables[table] ?? [];
  if (table === "profiles") return rows.filter((r) => r.id === uid);
  if (table === "messages") {
    const mine = new Set((tables.conversations ?? []).filter((c) => c.user_id === uid).map((c) => c.id));
    return rows.filter((r) => mine.has(r.conversation_id));
  }
  return rows.filter((r) => r.user_id === uid);
}

function likeToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "\\" && i + 1 < pattern.length) out += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "is");
}

class Query implements PromiseLike<{ data: unknown; error: null }> {
  private filters: ((r: Row) => boolean)[] = [];
  private sort: { col: string; asc: boolean } | null = null;
  private max = Infinity;
  private cols = "*";
  private patch: Row | null = null;
  private one: "single" | "maybe" | null = null;

  constructor(
    private tables: Tables,
    private table: string,
    private uid: string,
    private log: string[],
  ) {}

  select(cols = "*") {
    this.cols = cols;
    return this;
  }
  update(patch: Row) {
    this.patch = patch;
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((r) => r[col] === v);
    return this;
  }
  is(col: string, v: null) {
    this.filters.push((r) => (r[col] ?? null) === v);
    return this;
  }
  not(col: string, op: "is", v: null) {
    this.filters.push((r) => (r[col] ?? null) !== v);
    return this;
  }
  in(col: string, vs: unknown[]) {
    this.filters.push((r) => vs.includes(r[col]));
    return this;
  }
  ilike(col: string, pattern: string) {
    const re = likeToRegExp(pattern);
    this.filters.push((r) => typeof r[col] === "string" && re.test(r[col] as string));
    return this;
  }
  order(col: string, o: { ascending?: boolean } = {}) {
    this.sort = { col, asc: o.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  maybeSingle() {
    this.one = "maybe";
    return this;
  }
  single() {
    this.one = "single";
    return this;
  }

  private project(r: Row): Row {
    if (this.cols === "*") return { ...r };
    const out: Row = {};
    for (const part of this.cols.split(/,(?![^(]*\))/)) {
      const join = part.match(/^(\w+):(\w+)\(([\w,]+)\)$/);
      if (join) {
        const [, alias, table, fields] = join;
        const target = (this.tables[table!] ?? []).find((t) => t.id === r[`${alias}_id`]);
        out[alias!] = target ? Object.fromEntries(fields!.split(",").map((f) => [f, target[f]])) : null;
      } else out[part] = r[part];
    }
    return out;
  }

  private run(): unknown {
    this.log.push(`${this.patch ? "update" : "select"} ${this.table}`);
    let rows = visible(this.tables, this.table, this.uid).filter((r) => this.filters.every((f) => f(r)));
    if (this.patch) for (const r of rows) Object.assign(r, this.patch);
    if (this.sort) {
      const { col, asc } = this.sort;
      rows = [...rows].sort((a, b) => String(a[col]).localeCompare(String(b[col])) * (asc ? 1 : -1));
    }
    rows = rows.slice(0, this.max);
    const data = rows.map((r) => this.project(r));
    if (this.one) return data[0] ?? null;
    return data;
  }

  then<A = { data: unknown; error: null }, B = never>(ok?: ((v: { data: unknown; error: null }) => A | PromiseLike<A>) | null, bad?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return Promise.resolve({ data: this.run(), error: null }).then(ok, bad);
  }
}

/** A client acting as `uid`. `log` records each query, for checks on what was read. */
export function fakeSupabase(tables: Tables, uid: string) {
  const log: string[] = [];
  return { from: (table: string) => new Query(tables, table, uid, log), log };
}
