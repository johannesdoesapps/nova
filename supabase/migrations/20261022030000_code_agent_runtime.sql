-- ORBIS AI — coding agent runtime: budgets, usage, test results, the final
-- report, and checkpoints a run (or the user) can return to.
-- Additive only: new columns with defaults and one new table.

alter table public.code_agent_runs
  -- Tokens (input + output) the run may use before it pauses to ask; and what it has used.
  add column if not exists token_budget int not null default 600000 check (token_budget between 10000 and 10000000),
  add column if not exists usage jsonb not null default '{}' check (octet_length(usage::text) <= 4000),
  -- Time the agent has spent working (model calls and actions), and the limit before it pauses.
  add column if not exists active_ms bigint not null default 0 check (active_ms >= 0),
  add column if not exists time_limit_ms bigint not null default 1800000 check (time_limit_ms between 60000 and 14400000),
  -- The latest test run's parsed result, and how many test runs failed in a row.
  add column if not exists tests jsonb check (tests is null or octet_length(tests::text) <= 20000),
  -- Recent action signatures, to notice the agent repeating itself.
  add column if not exists recent jsonb not null default '[]' check (octet_length(recent::text) <= 4000),
  add column if not exists last_edit_at timestamptz,
  -- Built by the server from what actually happened when the run ends.
  add column if not exists report jsonb check (report is null or octet_length(report::text) <= 60000);

grant update (token_budget, usage, active_ms, time_limit_ms, tests, recent, last_edit_at, report) on public.code_agent_runs to authenticated;

-- A checkpoint is the content of every file the run had changed at that moment.
-- Restoring it puts those files back; files the run changed later go back to how they were before the run.
create table if not exists public.code_agent_checkpoints (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.code_agent_runs (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  label text not null check (char_length(label) between 1 and 200),
  -- {path: content, or null for a file the run had deleted}
  files jsonb not null default '{}' check (octet_length(files::text) <= 3500000),
  created_at timestamptz not null default now()
);
create index if not exists code_agent_checkpoints_run on public.code_agent_checkpoints (run_id, created_at);

alter table public.code_agent_checkpoints enable row level security;
create policy code_agent_checkpoints_select_own on public.code_agent_checkpoints for select to authenticated
  using (user_id = (select auth.uid()));
create policy code_agent_checkpoints_insert_own on public.code_agent_checkpoints for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.code_agent_runs r where r.id = run_id and r.user_id = (select auth.uid())));

revoke all on public.code_agent_checkpoints from anon, authenticated;
-- Checkpoints can be added and read, never changed.
grant select on public.code_agent_checkpoints to authenticated;
grant insert (run_id, label, files) on public.code_agent_checkpoints to authenticated;
