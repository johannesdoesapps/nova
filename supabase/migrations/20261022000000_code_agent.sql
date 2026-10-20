-- ORBIS AI — the coding agent in Code mode.
-- A run is one request to the agent on one project. Its events are the
-- audit trail and the activity the page shows (append-only); its changes
-- record each file's content before and after the run, so a run can be
-- reviewed and reverted. Owners only, enforced by row-level security.

create table if not exists public.code_agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid not null references public.code_projects (id) on delete cascade,
  request text not null check (char_length(request) between 1 and 8000),
  status text not null default 'planning' check (status in ('planning', 'awaiting_approval', 'running', 'needs_input', 'completed', 'failed', 'cancelled')),
  -- Settings for the run: model, whether plans need approval, whether commands are allowed.
  options jsonb not null default '{}' check (octet_length(options::text) <= 4000),
  plan jsonb check (plan is null or octet_length(plan::text) <= 20000),
  -- What the run is waiting for (a plan approval, a command, edits to review, an answer, the computer).
  -- Proposed edits carry the files' text, so this can be large.
  pending jsonb check (pending is null or octet_length(pending::text) <= 1500000),
  -- The agent's working memory between steps (trimmed).
  transcript jsonb not null default '[]' check (octet_length(transcript::text) <= 400000),
  summary text check (summary is null or char_length(summary) <= 8000),
  error text check (error is null or char_length(error) <= 2000),
  steps int not null default 0 check (steps >= 0),
  -- Steps the run may take before it pauses to ask whether to keep going.
  step_limit int not null default 20 check (step_limit between 1 and 200),
  -- A step in progress (so two tabs can't run the same step at once).
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists code_agent_runs_project on public.code_agent_runs (project_id, created_at desc);

create table if not exists public.code_agent_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.code_agent_runs (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  seq int not null,
  kind text not null check (kind in ('status', 'note', 'inspect', 'plan', 'edit', 'command', 'question', 'answer', 'approval', 'error', 'summary', 'revert', 'git')),
  title text not null check (char_length(title) <= 400),
  detail jsonb check (detail is null or octet_length(detail::text) <= 120000),
  created_at timestamptz not null default now(),
  unique (run_id, seq)
);

create table if not exists public.code_agent_changes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.code_agent_runs (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  path text not null check (char_length(path) between 1 and 300),
  -- null: the file didn't exist before (before) / was deleted (after).
  before text check (before is null or octet_length(before) <= 204800),
  after text check (after is null or octet_length(after) <= 204800),
  reverted_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (run_id, path)
);

alter table public.code_agent_runs enable row level security;
alter table public.code_agent_events enable row level security;
alter table public.code_agent_changes enable row level security;

create policy code_agent_runs_own on public.code_agent_runs for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (select 1 from public.code_projects p where p.id = project_id and p.user_id = (select auth.uid())));
create policy code_agent_events_select_own on public.code_agent_events for select to authenticated
  using (user_id = (select auth.uid()));
create policy code_agent_events_insert_own on public.code_agent_events for insert to authenticated
  with check (user_id = (select auth.uid()) and exists (select 1 from public.code_agent_runs r where r.id = run_id and r.user_id = (select auth.uid())));
create policy code_agent_changes_own on public.code_agent_changes for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and exists (select 1 from public.code_agent_runs r where r.id = run_id and r.user_id = (select auth.uid())));

revoke all on public.code_agent_runs from anon, authenticated;
revoke all on public.code_agent_events from anon, authenticated;
revoke all on public.code_agent_changes from anon, authenticated;
grant select, delete on public.code_agent_runs to authenticated;
grant insert (project_id, request, status, options, step_limit) on public.code_agent_runs to authenticated;
grant update (status, plan, pending, transcript, summary, error, steps, step_limit, locked_until, updated_at) on public.code_agent_runs to authenticated;
-- The audit trail is append-only.
grant select on public.code_agent_events to authenticated;
grant insert (run_id, seq, kind, title, detail) on public.code_agent_events to authenticated;
grant select on public.code_agent_changes to authenticated;
grant insert (run_id, path, before, after) on public.code_agent_changes to authenticated;
grant update (after, reverted_at, updated_at) on public.code_agent_changes to authenticated;
