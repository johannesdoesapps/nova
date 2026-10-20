/**
 * Code workspace in the database (the real migrations on PGlite): owners only,
 * columns users may not change, file limits, and workspace time blocks that
 * only the reserve function can write — with the user, site and concurrency
 * limits it enforces.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

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
const newProject = (user: string, name = "P") => as(user, async () => (await q<{ id: string }>("insert into public.code_projects (name, template) values ($1, 'website') returning id", [name]))[0]!.id);
const reserve = (user: string, project: string, o: { block?: string | null; session?: string | null; minutes?: number; limit?: number | null; site?: number; concurrent?: number } = {}) =>
  as(user, async () => (await q<{ r: { ok: boolean; reason?: string; id?: string; session?: string; used: number } }>(
    "select public.code_workspace_reserve($1, $2, $3, $4, date_trunc('month', now()), $5, $6, $7) as r",
    [o.block ?? null, project, o.session ?? null, o.minutes ?? 10, o.limit === undefined ? 100 : o.limit, o.site ?? 0, o.concurrent ?? 0],
  ))[0]!.r);

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
}, 60_000);
afterAll(() => db.close());

beforeEach(async () => {
  await db.exec("reset role; delete from public.code_workspace_blocks; delete from public.code_projects;");
});

describe("projects and files", () => {
  it("are visible and changeable by their owner only", async () => {
    const p = await newProject(ALICE);
    await as(ALICE, () => q("insert into public.code_files (project_id, path, content) values ($1, 'a.txt', 'hi')", [p]));
    expect(await as(BOB, () => q("select * from public.code_projects"))).toEqual([]);
    expect(await as(BOB, () => q("select * from public.code_files"))).toEqual([]);
    await expect(as(BOB, () => q("insert into public.code_files (project_id, path, content) values ($1, 'b.txt', 'x')", [p]))).rejects.toThrow(/row-level security/);
    await as(BOB, () => q("update public.code_files set content = 'hacked'"));
    await as(BOB, () => q("delete from public.code_projects"));
    expect(await as(ALICE, () => q("select content from public.code_files"))).toEqual([{ content: "hi" }]);
  });

  it("never lets a user change a project's id or owner", async () => {
    const p = await newProject(ALICE);
    await expect(as(ALICE, () => q("update public.code_projects set id = gen_random_uuid() where id = $1", [p]))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q(`update public.code_projects set user_id = '${BOB}' where id = $1`, [p]))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q(`insert into public.code_projects (name, user_id) values ('x', '${BOB}')`))).rejects.toThrow(/permission denied/);
    await as(ALICE, () => q("update public.code_projects set name = 'Renamed', run_command = 'npm start' where id = $1", [p]));
    expect(await as(ALICE, () => q("select name, run_command from public.code_projects"))).toEqual([{ name: "Renamed", run_command: "npm start" }]);
  });

  it("refuses unsafe paths and files over 200 KB", async () => {
    const p = await newProject(ALICE);
    for (const bad of ["/etc/passwd", "../x", "a/../b", "./a", "a//b", "a\\b", "a\nb"]) {
      await expect(as(ALICE, () => q("insert into public.code_files (project_id, path) values ($1, $2)", [p, bad]))).rejects.toThrow(/check constraint/);
    }
    await expect(as(ALICE, () => q("insert into public.code_files (project_id, path, content) values ($1, 'big.txt', repeat('x', 204801))", [p]))).rejects.toThrow(/check constraint/);
    await as(ALICE, () => q("insert into public.code_files (project_id, path, content) values ($1, 'ok.txt', repeat('x', 204800))", [p]));
  });

  it("limits a project to 300 files and 3 MB, counting renames correctly", async () => {
    const p = await newProject(ALICE);
    await as(ALICE, () => q("insert into public.code_files (project_id, path) select $1, 'f' || g from generate_series(1, 300) g", [p]));
    await expect(as(ALICE, () => q("insert into public.code_files (project_id, path) values ($1, 'one-more')", [p]))).rejects.toThrow(/at most 300 files/);
    // Renaming and saving existing files still works at the limit.
    await as(ALICE, () => q("update public.code_files set path = 'renamed', content = 'x' where project_id = $1 and path = 'f1'", [p]));
    await as(ALICE, () => q("insert into public.code_files (project_id, path, content) values ($1, 'f2', 'y') on conflict (project_id, path) do update set content = excluded.content", [p]));

    const p2 = await newProject(ALICE, "Big");
    await as(ALICE, () => q("insert into public.code_files (project_id, path, content) select $1, 'f' || g, repeat('x', 200000) from generate_series(1, 15) g", [p2]));
    await expect(as(ALICE, () => q("insert into public.code_files (project_id, path, content) values ($1, 'f16', repeat('x', 200000))", [p2]))).rejects.toThrow(/at most 3 MB/);
  });
});

describe("workspace time blocks", () => {
  it("can't be written, changed or deleted by users", async () => {
    const p = await newProject(ALICE);
    await expect(as(ALICE, () => q(`insert into public.code_workspace_blocks (session_id, user_id, project_id, minutes) values (gen_random_uuid(), '${ALICE}', $1, 1)`, [p]))).rejects.toThrow(/permission denied/);
    const r = await reserve(ALICE, p);
    expect(r.ok).toBe(true);
    await expect(as(ALICE, () => q("delete from public.code_workspace_blocks"))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q("update public.code_workspace_blocks set minutes = 1"))).rejects.toThrow(/permission denied/);
    expect(await as(ALICE, () => q("select minutes from public.code_workspace_blocks"))).toEqual([{ minutes: 10 }]);
    expect(await as(BOB, () => q("select * from public.code_workspace_blocks"))).toEqual([]);
  });

  it("stops at the user's minutes, counts extensions, and reports minutes used", async () => {
    const p = await newProject(ALICE);
    const block = "33333333-3333-4333-8333-333333333333";
    const first = await reserve(ALICE, p, { block, limit: 25 });
    expect(first).toMatchObject({ ok: true, id: block, session: block, used: 10 });
    const ext = await reserve(ALICE, p, { session: block, limit: 25 });
    expect(ext).toMatchObject({ ok: true, session: block, used: 20 });
    expect(await reserve(ALICE, p, { session: block, limit: 25 })).toMatchObject({ ok: false, reason: "user", used: 20 });
    const live = await as(ALICE, () => q<{ session_id: string; ends_at: string; started_at: string }>("select session_id, started_at, ends_at from public.code_workspace_live"));
    expect(live).toHaveLength(1);
    expect(Date.parse(live[0]!.ends_at) - Date.parse(live[0]!.started_at)).toBe(20 * 60_000);
    const s = await as(ALICE, async () => (await q<{ s: { user_minutes: number; site_minutes: number; site_live: number } }>("select public.code_workspace_status(date_trunc('month', now())) as s"))[0]!.s);
    expect(s).toEqual({ user_minutes: 20, site_minutes: 20, site_live: 1 });
    // No limit (administrators).
    expect((await reserve(ALICE, p, { limit: null })).ok).toBe(true);
  });

  it("stops at the site's monthly minutes and the number of computers running at once", async () => {
    const a = await newProject(ALICE);
    const b = await newProject(BOB);
    expect((await reserve(ALICE, a, { site: 15, concurrent: 1 })).ok).toBe(true);
    expect(await reserve(BOB, b, { site: 100, concurrent: 1 })).toMatchObject({ ok: false, reason: "busy" });
    expect(await reserve(BOB, b, { site: 15, concurrent: 0 })).toMatchObject({ ok: false, reason: "site" });
    expect((await reserve(BOB, b, { site: 100, concurrent: 2 })).ok).toBe(true);
    // Bob sees only his own running session.
    expect(await as(BOB, () => q("select project_id from public.code_workspace_live"))).toEqual([{ project_id: b }]);
  });

  it("only continues the caller's own running session of the same project", async () => {
    const a = await newProject(ALICE);
    const a2 = await newProject(ALICE, "Other");
    const b = await newProject(BOB);
    const s = (await reserve(ALICE, a)).session!;
    expect(await reserve(BOB, b, { session: s })).toMatchObject({ ok: false, reason: "ended" });
    expect(await reserve(ALICE, a2, { session: s })).toMatchObject({ ok: false, reason: "ended" });
    await expect(reserve(BOB, a)).rejects.toThrow(/Project not found/);
    // An ended session can't be extended.
    await db.exec("update public.code_workspace_blocks set created_at = now() - interval '11 minutes'");
    expect(await reserve(ALICE, a, { session: s })).toMatchObject({ ok: false, reason: "ended" });
    expect(await as(ALICE, () => q("select * from public.code_workspace_live"))).toEqual([]);
  });

  it("needs a signed-in caller and a sensible block", async () => {
    const a = await newProject(ALICE);
    await expect(reserve(ALICE, a, { minutes: 0 })).rejects.toThrow(/Invalid block length/);
    await expect(reserve(ALICE, a, { minutes: 61 })).rejects.toThrow(/Invalid block length/);
    await db.exec("select set_config('request.jwt.claim.sub', '', false)");
    await expect(db.query("select public.code_workspace_status(now())")).rejects.toThrow(/Sign in required/);
  });
});
