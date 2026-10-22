-- ORBIS AI — Code projects that track a GitHub repository.
--
-- 1. Administrators get larger projects (2,000 files, 20 MB) so Orbis's own
--    code fits; everyone else keeps 300 files and 3 MB.
-- 2. code_projects.source_base: for a project imported from GitHub, the git
--    blob id of each file as it was on GitHub when last imported or updated
--    ({"path": "sha", ...}). "Update from GitHub" compares GitHub now, the
--    project now and this base, so edits made in Orbis are never overwritten,
--    and "Push to GitHub" sends only the files changed in Orbis.

alter table public.code_projects add column if not exists source_base jsonb
  check (source_base is null or (jsonb_typeof(source_base) = 'object' and octet_length(source_base::text) <= 400000));
grant insert (source_base) on public.code_projects to authenticated;
grant update (source_base) on public.code_projects to authenticated;

create or replace function public.code_files_limits()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  n int;
  total bigint;
  max_files int := 300;
  max_bytes bigint := 3145728;
begin
  perform 1 from public.code_projects where id = new.project_id for update;
  if exists (select 1 from public.code_projects p join public.admins a on a.user_id = p.user_id where p.id = new.project_id) then
    max_files := 2000;
    max_bytes := 20971520;
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
