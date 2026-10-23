-- Onboarding in the activation funnel, from records that already exist: the starting point people picked (or that
-- they skipped) in first-run onboarding (profiles.preferences.onboarding), and whether they came back for another
-- task on a later day (model_runs). Counts only, never what anyone typed; administrators only. Additive only.

create or replace function public.admin_onboarding_funnel(p_since timestamptz)
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
    select p.id, p.created_at, p.preferences -> 'onboarding' as ob
    from public.profiles p
    join auth.users u on u.id = p.id
    where p.created_at >= p_since
      and coalesce(u.email, '') not like '%@orbis.invalid'
      and not exists (select 1 from public.admins a where a.user_id = p.id)
  ),
  days as (
    select pe.id, count(distinct date_trunc('day', m.created_at)) as active_days
    from people pe join public.model_runs m on m.user_id = pe.id
    group by pe.id
  )
  select jsonb_build_object(
    'signups', (select count(*) from people),
    'chosen', coalesce((select jsonb_object_agg(path, n) from (select coalesce(ob ->> 'path', 'none') as path, count(*) as n from people where ob ->> 'status' = 'chosen' group by 1) c), '{}'::jsonb),
    'skipped', (select count(*) from people where ob ->> 'status' = 'skipped'),
    'returned', (select count(*) from days where active_days >= 2)
  ) into result;
  return result;
end;
$$;
revoke all on function public.admin_onboarding_funnel(timestamptz) from public, anon;
grant execute on function public.admin_onboarding_funnel(timestamptz) to authenticated;
