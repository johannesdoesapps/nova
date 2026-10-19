-- NOVA AI — Mission Control: a project becomes a mission with a goal, a
-- status, tasks grouped by milestone, and a history of AI task runs.

alter table public.projects
  add column goal text check (goal is null or char_length(goal) <= 4000),
  add column status text not null default 'active' check (status in ('active', 'paused', 'completed', 'archived'));

create table public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 4000),
  milestone text check (milestone is null or char_length(milestone) <= 120),
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'blocked', 'cancelled')),
  priority text not null default 'medium' check (priority in ('low', 'medium', 'high')),
  position int not null default 0,
  ai_suitable boolean not null default false,
  output text check (output is null or char_length(output) <= 60000),
  output_model text check (output_model is null or char_length(output_model) <= 120),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index project_tasks_project_idx on public.project_tasks (project_id, position);
create index project_tasks_user_idx on public.project_tasks (user_id, status);
create trigger project_tasks_updated_at before update on public.project_tasks
  for each row execute function public.set_updated_at();

-- Every AI attempt at a task, successful or not, so history is honest.
create table public.task_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  task_id uuid not null references public.project_tasks (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  model_id text not null check (char_length(model_id) <= 120),
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'cancelled')),
  output text check (output is null or char_length(output) <= 60000),
  error text check (error is null or char_length(error) <= 2000),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index task_runs_task_idx on public.task_runs (task_id, started_at desc);
create index task_runs_project_idx on public.task_runs (project_id, started_at desc);
create index task_runs_user_idx on public.task_runs (user_id);

-- True when the task exists and belongs to the current user.
create or replace function public.owns_task(t uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.project_tasks where id = t and user_id = (select auth.uid()));
$$;

alter table public.project_tasks enable row level security;
alter table public.task_runs enable row level security;
create policy "project_tasks_all_own" on public.project_tasks for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and project_id is not null and public.owns_project(project_id));
create policy "task_runs_all_own" on public.task_runs for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.owns_task(task_id) and public.owns_project(project_id));
