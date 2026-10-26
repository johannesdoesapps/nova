/**
 * The usage ledger in the real migrations, on an in-process Postgres (PGlite):
 * reservations, duplicate submissions, requests in flight, refunds, tamper
 * resistance and admin-only diagnostics.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let db: PGlite;

async function as<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false); set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

/** As the server (service role): usage records are written by the server, never by the user's own session. */
async function asServer<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user}', false);`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

type Reserve = { ok: boolean; reason?: string; scope?: string; used?: number };
const reserve = (user: string, id: string, units: number, limits: [number, number] = [15, 100]) =>
  as(user, async () => (await db.query<{ r: Reserve }>("select public.usage_reserve($1, $2, $3, $4, 'chat', 'm') as r", [id, units, limits[0], limits[1]])).rows[0]!.r);
const finish = (user: string, id: string, state: "settled" | "released") => as(user, () => db.query("select public.usage_finish($1, $2)", [id, state]));
const charge = (user: string, id: string, units: number, status = "success") =>
  asServer(user, () => db.query("insert into public.model_runs (model_id, status, request_id, units) values ('m', $1, $2, $3)", [status, id, units]));

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
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(join(dir, f), "utf8"));
  await db.exec(`
    grant usage on schema public to anon, authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    insert into auth.users (id, email) values ('${ALICE}', 'alice@example.com'), ('${BOB}', 'bob@example.com');
  `);
}, 60_000);

beforeEach(async () => {
  await db.exec("delete from public.usage_holds; delete from public.model_runs; delete from public.admins; delete from public.usage_credit_events; delete from public.usage_credits;");
});

describe("usage ledger", () => {
  it("reserves within the allowance and refuses what would exceed it", async () => {
    expect((await reserve(ALICE, rid(1), 1)).ok).toBe(true);
    await charge(ALICE, rid(1), 1);
    await finish(ALICE, rid(1), "settled");
    const big = await reserve(ALICE, rid(2), 15);
    expect(big).toMatchObject({ ok: false, reason: "limit", scope: "window" });
    expect((await reserve(ALICE, rid(3), 14)).ok).toBe(true);
  });

  it("counts requests still in flight, so concurrent requests can't both pass", async () => {
    expect((await reserve(ALICE, rid(10), 10)).ok).toBe(true);
    // A second request arrives before the first is recorded.
    expect(await reserve(ALICE, rid(11), 10)).toMatchObject({ ok: false, scope: "window" });
    // Releasing the first (it failed) frees the units again.
    await finish(ALICE, rid(10), "released");
    expect((await reserve(ALICE, rid(11), 10)).ok).toBe(true);
  });

  it("refuses a duplicate submission, before and after it was charged", async () => {
    expect((await reserve(ALICE, rid(20), 1)).ok).toBe(true);
    expect(await reserve(ALICE, rid(20), 1)).toMatchObject({ ok: false, reason: "duplicate" });
    await charge(ALICE, rid(20), 1);
    await finish(ALICE, rid(20), "settled");
    expect(await reserve(ALICE, rid(20), 1)).toMatchObject({ ok: false, reason: "duplicate" });
    const runs = await db.query<{ n: number }>(`select count(*)::int as n from public.model_runs where request_id = '${rid(20)}'`);
    expect(runs.rows[0]!.n).toBe(1);
  });

  it("doesn't charge refunded runs (0 units) and keeps users' ledgers separate", async () => {
    await charge(ALICE, rid(30), 0, "error");
    await charge(BOB, rid(31), 15);
    const a = await as(ALICE, async () => (await db.query<{ window_used: string }>("select * from public.usage_status()")).rows[0]!);
    const b = await as(BOB, async () => (await db.query<{ window_used: string }>("select * from public.usage_status()")).rows[0]!);
    expect(Number(a.window_used)).toBe(0);
    expect(Number(b.window_used)).toBe(15);
    expect((await reserve(ALICE, rid(32), 15)).ok).toBe(true);
  });

  it("applies the weekly cap before the window", async () => {
    expect(await reserve(ALICE, rid(40), 5, [150, 4])).toMatchObject({ ok: false, scope: "week" });
  });

  it("can't be tampered with by the user", async () => {
    // Negative charges are rejected.
    await expect(charge(ALICE, rid(50), -100)).rejects.toThrow(/units_nonnegative/);
    // A backdated run gets the server's time, so it can't move the window start.
    await asServer(ALICE, () => db.query("insert into public.model_runs (model_id, status, units, created_at) values ('m', 'success', 1, now() - interval '4 hours 59 minutes')"));
    const r = await db.query<{ age: number }>("select extract(epoch from now() - created_at)::int as age from public.model_runs");
    expect(r.rows[0]!.age).toBeLessThan(5);
    // Holds can't be written or deleted directly, and runs can't be deleted.
    await reserve(ALICE, rid(51), 5);
    await as(ALICE, async () => {
      await db.query("delete from public.usage_holds");
      await db.query("update public.usage_holds set units = 0");
      await db.query("delete from public.model_runs");
    });
    const held = await db.query<{ units: string }>(`select units from public.usage_holds where request_id = '${rid(51)}'`);
    expect(Number(held.rows[0]!.units)).toBe(5);
    expect((await db.query("select * from public.model_runs")).rows).toHaveLength(1);
    // Another user's hold can't be released.
    await finish(BOB, rid(51), "released");
    const state = await db.query<{ state: string }>(`select state from public.usage_holds where request_id = '${rid(51)}'`);
    expect(state.rows[0]!.state).toBe("active");
  });

  it("ignores expired holds", async () => {
    expect((await reserve(ALICE, rid(60), 15)).ok).toBe(true);
    await db.exec(`update public.usage_holds set expires_at = now() - interval '1 second' where request_id = '${rid(60)}'`);
    expect((await reserve(ALICE, rid(61), 15)).ok).toBe(true);
  });

  it("shows request diagnostics to administrators only, without prompts", async () => {
    await asServer(ALICE, () => db.query("insert into public.model_runs (model_id, status, units, prompt, routing_reason, request_id) values ('m', 'success', 1, 'secret prompt', 'Auto chose m', $1)", [rid(70)]));
    await expect(as(BOB, () => db.query("select * from public.admin_request_log_v2(10, null)"))).rejects.toThrow(/Administrators only/);
    await db.exec(`insert into public.admins (user_id) values ('${BOB}')`);
    const rows = (await as(BOB, () => db.query<Record<string, unknown>>("select * from public.admin_request_log_v2(10, null)"))).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_email: "alice@example.com", routing_reason: "Auto chose m", request_id: rid(70) });
    expect(JSON.stringify(rows[0])).not.toContain("secret prompt");
  });
});

type Reserve5 = Reserve & { credit?: boolean; credits?: number; resets_at?: string; covered?: string; limit?: number };
const reserve5 = (user: string, id: string, units: number, o: { window?: number; week?: number; top?: boolean; topLimit?: number | null; credits?: boolean } = {}) =>
  as(user, async () =>
    (
      await db.query<{ r: Reserve5 }>(
        "select public.usage_reserve_v5($1, $2, $3, $4, 0, 0, null, null, $5, 0, 0, null, 0, 0, 'chat', 'm', 180, null, null, $5, $6, $7) as r",
        [id, units, o.window ?? 1e9, o.week ?? 1e9, o.top ?? false, o.topLimit ?? null, o.credits ?? false],
      )
    ).rows[0]!.r,
  );
// Runs are stamped with the server's time on insert, so an older run is moved back afterwards, as the server.
const chargeAt = async (user: string, id: string, units: number, daysAgo: number, tier = "standard") => {
  await asServer(user, () => db.query("insert into public.model_runs (model_id, status, request_id, units, model_tier) values ('m', 'success', $1, $2, $3)", [id, units, tier]));
  if (daysAgo) await db.query(`update public.model_runs set created_at = now() - interval '${daysAgo} days' where request_id = $1`, [id]);
};

describe("usage v5 (Claude-style limits)", () => {
  it("counts the week from the account's fixed weekly reset, not the last 7 days", async () => {
    await db.exec(`update auth.users set created_at = now() - interval '10 days' where id = '${ALICE}'`);
    await chargeAt(ALICE, rid(500), 50, 5); // before this week started (3 days ago)
    await chargeAt(ALICE, rid(501), 5, 1);
    const r = await reserve5(ALICE, rid(502), 10, { week: 60 });
    expect(r).toMatchObject({ ok: true });
    const over = await reserve5(ALICE, rid(503), 50, { week: 60 });
    expect(over).toMatchObject({ ok: false, scope: "week" });
    // Resets 7 days after this week began: 4 days from now.
    expect(Date.parse(over.resets_at!) - Date.now()).toBeGreaterThan(3.9 * 86_400_000);
    expect(Date.parse(over.resets_at!) - Date.now()).toBeLessThan(4.1 * 86_400_000);
  });

  it("applies the separate weekly limit to premium models only", async () => {
    await chargeAt(ALICE, rid(510), 40, 0, "premium");
    expect(await reserve5(ALICE, rid(511), 40, { top: true, topLimit: 60 })).toMatchObject({ ok: false, scope: "top_week", limit: 60 });
    expect((await reserve5(ALICE, rid(512), 1, { top: false, topLimit: 60 })).ok).toBe(true);
  });

  it("pays with extra usage over a limit, only when allowed, and keeps it out of the plan's limits", async () => {
    await chargeAt(ALICE, rid(520), 10, 0);
    expect(await reserve5(ALICE, rid(521), 5, { window: 10, credits: true })).toMatchObject({ ok: false, scope: "window", credits: 0 });
    // Bought credits arrive from the payment webhook (service role); the same session counts once.
    await db.query("select public.usage_credit_add($1, 20, 5, 'cs_1')", [ALICE]);
    await db.query("select public.usage_credit_add($1, 20, 5, 'cs_1')", [ALICE]);
    expect(await reserve5(ALICE, rid(522), 5, { window: 10, credits: false })).toMatchObject({ ok: false });
    expect(await reserve5(ALICE, rid(523), 5, { window: 10, credits: true })).toMatchObject({ ok: true, credit: true, covered: "window" });
    await as(ALICE, () => db.query("select public.usage_credit_settle($1, 7)", [rid(523)]));
    const st = await as(ALICE, async () => (await db.query<{ window_used: string; credits: string }>("select * from public.usage_status_v2()")).rows[0]!);
    expect(Number(st.credits)).toBe(13);
    expect(Number(st.window_used)).toBe(10);
    // Turned off: credits aren't used.
    await as(ALICE, () => db.query("select public.usage_credits_set_auto(false)"));
    expect(await reserve5(ALICE, rid(524), 5, { window: 10, credits: true })).toMatchObject({ ok: false, credits: 13 });
  });

  it("lets nobody but the server add credits or change a balance", async () => {
    await expect(as(ALICE, () => db.query("select public.usage_credit_add($1, 1000, 0, 'free')", [ALICE]))).rejects.toThrow();
    await expect(as(ALICE, () => db.query("insert into public.usage_credits (user_id, balance) values ($1, 1000)", [ALICE]))).rejects.toThrow();
    await db.query("select public.usage_credit_add($1, 10, 5, 'cs_2')", [ALICE]);
    await as(ALICE, () => db.query("update public.usage_credits set balance = 9999 where user_id = $1", [ALICE]));
    await as(ALICE, () => db.query("select public.usage_credit_settle($1, -500)", [rid(530)]));
    expect(Number((await db.query<{ balance: string }>("select balance from public.usage_credits where user_id = $1", [ALICE])).rows[0]!.balance)).toBe(10);
    // Bob can't see Alice's balance.
    expect((await as(BOB, () => db.query("select * from public.usage_credits"))).rows).toHaveLength(0);
  });
});
