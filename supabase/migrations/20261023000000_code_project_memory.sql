-- Project memory for Orbis Code: notes the agent reads before working on a
-- project — instructions, architecture notes, decisions, preferences — and
-- reusable workflows. Written by the user, or suggested by the agent and kept
-- as "proposed" until the user approves them (proposed notes are never given
-- to the agent). Only the project's owner can see or change them.

create table if not exists public.code_project_memory (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.code_projects (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('instruction', 'architecture', 'decision', 'preference', 'workflow')),
  title text not null check (char_length(btrim(title)) between 1 and 120),
  content text not null check (char_length(btrim(content)) between 1 and 4000),
  -- Given to the agent on every task, not only when it looks relevant.
  always boolean not null default false,
  status text not null default 'active' check (status in ('active', 'proposed')),
  source text not null default 'user' check (source in ('user', 'agent')),
  run_id uuid references public.code_agent_runs (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists code_project_memory_project on public.code_project_memory (project_id, updated_at desc);
create index if not exists code_project_memory_user on public.code_project_memory (user_id);

-- At most 100 notes per project, of which at most 20 waiting for approval.
create or replace function public.code_project_memory_limits()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  n int;
  p int;
begin
  perform 1 from public.code_projects where id = new.project_id for update;
  select count(*), count(*) filter (where status = 'proposed') into n, p
    from public.code_project_memory m where m.project_id = new.project_id and m.id <> new.id;
  if n + 1 > 100 then
    raise exception 'A project can keep at most 100 memory notes.' using errcode = '54000';
  end if;
  if new.status = 'proposed' and p + 1 > 20 then
    raise exception 'There are already 20 suggested notes waiting for review.' using errcode = '54000';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function public.code_project_memory_limits() from public, anon, authenticated;

drop trigger if exists code_project_memory_limits on public.code_project_memory;
create trigger code_project_memory_limits before insert or update on public.code_project_memory
  for each row execute function public.code_project_memory_limits();

alter table public.code_project_memory enable row level security;

drop policy if exists code_project_memory_own on public.code_project_memory;
create policy code_project_memory_own on public.code_project_memory for all to authenticated
  using (user_id = (select auth.uid()) and exists (select 1 from public.code_projects p where p.id = project_id and p.user_id = (select auth.uid())))
  with check (user_id = (select auth.uid()) and exists (select 1 from public.code_projects p where p.id = project_id and p.user_id = (select auth.uid())));

-- Only the columns a user may set; id, owner and project never change.
revoke all on public.code_project_memory from anon, authenticated;
grant select, delete on public.code_project_memory to authenticated;
grant insert (project_id, kind, title, content, always, status, source, run_id) on public.code_project_memory to authenticated;
grant update (kind, title, content, always, status) on public.code_project_memory to authenticated;
