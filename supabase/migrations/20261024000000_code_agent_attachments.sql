-- Files and images a user attaches to a coding task. Uploaded first (not yet
-- tied to a run), then linked to the run the task starts. Text is stored as
-- text; images as base64 (JPEG or PNG, checked by the server from their
-- bytes). Only the uploader, on their own project, can see them; they go with
-- the project or the run.

create table if not exists public.code_agent_attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid not null references public.code_projects (id) on delete cascade,
  run_id uuid references public.code_agent_runs (id) on delete cascade,
  name text not null check (
    char_length(name) between 1 and 300
    and name !~ '^/'
    and name !~ '(^|/)\.{1,2}(/|$)'
    and name !~ '[\\[:cntrl:]]'
  ),
  kind text not null check (kind in ('text', 'image')),
  media_type text not null check (media_type in ('text/plain', 'image/jpeg', 'image/png')),
  size int not null check (size between 0 and 3000000),
  content text not null check (
    (kind = 'text' and media_type = 'text/plain' and octet_length(content) <= 204800)
    or (kind = 'image' and media_type in ('image/jpeg', 'image/png') and octet_length(content) <= 3500000)
  ),
  created_at timestamptz not null default now()
);
create index if not exists code_agent_attachments_run on public.code_agent_attachments (run_id);
create index if not exists code_agent_attachments_user_created on public.code_agent_attachments (user_id, created_at);

-- At most 40 attachments waiting to be used (not yet part of a task) per user, and 20 per task.
create or replace function public.code_agent_attachments_limits()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.run_id is null and (select count(*) from public.code_agent_attachments a where a.user_id = new.user_id and a.run_id is null and a.id <> new.id) >= 40 then
    raise exception 'Too many attachments waiting to be sent. Remove some, or send the task.' using errcode = '54000';
  end if;
  if new.run_id is not null and (select count(*) from public.code_agent_attachments a where a.run_id = new.run_id and a.id <> new.id) >= 20 then
    raise exception 'A task can have at most 20 attachments.' using errcode = '54000';
  end if;
  return new;
end;
$$;
revoke all on function public.code_agent_attachments_limits() from public, anon, authenticated;

drop trigger if exists code_agent_attachments_limits on public.code_agent_attachments;
create trigger code_agent_attachments_limits before insert or update on public.code_agent_attachments
  for each row execute function public.code_agent_attachments_limits();

alter table public.code_agent_attachments enable row level security;

drop policy if exists code_agent_attachments_own on public.code_agent_attachments;
create policy code_agent_attachments_own on public.code_agent_attachments for all to authenticated
  using (user_id = (select auth.uid()) and exists (select 1 from public.code_projects p where p.id = code_agent_attachments.project_id and p.user_id = (select auth.uid())))
  with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.code_projects p where p.id = code_agent_attachments.project_id and p.user_id = (select auth.uid()))
    -- Qualified: inside the subquery a bare project_id would be the run's own column.
    and (code_agent_attachments.run_id is null or exists (select 1 from public.code_agent_runs r where r.id = code_agent_attachments.run_id and r.project_id = code_agent_attachments.project_id and r.user_id = (select auth.uid())))
  );

-- Contents never change after upload; only the run they belong to is set (once, by the server).
revoke all on public.code_agent_attachments from anon, authenticated;
grant select, delete on public.code_agent_attachments to authenticated;
grant insert (project_id, name, kind, media_type, size, content) on public.code_agent_attachments to authenticated;
grant update (run_id) on public.code_agent_attachments to authenticated;
