/**
 * Deleting an account, on PGlite with every real migration: what stops it (a plan that renews, in Orbis or at
 * Stripe; a team others rely on; an administrator role), what's cleared first (computers, published sites, tables not
 * linked to the user), and that deleting the sign-in user takes the account's data with it while payment records stay
 * without the link to the person. Also checks every table that refers to a user is deleted or cleared with it, or is
 * on the explicit list, so a new table can't quietly keep data behind or block deletion.
 */
import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALICE, ALICE_PROJECT, ALICE_PROJECT_2, BOB, asUser, orchDb } from "./helpers/orch-db";

vi.mock("server-only", () => ({}));

const { deleteAccount, deletionBlockers, UNLINKED_TABLES } = await import("@/lib/account-deletion");

let db: PGlite;
/** The user's own session (row-level security applies). */
const as = (id: string) => asUser(db, id) as unknown as SupabaseClient;
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const noop = async () => {};

/** The service-role client, as far as deletion uses it: deleting the sign-in user (as Supabase Auth does). */
function fakeAdmin(fail = false) {
  const deleted: string[] = [];
  const admin = {
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          if (fail) return { data: null, error: { message: "boom" } };
          await db.query("delete from auth.users where id = $1", [id]);
          deleted.push(id);
          return { data: {}, error: null };
        },
      },
    },
  } as unknown as SupabaseClient;
  return { admin, deleted };
}

const renewingPlan = (user: string) =>
  q("insert into public.subscriptions (user_id, plan, status, stripe_customer_id, stripe_subscription_id, cancel_at_period_end) values ($1, 'pro', 'active', 'cus_1', 'sub_1', false)", [user]);

beforeAll(async () => {
  db = await orchDb();
}, 120_000);
afterAll(() => db.close());
beforeEach(async () => {
  // Alice is an administrator in the shared fixture; most of these tests are about an ordinary account.
  await db.exec(`reset role; delete from public.subscriptions; delete from public.team_members; delete from public.teams; delete from public.admins where user_id = '${ALICE}';`);
});

describe("every reference to a user", () => {
  it("is deleted or cleared with the user, so nothing blocks deletion or keeps data behind", async () => {
    const rows = await q<{ tbl: string; col: string; action: string }>(`
      select c.conrelid::regclass::text as tbl, a.attname as col, c.confdeltype as action
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f' and c.confrelid = 'auth.users'::regclass`);
    expect(rows.length).toBeGreaterThan(30);
    expect(rows.filter((r) => r.action !== "c" && r.action !== "n")).toEqual([]);
    // Payment records are kept (the link is cleared), never deleted with the person.
    expect(rows.filter((r) => ["billing_ledger", "billing_disputes"].includes(r.tbl.replace(/^public\./, ""))).map((r) => r.action)).toEqual(["n", "n"]);
  });

  it("has a foreign key, or is deleted explicitly, or is listed here with the reason it stays", async () => {
    const loose = await q<{ t: string; c: string }>(`
      select c.table_name as t, c.column_name as c from information_schema.columns c
      join information_schema.tables tb on tb.table_schema = c.table_schema and tb.table_name = c.table_name and tb.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.data_type = 'uuid' and c.column_name in ('user_id', 'owner_id', 'created_by', 'actor_id', 'updated_by', 'member_id')
        and not exists (
          select 1 from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
          where k.contype = 'f' and k.conrelid = ('public.' || quote_ident(c.table_name))::regclass and a.attname = c.column_name)`);
    const intended: Record<string, string> = {
      "admin_audit.actor_id": "the record of what administrators did is kept",
      "orch_slots.owner_id": "a lease that expires within minutes",
    };
    const unexplained = loose.map((r) => `${r.t}.${r.c}`).filter((k) => !intended[k] && !(k.endsWith(".user_id") && UNLINKED_TABLES.includes(k.split(".")[0]!)));
    expect(unexplained).toEqual([]);
  });
});

describe("what stops a deletion", () => {
  it("nothing, for an account without a plan, a team or an admin role", async () => {
    expect(await deletionBlockers(as(ALICE), ALICE)).toEqual([]);
  });

  it("an administrator role", async () => {
    await q("insert into public.admins (user_id) values ($1)", [ALICE]);
    expect((await deletionBlockers(as(ALICE), ALICE)).map((b) => b.kind)).toEqual(["admin"]);
  });

  it("a plan that will renew or has a payment due, but not one already set to end", async () => {
    await renewingPlan(ALICE);
    expect((await deletionBlockers(as(ALICE), ALICE)).map((b) => b.kind)).toEqual(["subscription"]);
    await q("update public.subscriptions set cancel_at_period_end = true where user_id = $1", [ALICE]);
    expect(await deletionBlockers(as(ALICE), ALICE)).toEqual([]);
    // Set to end, but a payment is still being collected: Stripe would keep retrying the card.
    await q("update public.subscriptions set status = 'past_due' where user_id = $1", [ALICE]);
    expect((await deletionBlockers(as(ALICE), ALICE)).map((b) => b.kind)).toEqual(["subscription"]);
    await q("update public.subscriptions set cancel_at_period_end = false, status = 'canceled' where user_id = $1", [ALICE]);
    expect(await deletionBlockers(as(ALICE), ALICE)).toEqual([]);
  });

  it("a plan Stripe still charges even when Orbis's copy says it ended, and an unreachable Stripe", async () => {
    await q("insert into public.subscriptions (user_id, plan, status, stripe_customer_id, stripe_subscription_id, cancel_at_period_end) values ($1, 'free', 'canceled', 'cus_9', 'sub_old', false)", [ALICE]);
    const asked: string[] = [];
    const live = async (c: string) => (asked.push(c), [{ id: "sub_new", status: "active", cancel_at_period_end: false }]);
    expect((await deletionBlockers(as(ALICE), ALICE, live)).map((b) => b.kind)).toEqual(["subscription"]);
    expect(asked).toEqual(["cus_9"]);
    expect(await deletionBlockers(as(ALICE), ALICE, async () => [{ id: "sub_new", status: "canceled", cancel_at_period_end: false }])).toEqual([]);
    await expect(deletionBlockers(as(ALICE), ALICE, async () => { throw new Error("stripe down"); })).rejects.toThrow(/billing couldn't be checked/);
  });

  it("a team the account owns that still has other members, or a team plan that renews", async () => {
    const [{ id: team }] = await q<{ id: string }>("insert into public.teams (name, owner_id, plan, billing_interval, seats, status) values ('Acme', $1, 'pro', 'month', 2, 'inactive') returning id", [ALICE]);
    await q("insert into public.team_members (team_id, user_id, role) values ($1, $2, 'owner')", [team, ALICE]);
    expect(await deletionBlockers(as(ALICE), ALICE)).toEqual([]);
    await q("insert into public.team_members (team_id, user_id, role) values ($1, $2, 'member')", [team, BOB]);
    expect((await deletionBlockers(as(ALICE), ALICE)).map((b) => b.message)).toEqual(['Your team "Acme" still has other members. Remove them first.']);
    await q("update public.teams set status = 'active', stripe_subscription_id = 'sub_t', cancel_at_period_end = false where id = $1", [team]);
    expect((await deletionBlockers(as(ALICE), ALICE)).map((b) => b.kind)).toEqual(["team"]);
    // Bob is only a member: his account isn't blocked by Alice's team.
    expect(await deletionBlockers(as(BOB), BOB)).toEqual([]);
  });
});

describe("deleting an account", () => {
  it("is refused while something blocks it, and nothing is touched", async () => {
    await renewingPlan(ALICE);
    const { admin, deleted } = fakeAdmin();
    const stopped: string[] = [];
    await expect(deleteAccount({ db: as(ALICE), admin, userId: ALICE, stopComputer: async (id) => void stopped.push(id), takeDownSite: null })).rejects.toThrow(/Cancel it in Billing/);
    expect(deleted).toEqual([]);
    expect(stopped).toEqual([]);
  });

  it("keeps the account when a published site can't be taken down, and says which sites already went offline", async () => {
    const { admin, deleted } = fakeAdmin();
    await expect(
      deleteAccount({
        db: as(ALICE),
        admin,
        userId: ALICE,
        stopComputer: noop,
        takeDownSite: async (id) => {
          if (id === ALICE_PROJECT_2) throw new Error("host down");
          return true;
        },
      }),
    ).rejects.toThrow(/your account wasn't deleted\. 1 other site was already taken offline/);
    expect(deleted).toEqual([]);
    expect(await q("select id from auth.users where id = $1", [ALICE])).toHaveLength(1);
  });

  it("checks again just before deleting: a plan bought meanwhile still stops it", async () => {
    const { admin, deleted } = fakeAdmin();
    await expect(
      deleteAccount({ db: as(ALICE), admin, userId: ALICE, stopComputer: noop, takeDownSite: async () => (await renewingPlan(ALICE).catch(() => undefined), false) }),
    ).rejects.toThrow(/Cancel it in Billing/);
    expect(deleted).toEqual([]);
  });

  it("reports a failed sign-in deletion instead of claiming success", async () => {
    const { admin } = fakeAdmin(true);
    await expect(deleteAccount({ db: as(ALICE), admin, userId: ALICE, stopComputer: noop, takeDownSite: null })).rejects.toThrow(/couldn't be deleted/);
  });

  // Last: it deletes Alice.
  it("stops each project's computer, takes its site down, then deletes the account and all its data", async () => {
    await q("insert into public.billing_ledger (stripe_object_id, user_id, kind, plan, amount_usd, tax_usd, occurred_at) values ('in_test_1', $1, 'payment', 'pro', 20, 0, now())", [ALICE]);
    await q("insert into public.mimic_documents (user_id, name, text, sha256, source) values ($1, 'Invoice', 'Supplier: ACME', $2, 'paste')", [ALICE, "a".repeat(64)]);
    await q("insert into public.mimic_settings (user_id) values ($1)", [ALICE]);
    await q("insert into public.mimic_documents (user_id, name, text, sha256, source) values ($1, 'Bob doc', 'Keep me', $2, 'paste')", [BOB, "b".repeat(64)]);
    const { admin, deleted } = fakeAdmin();
    const stopped: string[] = [];
    const takenDown: string[] = [];
    const result = await deleteAccount({
      db: as(ALICE),
      admin,
      userId: ALICE,
      stopComputer: async (id) => void stopped.push(id),
      takeDownSite: async (id) => {
        takenDown.push(id);
        return id === ALICE_PROJECT; // only one of them was published
      },
    });
    expect(result).toEqual({ projects: 2, sitesRemoved: 1 });
    expect(stopped.sort()).toEqual([ALICE_PROJECT, ALICE_PROJECT_2].sort());
    expect(takenDown.sort()).toEqual([ALICE_PROJECT, ALICE_PROJECT_2].sort());
    expect(deleted).toEqual([ALICE]);
    await db.exec("reset role;");
    expect(await q("select id from public.code_projects where user_id = $1", [ALICE])).toEqual([]);
    expect(await q("select path from public.code_files where project_id = $1", [ALICE_PROJECT])).toEqual([]);
    expect(await q("select id from public.mimic_documents where user_id = $1", [ALICE])).toEqual([]);
    expect(await q("select user_id from public.mimic_settings where user_id = $1", [ALICE])).toEqual([]);
    expect(await q<{ user_id: string | null }>("select user_id from public.billing_ledger where stripe_object_id = 'in_test_1'")).toEqual([{ user_id: null }]);
    // Other people's data is untouched.
    expect(await q("select id from auth.users where id = $1", [BOB])).toHaveLength(1);
    expect(await q("select id from public.mimic_documents where user_id = $1", [BOB])).toHaveLength(1);
  });
});
