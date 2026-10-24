-- ORBIS AI — unit economics for administrators (Admin → Finance).
-- Measured costs only, from the usage records (model_runs.estimated_cost, from provider-reported tokens
-- and verified prices; sandbox time for code runs and the workspace computer), coding tasks
-- (code_agent_runs.usage.costUsd) and collected revenue (billing_ledger, from Stripe). Nothing is
-- estimated here; the page shows what's missing. Administrators only (refuses everyone else).

create or replace function public.admin_unit_economics(p_since timestamptz)
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

  with runs as (
    select m.user_id, coalesce(m.entitlement, 'guest') as ent, coalesce(m.purpose, 'chat') as purpose, m.status, coalesce(m.estimated_cost, 0)::numeric as cost,
           coalesce(m.paid_with_credits, false) as credits
    from public.model_runs m
    where m.created_at >= p_since
  ),
  per_user as (
    select user_id, sum(cost) as cost from runs where user_id is not null and ent <> 'admin_unlimited' group by user_id
  ),
  ranked as (
    select cost, row_number() over (order by cost desc) as rk, count(*) over () as n from per_user
  ),
  tasks as (
    -- Cost: the final report's figure, else the running total. State: the report's (older reports only
    -- say whether tests passed).
    select t.status, coalesce((t.report->'usage'->>'costUsd')::numeric, (t.usage->>'costUsd')::numeric, 0) as cost,
           coalesce(t.report->>'state', case when t.report->>'verification' = 'passed' then 'verified' end) as state, (t.pair is not null) as pair
    from public.code_agent_runs t
    where t.created_at >= p_since
  )
  select jsonb_build_object(
    'by_plan', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entitlement', ent,
        'active_users', users,
        'calls', calls,
        'failed_calls', failed,
        'model_cost_usd', model_cost,
        'sandbox_cost_usd', sandbox_cost,
        'credit_cost_usd', credit_cost
      ) order by ent)
      from (
        select ent,
               count(distinct user_id) as users,
               count(*) filter (where purpose not in ('code_workspace', 'code_run')) as calls,
               count(*) filter (where status <> 'success') as failed,
               round(sum(cost) filter (where purpose not in ('code_workspace', 'code_run')), 6) as model_cost,
               round(sum(cost) filter (where purpose in ('code_workspace', 'code_run')), 6) as sandbox_cost,
               round(sum(cost) filter (where credits), 6) as credit_cost
        from runs group by ent
      ) p
    ), '[]'::jsonb),
    'by_purpose', coalesce((
      select jsonb_agg(jsonb_build_object('purpose', purpose, 'calls', calls, 'cost_usd', cost) order by cost desc)
      from (select coalesce(purpose, 'chat') as purpose, count(*) as calls, round(sum(cost), 6) as cost from runs group by 1) x
    ), '[]'::jsonb),
    'concentration', (
      select jsonb_build_object(
        'paying_or_free_users', coalesce(max(n), 0),
        'total_cost_usd', round(coalesce(sum(cost), 0), 6),
        'top_user_cost_usd', round(coalesce(max(cost) filter (where rk = 1), 0), 6),
        'top_10pct_cost_usd', round(coalesce(sum(cost) filter (where rk <= greatest(1, ceil(n * 0.1))), 0), 6)
      ) from ranked
    ),
    'tasks', (
      select jsonb_build_object(
        'total', count(*),
        'completed', count(*) filter (where status = 'completed'),
        'succeeded', count(*) filter (where status = 'completed' and state in ('verified', 'checked')),
        'failed', count(*) filter (where status = 'failed'),
        'cancelled', count(*) filter (where status = 'cancelled'),
        'open', count(*) filter (where status not in ('completed', 'failed', 'cancelled')),
        'pair', count(*) filter (where pair),
        'cost_usd', round(coalesce(sum(cost), 0), 6),
        'succeeded_cost_usd', round(coalesce(sum(cost) filter (where status = 'completed' and state in ('verified', 'checked')), 0), 6),
        'failed_or_cancelled_cost_usd', round(coalesce(sum(cost) filter (where status in ('failed', 'cancelled')), 0), 6)
      ) from tasks
    ),
    'revenue', coalesce((
      select jsonb_agg(jsonb_build_object('plan', plan, 'kind', kind, 'count', n, 'amount_usd', amount) order by plan, kind)
      from (select coalesce(plan, 'unknown') as plan, kind, count(*) as n, round(sum(amount_usd), 2) as amount from public.billing_ledger where occurred_at >= p_since group by 1, 2) r
    ), '[]'::jsonb),
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object('plan', plan, 'status', status, 'count', n))
      from (select plan, status, count(*) as n from public.subscriptions group by plan, status) s
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.admin_unit_economics(timestamptz) from public, anon;
grant execute on function public.admin_unit_economics(timestamptz) to authenticated;
