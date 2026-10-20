-- ORBIS AI — three plans (Free, Pro, Max), monthly or annual billing, and an
-- atomic budget check. usage_reserve_v2 checks the 5-hour/weekly allowance
-- AND the account's monthly AI budget (money) under the same per-user lock,
-- counting requests in flight at their estimated cost, so concurrent requests
-- can't overspend. Admin finance figures come from admin_finance_summary.

alter table public.subscriptions drop constraint if exists subscriptions_plan_check;
alter table public.subscriptions add constraint subscriptions_plan_check check (plan in ('free', 'pro', 'max'));
alter table public.subscriptions
  add column if not exists billing_interval text not null default 'month' check (billing_interval in ('month', 'year')),
  add column if not exists price_usd numeric(10, 2);
comment on column public.subscriptions.price_usd is 'What the subscriber is charged per billing interval, in USD.';

alter table public.usage_holds add column if not exists est_cost_usd numeric(12, 6) not null default 0 check (est_cost_usd >= 0);

-- AI spend since a time: recorded runs (unpriced runs at the given fallback
-- prices per 1M tokens) plus requests in flight at their estimated cost.
create or replace function public.usage_spend(p_user uuid, p_since timestamptz, p_now timestamptz, p_fallback_in numeric, p_fallback_out numeric)
returns numeric
language sql stable
set search_path = ''
as $$
  select coalesce((
    select sum(coalesce(m.estimated_cost, (coalesce(m.input_tokens, 2000) * p_fallback_in + coalesce(m.output_tokens, 1000) * p_fallback_out) / 1000000.0))
    from public.model_runs m
    where m.user_id = p_user and m.created_at >= p_since and m.created_at <= p_now and coalesce(m.units, 0) > 0
  ), 0) + coalesce((
    select sum(h.est_cost_usd) from public.usage_holds h
    where h.user_id = p_user and h.state = 'active' and h.expires_at > p_now
  ), 0);
$$;
revoke all on function public.usage_spend(uuid, timestamptz, timestamptz, numeric, numeric) from public, anon, authenticated;

create or replace function public.usage_reserve_v2(
  p_request_id uuid,
  p_units numeric,
  p_window_limit numeric,
  p_week_limit numeric,
  p_est_cost_usd numeric,
  p_budget_usd numeric,          -- null: no money budget (administrators)
  p_period_start timestamptz,
  p_premium boolean,             -- the request uses a model other than the lowest-cost one
  p_premium_share numeric,
  p_fallback_in numeric,
  p_fallback_out numeric,
  p_purpose text default null,
  p_model text default null,
  p_ttl_seconds integer default 180
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  u record;
  ts timestamptz := now();
  spent numeric := 0;
  est numeric := greatest(coalesce(p_est_cost_usd, 0), 0);
begin
  if uid is null then
    raise exception 'Sign in required' using errcode = '28000';
  end if;
  if p_units is null or p_units < 0 or p_window_limit is null or p_week_limit is null then
    raise exception 'Invalid usage request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('orbis-usage:' || uid::text, 0));

  if exists (select 1 from public.usage_holds where user_id = uid and request_id = p_request_id)
     or exists (select 1 from public.model_runs where user_id = uid and request_id = p_request_id) then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end if;

  if p_budget_usd is not null then
    spent := public.usage_spend(uid, coalesce(p_period_start, date_trunc('month', ts)), ts, coalesce(p_fallback_in, 0), coalesce(p_fallback_out, 0));
    if spent >= p_budget_usd then
      return jsonb_build_object('ok', false, 'reason', 'budget', 'scope', 'exhausted', 'spent', spent, 'budget', p_budget_usd);
    end if;
    if spent + est > p_budget_usd then
      return jsonb_build_object('ok', false, 'reason', 'budget', 'scope', 'insufficient', 'spent', spent, 'budget', p_budget_usd, 'estimate', est);
    end if;
    if p_premium and spent + est > p_budget_usd * coalesce(p_premium_share, 1) then
      return jsonb_build_object('ok', false, 'reason', 'budget', 'scope', 'economy', 'spent', spent, 'budget', p_budget_usd, 'estimate', est);
    end if;
  end if;

  select * into u from public.usage_compute(uid, ts);
  if u.week_used + p_units > p_week_limit then
    return jsonb_build_object('ok', false, 'reason', 'limit', 'scope', 'week', 'used', u.week_used, 'limit', p_week_limit,
      'resets_at', coalesce(u.week_oldest, ts) + interval '7 days');
  end if;
  if u.window_used + p_units > p_window_limit then
    return jsonb_build_object('ok', false, 'reason', 'limit', 'scope', 'window', 'used', u.window_used, 'limit', p_window_limit,
      'resets_at', coalesce(u.window_start, ts) + interval '5 hours');
  end if;

  insert into public.usage_holds (user_id, request_id, units, est_cost_usd, purpose, model_id, expires_at)
  values (uid, p_request_id, p_units, est, left(p_purpose, 40), left(p_model, 120), ts + make_interval(secs => least(greatest(p_ttl_seconds, 30), 600)));
  return jsonb_build_object('ok', true, 'spent', spent, 'window_used', u.window_used + p_units, 'week_used', u.week_used + p_units);
end;
$$;
revoke all on function public.usage_reserve_v2(uuid, numeric, numeric, numeric, numeric, numeric, timestamptz, boolean, numeric, numeric, numeric, text, text, integer) from public, anon;
grant execute on function public.usage_reserve_v2(uuid, numeric, numeric, numeric, numeric, numeric, timestamptz, boolean, numeric, numeric, numeric, text, text, integer) to authenticated;

-- Business figures for administrators (aggregates and per-user totals; never prompts or replies).
create or replace function public.admin_finance_summary(p_since timestamptz)
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
  select jsonb_build_object(
    'subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object('plan', plan, 'interval', billing_interval, 'status', status, 'count', n, 'price_usd', price, 'canceling', canceling))
      from (
        select plan, billing_interval, status, count(*) n, max(price_usd) price, count(*) filter (where cancel_at_period_end) canceling
        from public.subscriptions group by plan, billing_interval, status
      ) s
    ), '[]'::jsonb),
    'canceled_since', (select count(*) from public.subscriptions where status = 'canceled' and updated_at >= p_since),
    'cost_by_plan', coalesce((
      select jsonb_object_agg(coalesce(entitlement, 'unknown'), cost) from (
        select entitlement, round(sum(coalesce(estimated_cost, 0))::numeric, 4) cost from public.model_runs where created_at >= p_since group by entitlement
      ) c
    ), '{}'::jsonb),
    'cost_by_model', coalesce((
      select jsonb_agg(jsonb_build_object('model', model_id, 'runs', runs, 'cost', cost, 'input_tokens', tin, 'output_tokens', tout) order by cost desc) from (
        select model_id, count(*) runs, round(sum(coalesce(estimated_cost, 0))::numeric, 4) cost, sum(coalesce(input_tokens, 0)) tin, sum(coalesce(output_tokens, 0)) tout
        from public.model_runs where created_at >= p_since group by model_id
      ) m
    ), '[]'::jsonb),
    'daily_cost', coalesce((
      select jsonb_agg(jsonb_build_object('day', day, 'cost', cost, 'runs', runs) order by day) from (
        select date_trunc('day', created_at)::date as day, round(sum(coalesce(estimated_cost, 0))::numeric, 4) as cost, count(*) as runs
        from public.model_runs where created_at >= now() - interval '30 days' group by 1
      ) d
    ), '[]'::jsonb),
    'top_users', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', t.user_id, 'email', u.email, 'plan', coalesce(sub.plan, 'free'), 'status', sub.status, 'interval', sub.billing_interval, 'period_start', sub.current_period_start, 'cost', t.cost, 'runs', t.runs, 'admin', exists (select 1 from public.admins a where a.user_id = t.user_id)) order by t.cost desc)
      from (
        select user_id, round(sum(coalesce(estimated_cost, 0))::numeric, 4) cost, count(*) runs
        from public.model_runs where created_at >= p_since group by user_id order by 2 desc limit 50
      ) t
      left join auth.users u on u.id = t.user_id
      left join public.subscriptions sub on sub.user_id = t.user_id
    ), '[]'::jsonb),
    'users_total', (select count(*) from auth.users)
  ) into result;
  return result;
end;
$$;
revoke all on function public.admin_finance_summary(timestamptz) from public, anon;
grant execute on function public.admin_finance_summary(timestamptz) to authenticated;
