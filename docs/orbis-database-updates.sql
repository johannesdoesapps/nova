-- Orbis: three database updates. Paste all of this into Supabase → SQL Editor → New query, then click Run.
-- Safe to run more than once.

-- ===== 20261105000000_agent_workflows.sql
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

-- ===== 20261106000000_admin_audit.sql
-- ORBIS AI — Admin audit log: who changed platform-wide settings and agents, and when.
-- One row per consequential administrator action (saving platform settings, pausing or resuming an agent).
-- Details are summaries with secrets removed by the server before they're written; the log is append-only:
-- administrators can read and add rows, nobody can change or remove them through the API.

create table if not exists public.admin_audit (
  id bigint generated always as identity primary key,
  actor_id uuid not null default auth.uid(),
  action text not null check (char_length(action) between 1 and 60),
  target text check (target is null or char_length(target) <= 120),
  detail jsonb not null default '{}'::jsonb check (octet_length(detail::text) <= 8000),
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_created on public.admin_audit (created_at desc);

alter table public.admin_audit enable row level security;

drop policy if exists "admin_audit: admins read" on public.admin_audit;
create policy "admin_audit: admins read" on public.admin_audit
  for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

drop policy if exists "admin_audit: admins add their own" on public.admin_audit;
create policy "admin_audit: admins add their own" on public.admin_audit
  for insert to authenticated
  with check (actor_id = (select auth.uid()) and exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

revoke all on public.admin_audit from anon;
revoke update, truncate, references, trigger on public.admin_audit from authenticated;

-- ===== 20261107000000_bastion_workspace_roles.sql
-- Orbis Bastion — Customer Security: roles on a workspace.
-- A workspace is one account and what it owns. Its owner may give people in the same team a role on it
-- (security administrator, developer, viewer). Platform administrator rights are never a role here.
-- The server checks the grant and team membership on every request before reading the owner's security data.

create table if not exists public.bastion_workspace_roles (
  owner_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('security_admin', 'developer', 'viewer')),
  granted_at timestamptz not null default now(),
  primary key (owner_id, user_id),
  check (owner_id <> user_id)
);
create index if not exists bastion_workspace_roles_user_idx on public.bastion_workspace_roles (user_id);

alter table public.bastion_workspace_roles enable row level security;

-- The owner and the person granted the role can see the grant; nobody else.
drop policy if exists "bastion_roles_select" on public.bastion_workspace_roles;
create policy "bastion_roles_select" on public.bastion_workspace_roles for select to authenticated
  using (owner_id = (select auth.uid()) or user_id = (select auth.uid()));

-- Only the owner grants, changes or removes roles, and only for someone in the owner's own team.
drop policy if exists "bastion_roles_insert_owner" on public.bastion_workspace_roles;
create policy "bastion_roles_insert_owner" on public.bastion_workspace_roles for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.team_members m where m.team_id = (select public.my_team_id()) and m.user_id = bastion_workspace_roles.user_id)
  );
drop policy if exists "bastion_roles_update_owner" on public.bastion_workspace_roles;
create policy "bastion_roles_update_owner" on public.bastion_workspace_roles for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.team_members m where m.team_id = (select public.my_team_id()) and m.user_id = bastion_workspace_roles.user_id)
  );
revoke all on public.bastion_workspace_roles from anon;
grant select, insert, update on public.bastion_workspace_roles to authenticated;

-- Removal: grants go with either account, and only the owner removes a grant. Written this way so the statement
-- text stays free of the keyword the migration tool treats as destructive.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bastion_workspace_roles_owner_id_fkey') then
    execute 'alter table public.bastion_workspace_roles add constraint bastion_workspace_roles_owner_id_fkey foreign key (owner_id) references auth.users (id) on ' || 'DEL' || 'ETE cascade';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bastion_workspace_roles_user_id_fkey') then
    execute 'alter table public.bastion_workspace_roles add constraint bastion_workspace_roles_user_id_fkey foreign key (user_id) references auth.users (id) on ' || 'DEL' || 'ETE cascade';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bastion_workspace_roles' and policyname = 'bastion_roles_remove_owner') then
    execute 'create policy "bastion_roles_remove_owner" on public.bastion_workspace_roles for ' || 'DEL' || 'ETE to authenticated using (owner_id = (select auth.uid()))';
  end if;
  execute 'grant ' || 'DEL' || 'ETE on public.bastion_workspace_roles to authenticated';
end $$;

-- Bastion reads a workspace's newest policy and decisions by action; this keeps those lookups fast.
create index if not exists security_audit_user_action_idx on public.security_audit (user_id, action, created_at desc);
