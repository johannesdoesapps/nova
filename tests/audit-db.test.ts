// The database fixes from the 26 October 2026 audit (supabase/migrations/20261109000000_audit_hardening.sql), on
// all migrations with Supabase's default privileges (anon and authenticated get everything unless revoked).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";
const MAL = "22222222-2222-4222-8222-222222222222";
const CAROL = "33333333-3333-4333-8333-333333333333";
let db: PGlite;
async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
  try { return await fn(); } finally { await db.exec("reset role"); }
}
// usage_reserve_v5 positional call
const reserve = (rid: string, o: { units?: number; win?: number; est?: number; budget?: number | null; site?: number | null; credits?: boolean }) =>
  db.query<{ r: { ok: boolean; reason?: string; scope?: string; credit?: boolean } }>(
    `select public.usage_reserve_v5($1::uuid, $2, $3, 1e9, $4, 0, $5, null, false, 0, 0, null, 0, 0, null, null, 600, null, $6, false, null, $7) as r`,
    [rid, o.units ?? 1, o.win ?? 1e9, o.est ?? 0, o.budget ?? null, o.site ?? null, o.credits ?? false],
  ).then((x) => x.rows[0]!.r);
const uuid = () => crypto.randomUUID();

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  `);
  const dir = join(__dirname, "..", "supabase", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(join(dir, f), "utf8"));
  await db.exec(`grant usage on schema public to anon, authenticated;
    insert into auth.users (id, email) values ('${ALICE}','a@x.io'), ('${MAL}','m@x.io'), ('${CAROL}','c@x.io');`);
}, 60_000);

describe("audit hardening (database)", () => {
  it("ORB-001: a user can't write their own usage record, so can't trip the site-wide cap for the month", async () => {
    await expect(as(MAL, () => db.query(`insert into public.model_runs (model_id, status, units, estimated_cost) values ('openai:x','success',1,999999)`))).rejects.toThrow(/permission denied|row-level security/);
    expect((await as(ALICE, () => reserve(uuid(), { est: 0.01, site: 5000 }))).ok).toBe(true);
  });

  it("ORB-001: nor insert a dummy run to stop an in-flight hold from counting", async () => {
    const r1 = uuid();
    expect((await as(CAROL, () => reserve(r1, { est: 0.6, budget: 1 }))).ok).toBe(true);
    await expect(as(CAROL, () => db.query(`insert into public.model_runs (model_id, status, units, request_id) values ('openai:x','success',0,$1)`, [r1]))).rejects.toThrow(/permission denied|row-level security/);
    expect(await as(CAROL, () => reserve(uuid(), { est: 0.6, budget: 1 }))).toMatchObject({ ok: false, reason: "budget" });
    await as(CAROL, () => db.query("select public.usage_finish($1, 'released')", [r1]));
  });

  it("ORB-002: one reservation with a huge estimate can't hold the whole site's budget", async () => {
    const mrid = uuid();
    expect((await as(MAL, () => reserve(mrid, { units: 0, est: 999999, site: null }))).ok).toBe(true);
    const held = await db.query<{ e: string }>("select est_cost_usd::text as e from public.usage_holds where request_id = $1", [mrid]);
    expect(Number(held.rows[0]!.e)).toBe(5);
    expect((await as(ALICE, () => reserve(uuid(), { est: 0.01, site: 5000 }))).ok).toBe(true);
    await as(MAL, () => db.query("select public.usage_finish($1, 'released')", [mrid]));
  });

  it("ORB-015: Mimic's rows go with the account", async () => {
    const GONE = "44444444-4444-4444-8444-444444444444";
    await db.exec(`insert into auth.users (id, email) values ('${GONE}','g@x.io')`);
    await as(GONE, () => db.query(`insert into public.mimic_documents (name, text, sha256, source) values ('inv', 'ACME invoice', repeat('a',64), 'paste')`));
    await as(GONE, () => db.query(`insert into public.mimic_events (kind, summary) values ('workflow', 'made one')`));
    await db.exec(`delete from auth.users where id = '${GONE}'`);
    const left = await db.query<{ n: number }>(`select (select count(*)::int from public.mimic_documents where user_id = '${GONE}') + (select count(*)::int from public.mimic_events where user_id = '${GONE}') as n`);
    expect(left.rows[0]!.n).toBe(0);
  });

  it("ORB-016: signed-in and anonymous users can't TRUNCATE (which ignores row-level security)", async () => {
    await as(ALICE, () => db.query(`insert into public.mimic_events (kind, summary) values ('x','alice event')`));
    for (const t of ["mimic_events", "mimic_ledger", "bastion_workspace_roles"]) await expect(as(MAL, () => db.query(`truncate public.${t}`)), t).rejects.toThrow(/permission denied/);
    const n = await db.query<{ n: number }>(`select count(*)::int n from public.mimic_events where user_id = '${ALICE}'`);
    expect(n.rows[0]!.n).toBe(1);
  });

  it("ORB-011: the ownership token can't be rewritten; the verification columns still can", async () => {
    const t = await as(MAL, () => db.query<{ id: string }>(`insert into public.security_targets (hostname, token) values ('victim.example', 'orbis-verify-0123456789abcdef0123456789abcdef') returning id`));
    const id = t.rows[0]!.id;
    await expect(as(MAL, () => db.query(`update public.security_targets set token = 'v=spf1 include:_spf.google.com' where id = $1`, [id]))).rejects.toThrow(/permission denied/);
    const ok = await as(MAL, () => db.query(`update public.security_targets set verified_at = null, verified_method = null where id = $1`, [id]));
    expect(ok.affectedRows).toBe(1);
  });

  // Still open (need reservations made only by the server; see ORB-002 and ORB-014 in the report).
  it.todo("ORB-002: a user can't release or settle their own credit hold to overdraw extra usage");
  it.todo("ORB-014: workspace reservations take their limits from the server, not the caller");
});
