/**
 * The Team plan's rules in the real migrations, on an in-process Postgres (PGlite): who can invite, seat limits,
 * only the invited address can join, one team per person, and members can't see other teams.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CAROL = "33333333-3333-4333-8333-333333333333";
const DAN = "44444444-4444-4444-8444-444444444444";
let db: PGlite;
let team: string;

async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}
const call = (user: string, sql: string, params: unknown[] = []) => as(user, () => db.query<Record<string, unknown>>(sql, params));
const fails = async (p: Promise<unknown>, re: RegExp) => {
  await expect(p).rejects.toThrow(re);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz not null default now());
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  const dir = join(__dirname, "..", "supabase", "migrations");
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync(join(dir, f), "utf8"));
  await db.exec(`
    grant usage on schema public to anon, authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    insert into auth.users (id, email) values ('${OWNER}', 'owner@example.com'), ('${BOB}', 'bob@example.com'), ('${CAROL}', 'carol@example.com'), ('${DAN}', 'dan@example.com');
  `);
}, 60_000);

describe("team plan rules", () => {
  it("creates a team with its owner as the first member, but gives nothing until paid", async () => {
    team = (await call(OWNER, "select public.team_create('Acme', 'max', 'month') as id")).rows[0]!.id as string;
    expect(team).toBeTruthy();
    const members = await call(OWNER, "select user_id, role from public.team_members where team_id = $1", [team]);
    expect(members.rows).toEqual([{ user_id: OWNER, role: "owner" }]);
    // No invitations while the team has no active subscription.
    await fails(call(OWNER, "select public.team_invite_create($1, 'bob@example.com', 'h1')", [team]), /no active subscription/);
  });

  it("lets only the owner invite, and never beyond the seats", async () => {
    await db.exec(`update public.teams set status = 'active', seats = 2 where id = '${team}'`); // as the Stripe webhook would
    await fails(call(BOB, "select public.team_invite_create($1, 'carol@example.com', 'hx')", [team]), /Only the team owner/);
    await call(OWNER, "select public.team_invite_create($1, 'bob@example.com', 'hash-bob')", [team]);
    // Owner + one open invitation = 2 seats in use.
    await fails(call(OWNER, "select public.team_invite_create($1, 'carol@example.com', 'hash-carol')", [team]), /All seats are in use/);
  });

  it("lets only the invited address accept", async () => {
    await fails(call(CAROL, "select public.team_accept_invite('hash-bob')"), /different email address/);
    await call(BOB, "select public.team_accept_invite('hash-bob')");
    await fails(call(BOB, "select public.team_accept_invite('hash-bob')"), /no longer valid/);
    const roster = await call(BOB, "select email, role from public.team_roster()");
    expect(roster.rows).toEqual([
      { email: "owner@example.com", role: "owner" },
      { email: "bob@example.com", role: "member" },
    ]);
  });

  it("keeps members out of other teams and away from invitations", async () => {
    await fails(call(BOB, "select public.team_create('Bob team', 'pro', 'month')"), /already in a team/);
    expect((await call(CAROL, "select * from public.teams")).rows).toEqual([]);
    expect((await call(CAROL, "select * from public.team_members")).rows).toEqual([]);
    expect((await call(BOB, "select * from public.team_invites")).rows).toEqual([]);
    // Members can't add themselves or raise seats directly: writes only go through the functions.
    await fails(call(CAROL, `insert into public.team_members (team_id, user_id) values ('${team}', '${CAROL}')`), /row-level security/);
    await call(BOB, "update public.teams set seats = 100");
    expect((await db.query<{ seats: number }>(`select seats from public.teams where id = '${team}'`)).rows[0]!.seats).toBe(2);
  });

  it("frees a seat when someone leaves or is removed; the owner can't be removed", async () => {
    await fails(call(OWNER, "select public.team_remove_member($1, $2)", [team, OWNER]), /owner can't leave/);
    await fails(call(CAROL, "select public.team_remove_member($1, $2)", [team, BOB]), /Only the owner/);
    await call(BOB, "select public.team_remove_member($1, $2)", [team, BOB]);
    await call(OWNER, "select public.team_invite_create($1, 'dan@example.com', 'hash-dan')", [team]);
    await call(DAN, "select public.team_accept_invite('hash-dan')");
    expect((await db.query(`select count(*)::int as n from public.team_members where team_id = '${team}'`)).rows[0]).toEqual({ n: 2 });
  });
});
