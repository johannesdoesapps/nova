-- ORBIS AI — code runs (the Run button on code blocks).
-- A run is reserved like an AI request (usage_reserve_v4, purpose 'code_run',
-- so duplicates are refused and it's held while it runs) and recorded in
-- model_runs with tools = {code_run}. This function counts the caller's runs
-- this period, including requests still running (their holds), and everyone's
-- runs this calendar month for the site-wide limit. It returns counts only.
-- Counting holds as well as recorded runs means concurrent requests can't
-- slip past the allowance: each sees the others' holds.

create or replace function public.code_run_status(p_since timestamptz)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  ts timestamptz := now();
  month_start timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
begin
  if uid is null then
    raise exception 'Sign in required' using errcode = '28000';
  end if;
  return jsonb_build_object(
    'user_runs', (select count(*) from public.model_runs m
      where m.user_id = uid and m.created_at >= coalesce(p_since, month_start) and m.tools @> array['code_run']),
    'user_in_flight', (select count(*) from public.usage_holds h
      where h.user_id = uid and h.purpose = 'code_run' and h.state = 'active' and h.expires_at > ts
        and not exists (select 1 from public.model_runs r where r.user_id = uid and r.request_id = h.request_id)),
    'site_runs', (select count(*) from public.model_runs m
      where m.created_at >= month_start and m.tools @> array['code_run'])
      + (select count(*) from public.usage_holds h
      where h.purpose = 'code_run' and h.state = 'active' and h.expires_at > ts
        and not exists (select 1 from public.model_runs r where r.request_id = h.request_id))
  );
end;
$$;
revoke all on function public.code_run_status(timestamptz) from public, anon;
grant execute on function public.code_run_status(timestamptz) to authenticated;
