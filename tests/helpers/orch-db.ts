/**
 * A PGlite database with every real migration applied, for the orchestrator's tests: two administrators (Alice,
 * Carol), one ordinary user (Bob), and a Code project for each administrator. Queries run through the Supabase stub,
 * as a user (row-level security) or as the service role.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { POSTGREST_PARSERS, serviceAs, supabaseAs } from "../stubs/pglite-supabase";

export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";
export const CAROL = "33333333-3333-4333-8333-333333333333";
export const ALICE_PROJECT = "aaaaaaaa-0000-4000-8000-000000000001";
export const ALICE_PROJECT_2 = "aaaaaaaa-0000-4000-8000-000000000002";
export const CAROL_PROJECT = "cccccccc-0000-4000-8000-000000000001";

export async function orchDb(): Promise<PGlite> {
  const db = new PGlite({ parsers: POSTGREST_PARSERS });
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
  const dir = join(__dirname, "..", "..", "supabase", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(join(dir, f), "utf8"));
  await db.exec(`
    insert into auth.users (id, email) values ('${ALICE}', 'alice@x.test'), ('${BOB}', 'bob@x.test'), ('${CAROL}', 'carol@x.test');
    insert into public.admins (user_id) values ('${ALICE}'), ('${CAROL}');
    insert into public.code_projects (id, user_id, name, template) values
      ('${ALICE_PROJECT}', '${ALICE}', 'Alice app', 'website'),
      ('${ALICE_PROJECT_2}', '${ALICE}', 'Alice api', 'node'),
      ('${CAROL_PROJECT}', '${CAROL}', 'Carol app', 'website');
    insert into public.code_files (project_id, path, content) values
      ('${ALICE_PROJECT}', 'src/app.ts', 'export const add = (a: number, b: number) => a - b;\\n'),
      ('${ALICE_PROJECT}', '.env', 'API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789');
  `);
  return db;
}

/** Remove every orchestrator row and free the slots (between tests). */
export async function resetOrch(db: PGlite): Promise<void> {
  await db.exec(`
    reset role;
    delete from public.orch_events; delete from public.orch_attempts; delete from public.orch_tasks; delete from public.orch_agents;
    update public.orch_slots set lease_id = null, attempt_id = null, task_id = null, owner_id = null, purpose = null, acquired_at = null, expires_at = null;
    update public.orch_settings set max_concurrency = 3, lease_grace_seconds = 30;
  `);
}

export const asUser = (db: PGlite, id: string) => supabaseAs(db, id);
export const asService = (db: PGlite) => serviceAs(db);
