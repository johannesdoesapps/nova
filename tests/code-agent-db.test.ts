/**
 * The coding agent's records in the database (the real migrations on
 * PGlite): runs only on your own projects, an activity log you can add to
 * but never edit or delete, and change records whose "before" can't be
 * rewritten.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/ai", () => ({}));

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
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin;
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
  await db.exec("reset role; delete from public.code_projects;");
});

const newRun = (user: string, project: string) =>
  as(user, async () => (await q<{ id: string }>("insert into public.code_agent_runs (project_id, request, status, options) values ($1, 'Add tests', 'planning', '{}') returning id", [project]))[0]!.id);

describe("agent runs", () => {
  it("can be started only on your own projects, and are visible to their owner only", async () => {
    const p = await newProject(ALICE);
    await expect(newRun(BOB, p)).rejects.toThrow(/row-level security/);
    const r = await newRun(ALICE, p);
    expect(await as(BOB, () => q("select * from public.code_agent_runs"))).toEqual([]);
    await as(BOB, () => q("update public.code_agent_runs set status = 'cancelled'"));
    expect(await as(ALICE, () => q("select status from public.code_agent_runs where id = $1", [r]))).toEqual([{ status: "planning" }]);
  });

  it("never lets a user move a run to another project or owner, or set an unknown status", async () => {
    const p = await newProject(ALICE);
    const p2 = await newProject(ALICE, "Other");
    const r = await newRun(ALICE, p);
    await expect(as(ALICE, () => q("update public.code_agent_runs set project_id = $1 where id = $2", [p2, r]))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q(`update public.code_agent_runs set user_id = '${BOB}' where id = $1`, [r]))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q("update public.code_agent_runs set status = 'hacked' where id = $1", [r]))).rejects.toThrow(/check constraint/);
    await as(ALICE, () => q("update public.code_agent_runs set status = 'running', steps = 1, locked_until = now() where id = $1", [r]));
  });

  it("are deleted with their project", async () => {
    const p = await newProject(ALICE);
    const r = await newRun(ALICE, p);
    await as(ALICE, () => q("insert into public.code_agent_events (run_id, seq, kind, title) values ($1, 1, 'status', 'Started')", [r]));
    await as(ALICE, () => q("delete from public.code_projects where id = $1", [p]));
    expect(await q("select * from public.code_agent_events")).toEqual([]);
  });
});

describe("agent activity log", () => {
  it("is append-only and kept to the run's owner", async () => {
    const p = await newProject(ALICE);
    const r = await newRun(ALICE, p);
    await as(ALICE, () => q("insert into public.code_agent_events (run_id, seq, kind, title, detail) values ($1, 1, 'command', 'Ran npm test', '{\"exitCode\": 0}')", [r]));
    await expect(as(ALICE, () => q("update public.code_agent_events set title = 'edited'"))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q("delete from public.code_agent_events"))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q("insert into public.code_agent_events (run_id, seq, kind, title) values ($1, 1, 'note', 'dup')", [r]))).rejects.toThrow(/duplicate key/);
    await expect(as(BOB, () => q("insert into public.code_agent_events (run_id, seq, kind, title) values ($1, 2, 'note', 'x')", [r]))).rejects.toThrow(/row-level security/);
    expect(await as(BOB, () => q("select * from public.code_agent_events"))).toEqual([]);
    expect(await as(ALICE, () => q("select title from public.code_agent_events"))).toEqual([{ title: "Ran npm test" }]);
  });
});

describe("agent changes", () => {
  it("keep the original content and only let the latest content and revert time change", async () => {
    const p = await newProject(ALICE);
    const r = await newRun(ALICE, p);
    await as(ALICE, () => q("insert into public.code_agent_changes (run_id, path, before, after) values ($1, 'a.js', 'v1', 'v2')", [r]));
    await expect(as(ALICE, () => q("update public.code_agent_changes set before = 'forged'"))).rejects.toThrow(/permission denied/);
    await as(ALICE, () => q("update public.code_agent_changes set after = 'v3', reverted_at = now()"));
    expect(await as(ALICE, () => q("select before, after from public.code_agent_changes"))).toEqual([{ before: "v1", after: "v3" }]);
    await expect(as(BOB, () => q("insert into public.code_agent_changes (run_id, path, before, after) values ($1, 'b.js', null, 'x')", [r]))).rejects.toThrow(/row-level security/);
    expect(await as(BOB, () => q("select * from public.code_agent_changes"))).toEqual([]);
  });
});

describe("agent checkpoints and run budgets", () => {
  it("can be added and read by the run's owner only, and never changed or deleted", async () => {
    const p = await newProject(ALICE);
    const r = await newRun(ALICE, p);
    const cp = await as(
      ALICE,
      async () =>
        (await q<{ id: string }>('insert into public.code_agent_checkpoints (run_id, label, files) values ($1, \'before refactor\', \'{"a.js": "v2", "gone.js": null}\') returning id', [r]))[0]!.id,
    );
    expect(await as(ALICE, () => q("select label, files from public.code_agent_checkpoints"))).toEqual([{ label: "before refactor", files: { "a.js": "v2", "gone.js": null } }]);
    await expect(as(ALICE, () => q("update public.code_agent_checkpoints set files = '{}' where id = $1", [cp]))).rejects.toThrow(/permission denied/);
    await expect(as(ALICE, () => q("delete from public.code_agent_checkpoints where id = $1", [cp]))).rejects.toThrow(/permission denied/);
    // Another user can neither see it nor add one to Alice's run.
    expect(await as(BOB, () => q("select * from public.code_agent_checkpoints"))).toEqual([]);
    await expect(as(BOB, () => q("insert into public.code_agent_checkpoints (run_id, label) values ($1, 'x')", [r]))).rejects.toThrow(/row-level security/);
    await expect(as(ALICE, () => q("insert into public.code_agent_checkpoints (run_id, label) values ($1, '')", [r]))).rejects.toThrow(/check constraint/);
  });

  it("start runs with a token budget and time limit, kept within bounds, and keep usage and the report", async () => {
    const p = await newProject(ALICE);
    const r = await newRun(ALICE, p);
    expect(await as(ALICE, () => q("select token_budget, time_limit_ms::int as limit, active_ms::int as active, usage from public.code_agent_runs where id = $1", [r]))).toEqual([
      { token_budget: 600000, limit: 1800000, active: 0, usage: {} },
    ]);
    await as(ALICE, () =>
      q(
        `update public.code_agent_runs set usage = '{"inputTokens": 10}', tests = '{"runs": 1}', report = '{"verification": "passed"}', recent = '["x"]', active_ms = 5000, last_edit_at = now() where id = $1`,
        [r],
      ),
    );
    await expect(as(ALICE, () => q("update public.code_agent_runs set token_budget = 5 where id = $1", [r]))).rejects.toThrow(/check constraint/);
    await expect(as(ALICE, () => q("update public.code_agent_runs set time_limit_ms = 999999999999 where id = $1", [r]))).rejects.toThrow(/check constraint/);
    // Bob can't touch Alice's run or its usage.
    await as(BOB, () => q("update public.code_agent_runs set usage = '{}', report = null"));
    expect(await as(ALICE, () => q("select usage, report from public.code_agent_runs where id = $1", [r]))).toEqual([{ usage: { inputTokens: 10 }, report: { verification: "passed" } }]);
  });

  it("keep the repeat detector's list small enough to save after big file writes (it once stopped every such run)", async () => {
    const { actionSignature } = await import("@/lib/code/agent/engine");
    const p = await newProject(ALICE);
    const r = await newRun(ALICE, p);
    const bigWrite = { actions: [{ tool: "write_file", args: { path: "index.html", content: "<section>".repeat(2_000) } }] };
    const old = JSON.stringify(bigWrite.actions.map((a) => [a.tool, a.args]));
    // The old signature (the actions themselves) breaks the column's size check, so the step couldn't be saved.
    await expect(as(ALICE, () => q("update public.code_agent_runs set recent = $1 where id = $2", [JSON.stringify([old]), r]))).rejects.toThrow(/check constraint/);
    const sigs = Array.from({ length: 6 }, (_, i) => actionSignature({ actions: [{ tool: "write_file", args: { path: `p${i}.html`, content: "x".repeat(150_000) } }] }));
    expect(sigs.every((x) => x.length === 22)).toBe(true);
    await as(ALICE, () => q("update public.code_agent_runs set recent = $1 where id = $2", [JSON.stringify(sigs), r]));
    expect(actionSignature(bigWrite)).toBe(actionSignature(structuredClone(bigWrite)));
  });

  it("keep website checks (server, browser check, build), owner only and size-limited", async () => {
    const p = await newProject(ALICE);
    const r = await newRun(ALICE, p);
    const checks = { server: { command: "python3 -m http.server 3000", state: "running", http: 200, at: "2026-10-21T00:00:00Z" }, preview: { verdict: "passed" }, build: null };
    await as(ALICE, () => q("update public.code_agent_runs set checks = $1 where id = $2", [JSON.stringify(checks), r]));
    await as(BOB, () => q("update public.code_agent_runs set checks = null"));
    expect((await as(ALICE, () => q<{ checks: unknown }>("select checks from public.code_agent_runs where id = $1", [r])))[0]!.checks).toEqual(checks);
    await expect(as(ALICE, () => q("update public.code_agent_runs set checks = $1 where id = $2", [JSON.stringify({ preview: { problems: ["x".repeat(30_000)] } }), r]))).rejects.toThrow(/check constraint/);
  });

  it("are deleted with their run's project", async () => {
    const p = await newProject(ALICE);
    const r = await newRun(ALICE, p);
    await as(ALICE, () => q("insert into public.code_agent_checkpoints (run_id, label) values ($1, 'x')", [r]));
    await as(ALICE, () => q("delete from public.code_projects where id = $1", [p]));
    expect(await q("select * from public.code_agent_checkpoints")).toEqual([]);
  });
});

describe("task history, deleting a task's record, and project descriptions", () => {
  const finish = (user: string, run: string, state = "verified") =>
    as(user, () => q(`update public.code_agent_runs set status = 'completed', report = jsonb_build_object('state', $2::text) where id = $1`, [run, state]));

  it("lists only the signed-in user's tasks across projects, newest activity first, filtered by the recorded outcome", async () => {
    const a1 = await newProject(ALICE, "Site");
    const a2 = await newProject(ALICE, "API");
    const b1 = await newProject(BOB, "Bob's");
    const r1 = await newRun(ALICE, a1);
    const r2 = await newRun(ALICE, a2);
    await newRun(BOB, b1);
    await finish(ALICE, r1, "warnings");
    // The query History runs, as each user: Bob's task never shows for Alice, even without the user filter.
    const list = (user: string, extra = "") =>
      as(user, () => q<{ id: string; name: string }>(`select r.id, p.name from public.code_agent_runs r join public.code_projects p on p.id = r.project_id where true ${extra} order by r.updated_at desc, r.id`));
    expect((await list(ALICE)).map((x) => x.name).sort()).toEqual(["API", "Site"]);
    expect(await list(BOB, `and r.user_id = '${ALICE}'`)).toEqual([]);
    expect(await list(ALICE, "and r.status = 'completed' and r.report->>'state' in ('warnings')")).toEqual([{ id: r1, name: "Site" }]);
    expect(await list(ALICE, "and r.status in ('planning', 'running')")).toEqual([{ id: r2, name: "API" }]);
    expect(await q("select indexname from pg_indexes where indexname = 'code_agent_runs_user_updated'")).toEqual([{ indexname: "code_agent_runs_user_updated" }]);
  });

  it("lets the owner delete a task's record with its activity, changes, checkpoints and attachments, and nobody else", async () => {
    const p = await newProject(ALICE);
    const r = await newRun(ALICE, p);
    await as(ALICE, async () => {
      await q("insert into public.code_agent_events (run_id, seq, kind, title) values ($1, 1, 'status', 'Started')", [r]);
      await q("insert into public.code_agent_changes (run_id, path, before, after) values ($1, 'a.js', 'v1', 'v2')", [r]);
      await q("insert into public.code_agent_checkpoints (run_id, label) values ($1, 'before')", [r]);
    });
    await finish(ALICE, r);
    expect(await as(BOB, () => q("delete from public.code_agent_runs where id = $1 returning id", [r]))).toEqual([]);
    expect(await as(ALICE, () => q("select count(*)::int as n from public.code_agent_events"))).toEqual([{ n: 1 }]);
    expect(await as(ALICE, () => q("delete from public.code_agent_runs where id = $1 returning id", [r]))).toEqual([{ id: r }]);
    for (const t of ["code_agent_events", "code_agent_changes", "code_agent_checkpoints"]) expect(await q(`select count(*)::int as n from public.${t}`)).toEqual([{ n: 0 }]);
    // The project and its files aren't touched.
    expect(await as(ALICE, () => q("select count(*)::int as n from public.code_projects where id = $1", [p]))).toEqual([{ n: 1 }]);
  });

  it("gives a code project an optional description that only its owner can change, up to 500 characters", async () => {
    const p = await newProject(ALICE);
    await as(ALICE, () => q("update public.code_projects set description = 'Landing page for the bakery' where id = $1", [p]));
    expect(await as(BOB, () => q("update public.code_projects set description = 'mine now' where id = $1 returning id", [p]))).toEqual([]);
    expect(await as(BOB, () => q("select description from public.code_projects"))).toEqual([]);
    expect(await as(ALICE, () => q("select description from public.code_projects where id = $1", [p]))).toEqual([{ description: "Landing page for the bakery" }]);
    await expect(as(ALICE, () => q("update public.code_projects set description = $2 where id = $1", [p, "x".repeat(501)]))).rejects.toThrow(/check constraint/);
    await as(ALICE, () => q("update public.code_projects set description = null where id = $1", [p]));
  });
});
