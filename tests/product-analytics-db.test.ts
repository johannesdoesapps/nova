/**
 * The feedback and product-event tables and the admin metrics function, on the
 * real migrations (PGlite): owner-only access, no editing events, size and
 * name limits, administrators only, and figures computed from seeded data with
 * internal and test accounts left out.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const TESTER = "44444444-4444-4444-8444-444444444444";
const NEW = "55555555-5555-4555-8555-555555555555";
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
    alter default privileges in schema public grant all on tables to anon, authenticated;
  `);
  const dir = join(__dirname, "..", "supabase", "migrations");
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await db.exec(readFileSync(join(dir, f), "utf8"));
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ALICE}', 'alice@example.com'), ('${BOB}', 'bob@example.com'), ('${ADMIN}', 'admin@example.com'),
      ('${TESTER}', 'free-e2e@orbis.invalid'), ('${NEW}', 'new@example.com')
    on conflict do nothing;
    insert into public.profiles (id) values ('${ALICE}'), ('${BOB}'), ('${ADMIN}'), ('${TESTER}'), ('${NEW}') on conflict do nothing;
    update public.profiles set created_at = now() - interval '40 days' where id in ('${ALICE}', '${BOB}', '${ADMIN}', '${TESTER}');
    update public.profiles set created_at = now() - interval '2 days' where id = '${NEW}';
    insert into public.admins (user_id) values ('${ADMIN}');
  `);
}, 60_000);
afterAll(() => db.close());

describe("feedback", () => {
  it("is the user's own: others can't read, change or add it for them", async () => {
    await as(ALICE, () => q("insert into public.response_feedback (feature, subject_id, rating, comment) values ('chat', 'm1', 'incorrect', 'Wrong date')"));
    expect(await as(BOB, () => q("select * from public.response_feedback"))).toEqual([]);
    await as(BOB, () => q("update public.response_feedback set rating = 'helpful'"));
    await as(BOB, () => q("delete from public.response_feedback"));
    expect(await as(ALICE, () => q("select rating, comment from public.response_feedback"))).toEqual([{ rating: "incorrect", comment: "Wrong date" }]);
    await expect(as(BOB, () => q(`insert into public.response_feedback (user_id, feature, subject_id, rating) values ('${ALICE}', 'chat', 'm2', 'helpful')`))).rejects.toThrow(/row-level security/);
  });

  it("keeps one rating per result, which the user can change", async () => {
    await as(ALICE, () =>
      q("insert into public.response_feedback (feature, subject_id, rating) values ('chat', 'm1', 'helpful') on conflict (user_id, feature, subject_id) do update set rating = excluded.rating"),
    );
    expect(await as(ALICE, () => q("select rating from public.response_feedback where subject_id = 'm1'"))).toEqual([{ rating: "helpful" }]);
  });

  it("accepts only the listed ratings and short comments", async () => {
    await expect(as(ALICE, () => q("insert into public.response_feedback (feature, subject_id, rating) values ('chat', 'x', 'amazing')"))).rejects.toThrow(/check/);
    await expect(as(ALICE, () => q("insert into public.response_feedback (feature, subject_id, rating, comment) values ('chat', 'y', 'other', $1)", ["x".repeat(1001)]))).rejects.toThrow(/check/);
  });
});

describe("product events", () => {
  it("can be added for yourself only, and never edited or deleted", async () => {
    await as(ALICE, () => q(`insert into public.product_events (event, props) values ('workflow_started', '{"template":"research-topic"}')`));
    await expect(as(BOB, () => q(`insert into public.product_events (user_id, event) values ('${ALICE}', 'useful_result')`))).rejects.toThrow(/row-level security/);
    await as(ALICE, () => q("update public.product_events set event = 'useful_result'"));
    await as(ALICE, () => q("delete from public.product_events"));
    expect(await as(ALICE, () => q("select event from public.product_events"))).toEqual([{ event: "workflow_started" }]);
    expect(await as(BOB, () => q("select * from public.product_events"))).toEqual([]);
  });

  it("only takes known events with small properties", async () => {
    await expect(as(ALICE, () => q("insert into public.product_events (event) values ('prompt_text')"))).rejects.toThrow(/check/);
    await expect(as(ALICE, () => q("insert into public.product_events (event, props) values ('useful_result', $1)", [JSON.stringify({ x: "y".repeat(600) })]))).rejects.toThrow(/check/);
    await expect(as(ALICE, () => q("insert into public.product_events (event, props) values ('useful_result', '[1]')"))).rejects.toThrow(/check/);
  });
});

describe("admin metrics", () => {
  it("are for administrators only", async () => {
    await expect(as(ALICE, () => q("select public.admin_product_metrics(now() - interval '90 days')"))).rejects.toThrow(/Administrators only/);
  });

  it("are computed from real records, leaving out admins and test accounts", async () => {
    await db.exec(`
      reset role;
      insert into public.model_runs (user_id, model_id, status, purpose) values
        ('${ALICE}', 'a1', 'success', 'chat'), ('${ALICE}', 'a2', 'success', 'chat'), ('${ALICE}', 'a3', 'success', 'council'),
        ('${BOB}', 'b1', 'error', 'chat'), ('${NEW}', 'n1', 'success', 'chat'), ('${ADMIN}', 'x1', 'success', 'chat'), ('${TESTER}', 't1', 'success', 'chat');
      -- Inserts are stamped with the current time; set the history afterwards.
      update public.model_runs set created_at = case model_id
        when 'a1' then now() - interval '40 days' + interval '10 minutes'
        when 'a2' then now() - interval '20 days'
        when 'a3' then now() - interval '1 day'
        when 'b1' then now() - interval '39 days'
        when 'n1' then now() - interval '2 days' + interval '30 minutes'
        else now() - interval '1 day' end;
      insert into public.product_events (user_id, event, props) values
        ('${ALICE}', 'workflow_completed', '{"template":"research-topic"}'),
        ('${BOB}', 'usage_limit_reached', '{"scope":"day"}'),
        ('${TESTER}', 'usage_limit_reached', '{"scope":"day"}');
    `);
    const [{ m }] = await as(ADMIN, () => q<{ m: Record<string, unknown> }>("select public.admin_product_metrics(now() - interval '90 days') as m"));
    expect(m.people).toBe(3); // Alice, Bob, New
    expect(m.signups).toBe(3);
    expect(m.first_prompt).toBe(3);
    expect(m.activated).toBe(2); // Bob's only request failed
    expect(m.retention).toEqual({ d7_cohort: 2, d7_returned: 1, d30_cohort: 2, d30_returned: 1 }); // Alice came back after day 7 and after day 30; Bob never did
    expect(m.returned_after_gap).toBe(1); // Alice came back after weeks away
    expect(m.features).toEqual({ chat: 2, council: 1 });
    expect(m.workflows).toEqual([{ template: "research-topic", started: 1, completed: 1, failed: 0 }]);
    expect(m.limits).toEqual([{ scope: "day", times: 1, users: 1 }]); // the test account's isn't counted
    expect(m.feedback).toEqual({ helpful: 1 });
    expect(m.paid).toEqual({ live_subscriptions: 0, any_paid_ever: 0 });
    expect(Number(m.minutes_to_first_result)).toBeGreaterThan(9);
  });
});
