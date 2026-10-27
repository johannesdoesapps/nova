-- ORBIS AI — Larger Code projects.
--
-- 1. Every project can hold 1,000 files and 20 MB (was 300 files and 3 MB);
--    administrators keep 2,000 files and 20 MB so Orbis's own code fits.
-- 2. One file can be up to 1 MB (was 200 KB). The coding agent's change
--    records (before/after of one file) follow the same limit.
-- 3. Room for those files where a run keeps several at once: checkpoints (the
--    files a run changed) and a run's waiting state (edits awaiting review).
--
-- Only limits are raised; no data changes.

alter table public.code_files drop constraint if exists code_files_content_check;
alter table public.code_files add constraint code_files_content_check check (octet_length(content) <= 1048576);

alter table public.code_agent_changes drop constraint if exists code_agent_changes_before_check;
alter table public.code_agent_changes add constraint code_agent_changes_before_check check (before is null or octet_length(before) <= 1048576);
alter table public.code_agent_changes drop constraint if exists code_agent_changes_after_check;
alter table public.code_agent_changes add constraint code_agent_changes_after_check check (after is null or octet_length(after) <= 1048576);

alter table public.code_agent_checkpoints drop constraint if exists code_agent_checkpoints_files_check;
alter table public.code_agent_checkpoints add constraint code_agent_checkpoints_files_check check (octet_length(files::text) <= 24000000);

alter table public.code_agent_runs drop constraint if exists code_agent_runs_pending_check;
alter table public.code_agent_runs add constraint code_agent_runs_pending_check check (pending is null or octet_length(pending::text) <= 6000000);

create or replace function public.code_files_limits()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  n int;
  total bigint;
  max_files int := 1000;
  max_bytes bigint := 20971520;
begin
  perform 1 from public.code_projects where id = new.project_id for update;
  if exists (select 1 from public.code_projects p join public.admins a on a.user_id = p.user_id where p.id = new.project_id) then
    max_files := 2000;
  end if;
  select count(*), coalesce(sum(octet_length(content)), 0) into n, total
    from public.code_files f where f.project_id = new.project_id and f.path <> new.path
      and not (tg_op = 'UPDATE' and f.project_id = old.project_id and f.path = old.path);
  if n + 1 > max_files then
    raise exception 'A project can have at most % files.', max_files using errcode = '54000';
  end if;
  if total + octet_length(new.content) > max_bytes then
    raise exception 'A project can hold at most % MB of files.', max_bytes / 1048576 using errcode = '54000';
  end if;
  new.updated_at := now();
  update public.code_projects set updated_at = now() where id = new.project_id;
  return new;
end;
$$;
revoke all on function public.code_files_limits() from public, anon, authenticated;
