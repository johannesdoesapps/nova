/**
 * Deleting your own account (delete_own_account), run against the real
 * migrations on PGlite: only the caller's account goes, with everything in it;
 * administrators and people on a paid plan are refused.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const PAYING = "44444444-4444-4444-8444-444444444444";
let db: PGlite;

async function as<T>(user: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user ?? ""}', false); set role ${user ? "authenticated" : "anon"};`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => db.query<T>(sql, params).then((r) => r.rows);
const remove = (user: string | null) => as(user, () => q("select public.delete_own_account()"));
const users = async () => (await q<{ id: string }>("select id from auth.users order by id")).map((r) => r.id);

describe("delete_own_account", () => {
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
      alter default privileges in schema public grant all on tables to anon, authenticated;
    `);
    const migrations = join(__dirname, "..", "supabase", "migrations");
    for (const f of readdirSync(migrations)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await db.exec(readFileSync(join(migrations, f), "utf8"));
    await db.exec(`
      insert into auth.users (id, email) values ('${ALICE}', 'a@x.test'), ('${BOB}', 'b@x.test'), ('${ADMIN}', 'admin@x.test'), ('${PAYING}', 'pay@x.test');
      insert into public.admins (user_id) values ('${ADMIN}');
      insert into public.subscriptions (user_id, plan, status) values ('${PAYING}', 'pro', 'active');
    `);
    for (const u of [ALICE, BOB]) await as(u, () => q("insert into public.code_projects (name, template) values ('P', 'blank')"));
  }, 60_000);
  afterAll(() => db.close());

  it("can't be called without signing in", async () => {
    await expect(remove(null)).rejects.toThrow(/permission denied|Sign in/);
    expect(await users()).toHaveLength(4);
  });

  it("refuses administrators and people on a paid plan, deleting nothing", async () => {
    await expect(remove(ADMIN)).rejects.toThrow(/Administrators can't delete/);
    await expect(remove(PAYING)).rejects.toThrow(/Cancel your paid plan first/);
    expect(await users()).toHaveLength(4);
  });

  it("deletes only the caller, with their data; others keep theirs", async () => {
    await remove(ALICE);
    expect(await users()).toEqual([BOB, ADMIN, PAYING].sort());
    expect(await q("select user_id from public.code_projects")).toEqual([{ user_id: BOB }]);
  });

  it("a cancelled paid plan no longer blocks deletion", async () => {
    await q(`update public.subscriptions set status = 'canceled' where user_id = '${PAYING}'`);
    await remove(PAYING);
    expect(await users()).not.toContain(PAYING);
  });
});
