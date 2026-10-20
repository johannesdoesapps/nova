-- ORBIS AI — Internal AI Workforce: projects, persistent tasks and their step
-- graph, append-only events, approvals, memory and benchmark records.
-- Operators are administrators (public.admins); every policy requires both
-- ownership and admin status, so non-admin accounts can't see or write any of it.

create table public.wf_settings (
  id smallint primary key default 1 check (id = 1),
  settings jsonb not null default '{}'::jsonb check (octet_length(settings::text) <= 50000),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
insert into public.wf_settings (id) values (1);

create table public.wf_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  repo text not null check (repo ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$'),
  branch text not null default 'main' check (char_length(branch) between 1 and 200),
  package_manager text not null default 'npm' check (package_manager in ('npm')),
  checks jsonb not null default '[]'::jsonb check (octet_length(checks::text) <= 20000),
  notes text check (notes is null or char_length(notes) <= 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, repo, branch)
);

create table public.wf_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid not null references public.wf_projects (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  objective text not null check (char_length(objective) between 1 and 8000),
  acceptance_criteria text[] not null default '{}' check (cardinality(acceptance_criteria) <= 20),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  risk text not null default 'medium' check (risk in ('low', 'medium', 'high')),
  autonomy text not null default 'collaborate' check (autonomy in ('assist', 'collaborate', 'execute')),
  status text not null default 'created' check (status in ('created', 'analyzing', 'planned', 'awaiting_approval', 'running', 'verifying', 'completed', 'failed', 'blocked', 'cancelled', 'needs_attention', 'paused')),
  status_reason text check (status_reason is null or char_length(status_reason) <= 2000),
  plan jsonb check (plan is null or octet_length(plan::text) <= 100000),
  plan_hash text,
  budget_usd numeric(10, 4) not null default 2 check (budget_usd >= 0 and budget_usd <= 1000),
  token_budget int not null default 400000 check (token_budget between 1000 and 20000000),
  spent_usd numeric(12, 6) not null default 0,
  spent_unpriced_calls int not null default 0,
  tokens_used int not null default 0,
  sandbox_name text check (sandbox_name is null or char_length(sandbox_name) <= 128),
  sandbox_ms bigint not null default 0,
  diff text check (diff is null or char_length(diff) <= 400000),
  changed_files text[] not null default '{}',
  verification jsonb check (verification is null or octet_length(verification::text) <= 100000),
  report text check (report is null or char_length(report) <= 100000),
  benchmark text check (benchmark is null or char_length(benchmark) <= 80),
  versions jsonb not null default '{}'::jsonb,
  cancel_requested boolean not null default false,
  lease_until timestamptz,
  lease_id uuid,
  ticks int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index wf_tasks_user_idx on public.wf_tasks (user_id, created_at desc);
create index wf_tasks_project_idx on public.wf_tasks (project_id, created_at desc);
create index wf_tasks_status_idx on public.wf_tasks (status);

create table public.wf_steps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_id uuid not null references public.wf_tasks (id) on delete cascade,
  key text not null check (char_length(key) between 1 and 80),
  agent text not null check (char_length(agent) between 1 and 40),
  agent_version text not null check (char_length(agent_version) <= 40),
  title text not null check (char_length(title) between 1 and 200),
  depends_on text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled', 'blocked')),
  attempt int not null default 0 check (attempt >= 0),
  max_attempts int not null default 2 check (max_attempts between 1 and 10),
  input jsonb not null default '{}'::jsonb check (octet_length(input::text) <= 200000),
  output jsonb check (output is null or octet_length(output::text) <= 400000),
  state jsonb not null default '{}'::jsonb check (octet_length(state::text) <= 20000),
  error text check (error is null or char_length(error) <= 4000),
  model_id text,
  tokens int not null default 0,
  cost_usd numeric(12, 6),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (task_id, key)
);
create index wf_steps_task_idx on public.wf_steps (task_id, created_at);
create index wf_steps_user_idx on public.wf_steps (user_id);

-- Append-only execution log and audit trail.
create table public.wf_events (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_id uuid references public.wf_tasks (id) on delete cascade,
  step_key text,
  level text not null default 'info' check (level in ('debug', 'info', 'warn', 'error', 'audit')),
  type text not null check (char_length(type) <= 60),
  message text not null check (char_length(message) <= 4000),
  data jsonb not null default '{}'::jsonb check (octet_length(data::text) <= 40000),
  created_at timestamptz not null default now()
);
create index wf_events_task_idx on public.wf_events (task_id, id);
create index wf_events_user_idx on public.wf_events (user_id, created_at desc);

create table public.wf_approvals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_id uuid not null references public.wf_tasks (id) on delete cascade,
  kind text not null check (kind in ('plan', 'budget', 'changes', 'push')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  title text not null check (char_length(title) <= 200),
  reason text not null default '' check (char_length(reason) <= 4000),
  risk text not null default 'medium' check (risk in ('low', 'medium', 'high')),
  payload jsonb not null default '{}'::jsonb check (octet_length(payload::text) <= 100000),
  payload_hash text not null,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 2000),
  created_at timestamptz not null default now()
);
create index wf_approvals_task_idx on public.wf_approvals (task_id);
create index wf_approvals_user_idx on public.wf_approvals (user_id, status);

create table public.wf_memory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid not null references public.wf_projects (id) on delete cascade,
  task_id uuid references public.wf_tasks (id) on delete set null,
  kind text not null check (kind in ('task_context', 'project_knowledge')),
  content text not null check (char_length(content) between 1 and 8000),
  source text not null check (char_length(source) <= 200),
  verified boolean not null default false,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index wf_memory_project_idx on public.wf_memory (project_id, created_at desc);
create index wf_memory_task_idx on public.wf_memory (task_id);
create index wf_memory_user_idx on public.wf_memory (user_id);

create trigger wf_tasks_updated_at before update on public.wf_tasks for each row execute function public.set_updated_at();
create trigger wf_projects_updated_at before update on public.wf_projects for each row execute function public.set_updated_at();
create trigger wf_settings_updated_at before update on public.wf_settings for each row execute function public.set_updated_at();

alter table public.wf_settings enable row level security;
alter table public.wf_projects enable row level security;
alter table public.wf_tasks enable row level security;
alter table public.wf_steps enable row level security;
alter table public.wf_events enable row level security;
alter table public.wf_approvals enable row level security;
alter table public.wf_memory enable row level security;

create policy "wf_settings_admin_read" on public.wf_settings for select to authenticated using ((select public.is_admin()));
create policy "wf_settings_admin_update" on public.wf_settings for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

create policy "wf_projects_admin_own" on public.wf_projects for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_admin())) with check (user_id = (select auth.uid()) and (select public.is_admin()));
create policy "wf_tasks_admin_own" on public.wf_tasks for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_admin())) with check (user_id = (select auth.uid()) and (select public.is_admin()));
create policy "wf_steps_admin_own" on public.wf_steps for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_admin())) with check (user_id = (select auth.uid()) and (select public.is_admin()));
create policy "wf_approvals_admin_own" on public.wf_approvals for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_admin())) with check (user_id = (select auth.uid()) and (select public.is_admin()));
create policy "wf_memory_admin_own" on public.wf_memory for all to authenticated
  using (user_id = (select auth.uid()) and (select public.is_admin())) with check (user_id = (select auth.uid()) and (select public.is_admin()));
create policy "wf_events_admin_read" on public.wf_events for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_admin()));
create policy "wf_events_admin_insert" on public.wf_events for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_admin()));
-- Retention cleanup may delete old non-audit events; nothing may edit events, and audit entries are never deleted.
create policy "wf_events_admin_delete_own" on public.wf_events for delete to authenticated
  using (user_id = (select auth.uid()) and (select public.is_admin()) and level <> 'audit');
