/**
 * Acceptance of the Terms of Service and Privacy Policy (the real migrations
 * on PGlite): recorded at email sign-up, added by the user later, and never
 * changed or deleted by them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CAROL = "33333333-3333-4333-8333-333333333333";
let db: PGlite;

async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params).then((r) => r.rows);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    -- Like Supabase: new tables are granted to the API roles unless a migration says otherwise.
    alter default privileges in schema public grant all on tables to anon, authenticated;
  `);
  const migrations = join(__dirname, "..", "supabase", "migrations");
  for (const f of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(join(migrations, f), "utf8"));
  await db.exec(`insert into auth.users (id, email) values ('${ALICE}', 'alice@example.com'), ('${BOB}', 'bob@example.com');`);
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${CAROL}', 'carol@example.com', '{"display_name": "Carol", "terms_version": "2026-10-20"}');`);
}, 60_000);
afterAll(() => db.close());

describe("legal acceptances", () => {
  it("are recorded when someone signs up with email after ticking both boxes", async () => {
    const rows = await as(CAROL, () => q<{ document: string; version: string; method: string }>("select document, version, method from public.legal_acceptances order by document"));
    expect(rows).toEqual([
      { document: "privacy", version: "2026-10-20", method: "signup" },
      { document: "terms", version: "2026-10-20", method: "signup" },
    ]);
    expect(await as(ALICE, () => q("select * from public.legal_acceptances"))).toEqual([]);
  });

  it("can be added by their owner only, and never changed or deleted", async () => {
    await as(ALICE, () => q("insert into public.legal_acceptances (document, version) values ('terms', 'v2'), ('privacy', 'v2')"));
    expect(await as(ALICE, () => q("select count(*)::int as n from public.legal_acceptances"))).toEqual([{ n: 2 }]);
    await expect(as(ALICE, () => q(`insert into public.legal_acceptances (user_id, document, version) values ('${BOB}', 'terms', 'v2')`))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q("update public.legal_acceptances set version = 'v9'"))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q("delete from public.legal_acceptances"))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q("insert into public.legal_acceptances (document, version) values ('cookies', 'v2')"))).rejects.toThrow(/check constraint/);
    expect(await as(BOB, () => q("select * from public.legal_acceptances"))).toEqual([]);
  });
});
