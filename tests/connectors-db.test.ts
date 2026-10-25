/**
 * Connector tables in the real migrations (PGlite): each user sees and
 * changes only their own connections; users can't set a connection's owner;
 * the action log is insert-and-read-own only. And the server's checks before
 * a confirmed action runs (write access, granted permission, valid details).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Bastion's controls as stored when an administrator hasn't changed anything (tests/bastion.test.ts covers the rest).
vi.mock("@/lib/bastion/controls", async () => ({ loadControls: async () => (await import("@/lib/bastion/policy")).DEFAULT_CONTROLS, invalidateControls: () => {} }));
vi.mock("server-only", () => ({}));
process.env.ORBIS_CONNECTOR_KEY = randomBytes(32).toString("base64");

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
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
    create role service_role nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    grant usage on schema public to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated;
  `);
  const dir = join(__dirname, "..", "supabase", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(join(dir, f), "utf8"));
  await db.exec(`insert into auth.users (id, email) values ('${ALICE}', 'a@x.test'), ('${BOB}', 'b@x.test');`);
}, 60_000);
afterAll(() => db.close());

describe("connector_accounts", () => {
  it("belongs to its owner only", async () => {
    await as(ALICE, () => q("insert into public.connector_accounts (connector_id, account_label, secret) values ('gmail', 'alice@x.test', 'v1.sealed')"));
    expect(await as(BOB, () => q("select * from public.connector_accounts"))).toEqual([]);
    await as(BOB, () => q("update public.connector_accounts set account_label = 'hacked'"));
    await as(BOB, () => q("delete from public.connector_accounts"));
    expect(await as(ALICE, () => q("select account_label from public.connector_accounts"))).toEqual([{ account_label: "alice@x.test" }]);
    // One connection per user and connector.
    await expect(as(ALICE, () => q("insert into public.connector_accounts (connector_id) values ('gmail')"))).rejects.toThrow(/duplicate key/);
  });

  it("lets reconnecting replace the connection in one upsert (as the API does)", async () => {
    await as(ALICE, () =>
      q("insert into public.connector_accounts (connector_id, status, account_label, secret) values ('slack', 'connected', 'v1', 'v1.a') on conflict (user_id, connector_id) do update set connector_id = excluded.connector_id, status = excluded.status, account_label = excluded.account_label, secret = excluded.secret"),
    );
    await as(ALICE, () =>
      q("insert into public.connector_accounts (connector_id, status, account_label, secret) values ('slack', 'connected', 'v2', 'v1.b') on conflict (user_id, connector_id) do update set connector_id = excluded.connector_id, status = excluded.status, account_label = excluded.account_label, secret = excluded.secret"),
    );
    expect(await as(ALICE, () => q("select account_label, secret from public.connector_accounts where connector_id = 'slack'"))).toEqual([{ account_label: "v2", secret: "v1.b" }]);
  });

  it("never lets a user set or change the owner, and checks values", async () => {
    await expect(as(BOB, () => q(`insert into public.connector_accounts (user_id, connector_id) values ('${ALICE}', 'slack')`))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q(`update public.connector_accounts set user_id = '${BOB}'`))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q("insert into public.connector_accounts (connector_id) values ('Bad Id!')"))).rejects.toThrow(/check constraint/);
    await expect(as(ALICE, () => q("update public.connector_accounts set ai_mode = 'always'"))).rejects.toThrow(/check constraint/);
    await expect(as(ALICE, () => q("update public.connector_accounts set status = 'connecting'"))).rejects.toThrow(/check constraint/);
    expect(await q("select has_table_privilege('anon', 'public.connector_accounts', 'select') as a")).toEqual([{ a: false }]);
  });
});

describe("connector_actions log", () => {
  it("is written and read by its owner only, and can't be edited", async () => {
    await as(ALICE, () => q("insert into public.connector_actions (connector_id, action, status, summary) values ('gmail', 'gmail_create_draft', 'done', 'Draft saved')"));
    await expect(as(BOB, () => q(`insert into public.connector_actions (user_id, connector_id, action, status) values ('${ALICE}', 'gmail', 'x', 'done')`))).rejects.toThrow(/permission denied/);
    expect(await as(BOB, () => q("select * from public.connector_actions"))).toEqual([]);
    await expect(as(ALICE, () => q("update public.connector_actions set status = 'failed'"))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q("delete from public.connector_actions"))).rejects.toThrow(/permission denied/);
  });
});

const { seal } = await import("@/lib/connectors/crypto");
const { runAction } = await import("@/lib/connectors/runtime");

describe("confirmed actions on the server", () => {
  function authWith(row: Record<string, unknown> | null, inserts: unknown[]) {
    return {
      mode: "authenticated",
      user: { id: "u1" },
      supabase: {
        from: (t: string) => ({
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
          update: () => ({ eq: async () => ({ error: null }) }),
          insert: async (r: unknown) => (inserts.push({ t, r }), { error: null }),
        }),
      },
    } as never;
  }
  const base = { connector_id: "gmail", status: "connected", account_label: "a", ai_mode: "auto", token_expires_at: null, last_error: null, connected_at: null, last_checked_at: null, last_used_at: null };
  const args = { to: "sam@acme.test", subject: "Hi", body: "Hello" };

  it("refuses without write access or the granted permission, and with invalid details", async () => {
    process.env.GOOGLE_OAUTH_CLIENT_ID = "gid";
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = "gs";
    const secret = seal(JSON.stringify({ accessToken: "t" }), "u1:gmail");
    await expect(runAction(authWith({ ...base, secret, write_enabled: false, scopes: [] }, []), "gmail_create_draft", args)).rejects.toThrow(/read-only/);
    await expect(runAction(authWith({ ...base, secret, write_enabled: true, scopes: ["https://www.googleapis.com/auth/gmail.readonly"] }, []), "gmail_create_draft", args)).rejects.toThrow(/wasn't given permission/);
    await expect(runAction(authWith(null, []), "gmail_create_draft", args)).rejects.toThrow(/isn't connected/);
    await expect(runAction(authWith({ ...base, secret, write_enabled: true, scopes: ["https://www.googleapis.com/auth/gmail.compose"] }, []), "gmail_create_draft", { ...args, to: "not-an-email" })).rejects.toThrow(/email addresses/);
    await expect(runAction(authWith(null, []), "rm_rf", {})).rejects.toThrow(/Unknown action/);
  });

  it("runs with write access, reports the service's failure honestly, and logs both without content", async () => {
    const secret = seal(JSON.stringify({ accessToken: "t" }), "u1:gmail");
    const row = { ...base, secret, write_enabled: true, scopes: ["https://www.googleapis.com/auth/gmail.compose"] };
    const inserts: { t: string; r: Record<string, unknown> }[] = [];
    const ok = vi.fn(async () => Response.json({ id: "d1" })) as unknown as typeof fetch;
    expect(await runAction(authWith(row, inserts), "gmail_create_draft", args, ok)).toMatchObject({ ok: true, summary: "Draft saved in Gmail (to sam@acme.test)." });
    const fail = vi.fn(async () => new Response("quota", { status: 403 })) as unknown as typeof fetch;
    expect(await runAction(authWith(row, inserts), "gmail_create_draft", args, fail)).toMatchObject({ ok: false, summary: expect.stringMatching(/refused/) });
    expect(inserts.filter((i) => i.t === "connector_actions").map((i) => i.r.status)).toEqual(["done", "failed"]);
    // Orbis Bastion records each confirmed high-risk action (the action's name, never its content).
    expect(inserts.filter((i) => i.t === "security_audit").map((i) => [i.r.action, (i.r.detail as { op: string }).op, (i.r.detail as { resource: string }).resource])).toEqual([
      ["bastion.allow", "connector.write", "gmail_create_draft"],
      ["bastion.allow", "connector.write", "gmail_create_draft"],
    ]);
    expect(JSON.stringify(inserts)).not.toContain("Hello");
  });
});
