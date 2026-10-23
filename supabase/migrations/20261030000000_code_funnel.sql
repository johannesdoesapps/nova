-- The coding agent's part of the sign-up funnel, from records that already exist (code_agent_runs):
-- of people who signed up in the period, how many started a coding agent run within 7 days, and how
-- many had one finish. Counts only; administrators only. Additive only.

create or replace function public.admin_code_funnel(p_since timestamptz)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not exists (select 1 from public.admins a where a.user_id = (select auth.uid())) then
    raise exception 'Administrators only' using errcode = '42501';
  end if;

  with people as (
    select p.id, p.created_at
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.created_at >= p_since
      and coalesce(u.email, '') not like '%@orbis.invalid'
      and not exists (select 1 from public.admins a where a.user_id = p.id)
  ),
  firsts as (
    select pe.id,
      min(r.created_at) as first_run,
      min(r.created_at) filter (where r.status = 'completed') as first_done
    from people pe
    join public.code_agent_runs r on r.user_id = pe.id and r.created_at < pe.created_at + interval '7 days'
    group by pe.id
  )
  select jsonb_build_object(
    'signups', (select count(*) from people),
    'started', (select count(*) from firsts),
    'completed', (select count(*) from firsts where first_done is not null),
    'minutes_to_first_run', (select percentile_cont(0.5) within group (order by extract(epoch from (f.first_run - pe.created_at)) / 60) from firsts f join people pe on pe.id = f.id)
  ) into result;
  return result;
end;
$$;
revoke all on function public.admin_code_funnel(timestamptz) from public, anon;
grant execute on function public.admin_code_funnel(timestamptz) to authenticated;
