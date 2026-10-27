/**
 * The global execution limit under real concurrency: many separate connections to a real PostgreSQL server try to
 * dispatch work at the same moment (PGlite, used by the other tests, has a single connection, so it can't show
 * this). Runs only when ORCH_PG_URL points at a disposable database, e.g.
 *   ORCH_PG_URL=postgresql://user:pass@127.0.0.1:5432/orch_race npx vitest run tests/orchestrator-race.test.ts
 * The test replaces that database's public schema. It needs the psql client on the PATH.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const URL_ = process.env.ORCH_PG_URL;
const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "aaaaaaaa-0000-4000-8000-000000000001";

/** One statement on a fresh connection (each call is its own psql process: real parallel sessions). */
function psql(sql: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("psql", [URL_!, "-tAqX", "-v", "ON_ERROR_STOP=1", "-c", sql], { maxBuffer: 10_000_000 }, (err, out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(out.trim()))),
  );
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freshSchema(tasks: number) {
  await psql(`
    drop schema if exists public cascade; drop schema if exists auth cascade; create schema public; create schema auth;
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
    end $$;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
    create function public.set_updated_at() returns trigger language plpgsql as $f$ begin new.updated_at = now(); return new; end $f$;
    create table public.admins (user_id uuid primary key);
    create function public.is_admin() returns boolean language sql stable as $f$ select exists (select 1 from public.admins where user_id = auth.uid()) $f$;
    create table public.code_projects (id uuid primary key, user_id uuid not null);
  `);
  await psql(readFileSync(join(__dirname, "..", "supabase", "migrations", "20261110000000_orchestrator.sql"), "utf8"));
  await psql(`
    insert into auth.users values ('${OWNER}'); insert into public.admins values ('${OWNER}');
    insert into public.code_projects values ('${PROJECT}', '${OWNER}');
    insert into public.orch_agents (owner_id, name, role, provider, model_id, max_attempts) values ('${OWNER}', 'Worker agent', 'backend_developer', 'anthropic', 'claude-haiku', 1);
    insert into public.orch_tasks (owner_id, project_id, title) select '${OWNER}', '${PROJECT}', 'task ' || g from generate_series(1, ${tasks}) g;
  `);
}

const claim = async (worker: string) => {
  const out = await psql(`select public.orch_claim('${worker}', 270)`);
  return out ? (JSON.parse(out) as { attemptId: string; leaseId: string; slot: number }) : null;
};
const finish = (c: { attemptId: string; leaseId: string }) => psql(`select public.orch_finish('${c.attemptId}', '${c.leaseId}', 'succeeded', 'ok', null, null, false, '{}'::jsonb)`);
const count = async (sql: string) => Number(await psql(sql));

describe.skipIf(!URL_)("the limit with real parallel connections (PostgreSQL)", () => {
  beforeAll(async () => {
    await psql("select 1");
  });

  it("lets exactly three of twenty simultaneous dispatchers start work, in three different slots", async () => {
    await freshSchema(20);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => claim(`racer-${i}`)));
    const won = results.filter(Boolean);
    expect(won).toHaveLength(3);
    expect(new Set(won.map((c) => c!.slot))).toEqual(new Set([1, 2, 3]));
    expect(await count("select count(*) from public.orch_attempts where status = 'running'")).toBe(3);
    expect(await count("select count(*) from public.orch_tasks where status = 'queued'")).toBe(17);
  }, 120_000);

  it("never has more than three running while twelve workers race through sixty tasks, and finishes them all", async () => {
    await freshSchema(60);
    let maxRunning = 0;
    let maxSlots = 0;
    let done = false;
    const monitor = (async () => {
      while (!done) {
        const [running, slots] = (await psql("select (select count(*) from public.orch_attempts where status = 'running') || ',' || (select count(*) from public.orch_slots where lease_id is not null)")).split(",").map(Number);
        maxRunning = Math.max(maxRunning, running!);
        maxSlots = Math.max(maxSlots, slots!);
      }
    })();
    const worker = async (n: number) => {
      let idle = 0;
      while (idle < 15) {
        const c = await claim(`w${n}`);
        if (!c) {
          idle++;
          await sleep(5 + Math.random() * 15);
          continue;
        }
        idle = 0;
        await sleep(5 + Math.random() * 30); // "executing"
        expect(await finish(c)).toBe("completed");
      }
    };
    await Promise.all(Array.from({ length: 12 }, (_, i) => worker(i)));
    done = true;
    await monitor;
    console.info(`race: peak running attempts ${maxRunning}, peak leased slots ${maxSlots}`);
    expect(maxRunning).toBeGreaterThanOrEqual(2); // it really ran in parallel
    expect(maxRunning).toBeLessThanOrEqual(3);
    expect(maxSlots).toBeLessThanOrEqual(3);
    expect(await count("select count(*) from public.orch_tasks where status = 'completed'")).toBe(60);
    expect(await count("select count(*) from public.orch_attempts")).toBe(60); // no task was dispatched twice
    expect(await count("select count(*) from public.orch_slots where lease_id is not null")).toBe(0);
  }, 300_000);

  it("keeps the limit when the setting is lowered to 1 during the race", async () => {
    await freshSchema(10);
    await psql("update public.orch_settings set max_concurrency = 1");
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => claim(`one-${i}`)));
    expect(results.filter(Boolean)).toHaveLength(1);
  }, 120_000);
});
