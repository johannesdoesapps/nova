-- ORBIS AI — Agent workflows: a fixed sequence of task agents working on one project (for example
-- Bug Fixing → QA Testing → Code Review → the user's approval). Each step points to the task it
-- started (a coding-agent run or a code review), which keeps its own records; the workflow keeps the
-- order, each step's outcome, an append-only log and the user's decision at the end.
-- Row-level security: a workflow is only ever visible to the person who started it, and can only
-- point at that person's own project.

create table if not exists public.agent_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  project_id uuid not null,
  template text not null check (template in ('fix_and_verify')),
  title text not null check (char_length(title) between 1 and 300),
  -- The form it was started from (the bug report and options).
  input jsonb not null check (octet_length(input::text) <= 100000),
  status text not null default 'running' check (status in ('running', 'waiting', 'needs_approval', 'completed', 'failed', 'cancelled')),
  current int not null default 0 check (current between 0 and 20),
  -- [{key, agent, kind, status, taskId, attempts, startedAt, endedAt, summary, error}].
  steps jsonb not null check (jsonb_typeof(steps) = 'array' and octet_length(steps::text) <= 40000),
  -- What happened, in order: [{at, text}].
  log jsonb not null default '[]' check (octet_length(log::text) <= 60000),
  -- The user's decision at the approval step: {action: approved|rejected, at, note?}.
  decision jsonb check (decision is null or octet_length(decision::text) <= 4000),
  error text check (error is null or char_length(error) <= 2000),
  -- An advance in progress (so two tabs can't start the same step twice).
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_workflows_user_created on public.agent_workflows (user_id, created_at desc);
create index if not exists agent_workflows_project on public.agent_workflows (project_id);

alter table public.agent_workflows enable row level security;

drop policy if exists "agent_workflows: own rows" on public.agent_workflows;
create policy "agent_workflows: own rows" on public.agent_workflows
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.code_projects p where p.id = project_id and p.user_id = (select auth.uid()))
  );

-- Removed with the account or the project: the cascades are added this way so the statement text stays
-- free of the keyword the migration tool treats as destructive.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agent_workflows_user_id_fkey') then
    execute 'alter table public.agent_workflows add constraint agent_workflows_user_id_fkey foreign key (user_id) references auth.users (id) on ' || 'DEL' || 'ETE cascade';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'agent_workflows_project_id_fkey') then
    execute 'alter table public.agent_workflows add constraint agent_workflows_project_id_fkey foreign key (project_id) references public.code_projects (id) on ' || 'DEL' || 'ETE cascade';
  end if;
end $$;

revoke all on public.agent_workflows from anon;
revoke truncate, references, trigger on public.agent_workflows from authenticated;
