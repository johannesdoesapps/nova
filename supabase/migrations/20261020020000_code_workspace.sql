-- ORBIS AI — Code workspace: projects and their files, kept in the database.
-- A project's files are the source of truth; a workspace computer (a Vercel
-- Sandbox) gets a copy while it runs, and files a command creates or changes
-- there are copied back. Owners only, enforced by row-level security.
--
-- Limits, enforced here so no client can get past them:
--   300 files per project, 200 KB per file, 3 MB per project;
--   paths are plain relative paths (no leading slash, no "." or ".." parts).
-- The number of projects a user may keep depends on the plan and is checked
-- by the API.

create table if not exists public.code_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  template text not null default 'blank' check (template in ('blank', 'python', 'node', 'website', 'github')),
  run_command text not null default '' check (char_length(run_command) <= 500),
  source_repo text check (source_repo is null or char_length(source_repo) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists code_projects_user_updated on public.code_projects (user_id, updated_at desc);

create table if not exists public.code_files (
  project_id uuid not null references public.code_projects (id) on delete cascade,
  path text not null check (
    char_length(path) between 1 and 300
    and path !~ '^/'
    and path !~ '(^|/)\.{1,2}(/|$)'
    and path !~ '//'
    and path !~ '[\\[:cntrl:]]'
  ),
  content text not null default '' check (octet_length(content) <= 204800),
  updated_at timestamptz not null default now(),
  primary key (project_id, path)
);

-- Count and size limits per project. Locks the project row so concurrent
-- writes to one project are checked one at a time.
create or replace function public.code_files_limits()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  n int;
  total bigint;
begin
  perform 1 from public.code_projects where id = new.project_id for update;
  select count(*), coalesce(sum(octet_length(content)), 0) into n, total
    from public.code_files f where f.project_id = new.project_id and f.path <> new.path
      and not (tg_op = 'UPDATE' and f.project_id = old.project_id and f.path = old.path);
  if n + 1 > 300 then
    raise exception 'A project can have at most 300 files.' using errcode = '54000';
  end if;
  if total + octet_length(new.content) > 3145728 then
    raise exception 'A project can hold at most 3 MB of files.' using errcode = '54000';
  end if;
  new.updated_at := now();
  update public.code_projects set updated_at = now() where id = new.project_id;
  return new;
end;
$$;
revoke all on function public.code_files_limits() from public, anon, authenticated;

drop trigger if exists code_files_limits on public.code_files;
create trigger code_files_limits before insert or update on public.code_files
  for each row execute function public.code_files_limits();

create or replace function public.code_projects_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists code_projects_touch on public.code_projects;
create trigger code_projects_touch before update on public.code_projects
  for each row execute function public.code_projects_touch();

alter table public.code_projects enable row level security;
alter table public.code_files enable row level security;

drop policy if exists code_projects_own on public.code_projects;
create policy code_projects_own on public.code_projects for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists code_files_own on public.code_files;
create policy code_files_own on public.code_files for all to authenticated
  using (exists (select 1 from public.code_projects p where p.id = project_id and p.user_id = (select auth.uid())))
  with check (exists (select 1 from public.code_projects p where p.id = project_id and p.user_id = (select auth.uid())));

-- Only the columns a user may set. A project's id names its workspace
-- computer, so it can never change; nor can the owner.
revoke all on public.code_projects from anon, authenticated;
revoke all on public.code_files from anon, authenticated;
grant select, delete on public.code_projects to authenticated;
grant insert (name, template, run_command, source_repo) on public.code_projects to authenticated;
grant update (name, run_command) on public.code_projects to authenticated;
grant select, delete on public.code_files to authenticated;
grant insert (project_id, path, content) on public.code_files to authenticated;
grant update (project_id, path, content) on public.code_files to authenticated;

-- Workspace time, counted in blocks of minutes. A session is one workspace
-- computer: its first block starts it and later blocks keep it going; it
-- runs until its first block's start plus all its blocks' minutes. Blocks
-- are written only by code_workspace_reserve (callers can't insert, change or
-- delete them), so what a user has used can't be lowered from the browser,
-- and a session's computer name (from its first block's id) can't be forged.
-- The API starts the computer first and then reserves its block; when the
-- reserve is refused the computer is stopped at once.
create table if not exists public.code_workspace_blocks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid references public.code_projects (id) on delete set null,
  minutes int not null check (minutes between 1 and 60),
  created_at timestamptz not null default now()
);
create index if not exists code_workspace_blocks_user on public.code_workspace_blocks (user_id, created_at);
create index if not exists code_workspace_blocks_created on public.code_workspace_blocks (created_at);
create index if not exists code_workspace_blocks_session on public.code_workspace_blocks (session_id);
alter table public.code_workspace_blocks enable row level security;
drop policy if exists code_workspace_blocks_select_own on public.code_workspace_blocks;
create policy code_workspace_blocks_select_own on public.code_workspace_blocks for select to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.code_workspace_blocks from anon, authenticated;
grant select on public.code_workspace_blocks to authenticated;

-- Sessions still running (start + minutes in the future), everyone's.
create or replace view public.code_workspace_live with (security_invoker = true) as
  select session_id, min(user_id::text)::uuid as user_id, min(project_id::text)::uuid as project_id,
    min(created_at) as started_at, min(created_at) + make_interval(mins => sum(minutes)::int) as ends_at
  from public.code_workspace_blocks
  group by session_id
  having min(created_at) + make_interval(mins => sum(minutes)::int) > now();
revoke all on public.code_workspace_live from anon, authenticated;
grant select on public.code_workspace_live to authenticated;

-- Minutes the caller used since p_since, everyone's this calendar month, and
-- how many sessions are running site-wide.
create or replace function public.code_workspace_status(p_since timestamptz)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  month_start timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
begin
  if uid is null then
    raise exception 'Sign in required' using errcode = '28000';
  end if;
  return jsonb_build_object(
    'user_minutes', (select coalesce(sum(minutes), 0) from public.code_workspace_blocks
      where user_id = uid and created_at >= coalesce(p_since, month_start)),
    'site_minutes', (select coalesce(sum(minutes), 0) from public.code_workspace_blocks
      where created_at >= month_start),
    'site_live', (select count(*) from public.code_workspace_live)
  );
end;
$$;
revoke all on function public.code_workspace_status(timestamptz) from public, anon;
grant execute on function public.code_workspace_status(timestamptz) to authenticated;

-- Reserve a block for the caller's project if it fits within the caller's
-- minutes since p_since (p_user_limit; null = no limit), the site's this
-- month (p_site_limit; 0 = none) and, for a new session, the number of
-- sessions running at once (p_site_concurrent; 0 = none). p_session continues
-- a running session of the same project instead of starting one; p_block is
-- the new block's id, chosen by the API so it can name the session's computer
-- before reserving. Reserves run one at a time, so concurrent starts can't
-- slip past any limit. Calling it directly can only add to the caller's own
-- usage.
create or replace function public.code_workspace_reserve(p_block uuid, p_project uuid, p_session uuid, p_minutes int, p_since timestamptz, p_user_limit int, p_site_limit int, p_site_concurrent int)
returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  month_start timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
  used int;
  site int;
  live int;
  block_id uuid := coalesce(p_block, gen_random_uuid());
  ends timestamptz;
begin
  if uid is null then
    raise exception 'Sign in required' using errcode = '28000';
  end if;
  if p_minutes is null or p_minutes < 1 or p_minutes > 60 then
    raise exception 'Invalid block length' using errcode = '22023';
  end if;
  if not exists (select 1 from public.code_projects where id = p_project and user_id = uid) then
    raise exception 'Project not found' using errcode = '42704';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('orbis-workspace', 0));
  if p_session is not null then
    select l.ends_at into ends from public.code_workspace_live l
      where l.session_id = p_session and l.user_id = uid and l.project_id = p_project;
    if ends is null then
      return jsonb_build_object('ok', false, 'reason', 'ended');
    end if;
  end if;
  select coalesce(sum(minutes), 0) into used from public.code_workspace_blocks
    where user_id = uid and created_at >= coalesce(p_since, month_start);
  select coalesce(sum(minutes), 0) into site from public.code_workspace_blocks where created_at >= month_start;
  select count(*) into live from public.code_workspace_live;
  if p_user_limit is not null and used + p_minutes > p_user_limit then
    return jsonb_build_object('ok', false, 'reason', 'user', 'used', used);
  end if;
  if coalesce(p_site_limit, 0) > 0 and site + p_minutes > p_site_limit then
    return jsonb_build_object('ok', false, 'reason', 'site', 'used', used);
  end if;
  if p_session is null and coalesce(p_site_concurrent, 0) > 0 and live >= p_site_concurrent then
    return jsonb_build_object('ok', false, 'reason', 'busy', 'used', used);
  end if;
  insert into public.code_workspace_blocks (id, session_id, user_id, project_id, minutes)
    values (block_id, coalesce(p_session, block_id), uid, p_project, p_minutes);
  return jsonb_build_object('ok', true, 'id', block_id, 'session', coalesce(p_session, block_id), 'used', used + p_minutes);
end;
$$;
revoke all on function public.code_workspace_reserve(uuid, uuid, uuid, int, timestamptz, int, int, int) from public, anon;
grant execute on function public.code_workspace_reserve(uuid, uuid, uuid, int, timestamptz, int, int, int) to authenticated;
