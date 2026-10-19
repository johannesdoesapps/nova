-- NOVA AI — cost controls v4.
-- * usage_reserve_v4 = v3 plus a per-user daily money cap and a site-wide
--   monthly emergency cap (works without the service role key: the check runs
--   inside this SECURITY DEFINER function and returns only allowed/refused).
-- * model_runs.reserved_cost_usd keeps the pre-request estimate next to the
--   actual cost, so estimates can be reconciled with real usage.
-- * admin_finance_summary_v3 adds system health: active users, failure rates,
--   latency and provider errors.

alter table public.model_runs add column if not exists reserved_cost_usd numeric(12, 6) check (reserved_cost_usd is null or reserved_cost_usd >= 0);

create or replace function public.usage_reserve_v4(
  p_request_id uuid,
  p_units numeric,
  p_window_limit numeric,
  p_week_limit numeric,
  p_est_cost_usd numeric,
  p_est_tokens bigint,
  p_budget_usd numeric,          -- null: no money budget (administrators)
  p_premium_budget_usd numeric,  -- null: no separate premium budget
  p_premium boolean,             -- the request uses an advanced or premium model
  p_daily_limit integer,         -- 0 or null: no daily message cap
  p_token_limit bigint,          -- 0 or null: no token cap
  p_period_start timestamptz,
  p_fallback_in numeric,
  p_fallback_out numeric,
  p_purpose text default null,
  p_model text default null,
  p_ttl_seconds integer default 180,
  p_daily_budget_usd numeric default null,   -- null: no daily money cap
  p_site_cap_usd numeric default null        -- null: no site-wide monthly cap (emergency limit)
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  u record;
  ts timestamptz := now();
  since timestamptz := coalesce(p_period_start, date_trunc('month', now() at time zone 'utc') at time zone 'utc');
  day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  spent numeric := 0;
  premium_spent numeric := 0;
  msgs integer := 0;
  tokens bigint := 0;
  est numeric := greatest(coalesce(p_est_cost_usd, 0), 0);
  est_tok bigint := greatest(coalesce(p_est_tokens, 0), 0);
begin
  if uid is null then
    raise exception 'Sign in required' using errcode = '28000';
  end if;
  if p_units is null or p_units < 0 or p_window_limit is null or p_week_limit is null then
    raise exception 'Invalid usage request' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('nova-usage:' || uid::text, 0));

  if exists (select 1 from public.usage_holds where user_id = uid and request_id = p_request_id)
     or exists (select 1 from public.model_runs where user_id = uid and request_id = p_request_id) then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
  end if;

  if p_budget_usd is not null then
    spent := public.usage_spend(uid, since, ts, coalesce(p_fallback_in, 0), coalesce(p_fallback_out, 0));
    if spent >= p_budget_usd then
      return jsonb_build_object('ok', false, 'reason', 'budget', 'scope', 'exhausted', 'spent', spent, 'budget', p_budget_usd);
    end if;
    if spent + est > p_budget_usd then
      return jsonb_build_object('ok', false, 'reason', 'budget', 'scope', 'insufficient', 'spent', spent, 'budget', p_budget_usd, 'estimate', est);
    end if;
    if p_premium and p_premium_budget_usd is not null then
      premium_spent := public.usage_premium_spend(uid, since, ts, coalesce(p_fallback_in, 0), coalesce(p_fallback_out, 0));
      if premium_spent + est > p_premium_budget_usd then
        return jsonb_build_object('ok', false, 'reason', 'budget', 'scope', 'premium', 'spent', premium_spent, 'budget', p_premium_budget_usd, 'estimate', est);
      end if;
    end if;
  end if;

  if p_daily_budget_usd is not null and public.usage_spend(uid, day_start, ts, coalesce(p_fallback_in, 0), coalesce(p_fallback_out, 0)) + est > p_daily_budget_usd then
    return jsonb_build_object('ok', false, 'reason', 'budget', 'scope', 'daily', 'budget', p_daily_budget_usd,
      'resets_at', day_start + interval '1 day');
  end if;

  -- Site-wide emergency limit: everyone's recorded spend this calendar month plus requests in flight.
  if p_site_cap_usd is not null and (
    coalesce((select sum(m.estimated_cost) from public.model_runs m
      where m.created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc' and coalesce(m.units, 0) > 0), 0)
    + coalesce((select sum(h.est_cost_usd) from public.usage_holds h where h.state = 'active' and h.expires_at > ts), 0)
    + est > p_site_cap_usd) then
    return jsonb_build_object('ok', false, 'reason', 'budget', 'scope', 'site');
  end if;

  if coalesce(p_daily_limit, 0) > 0 then
    select
      (select count(distinct coalesce(m.request_id::text, m.id::text)) from public.model_runs m
        where m.user_id = uid and m.created_at >= day_start and coalesce(m.units, 0) > 0)
      + (select count(*) from public.usage_holds h
        where h.user_id = uid and h.state = 'active' and h.expires_at > ts and h.created_at >= day_start
          and not exists (select 1 from public.model_runs m2 where m2.user_id = uid and m2.request_id = h.request_id))
    into msgs;
    if msgs >= p_daily_limit then
      return jsonb_build_object('ok', false, 'reason', 'limit', 'scope', 'day', 'used', msgs, 'limit', p_daily_limit,
        'resets_at', day_start + interval '1 day');
    end if;
  end if;

  if coalesce(p_token_limit, 0) > 0 then
    select coalesce((select sum(coalesce(m.input_tokens, 0) + coalesce(m.output_tokens, 0)) from public.model_runs m
        where m.user_id = uid and m.created_at >= since and coalesce(m.units, 0) > 0), 0)
      + public.usage_held_tokens(uid, ts)
    into tokens;
    if tokens + est_tok > p_token_limit then
      return jsonb_build_object('ok', false, 'reason', 'tokens', 'used', tokens, 'limit', p_token_limit);
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

  insert into public.usage_holds (user_id, request_id, units, est_cost_usd, est_tokens, premium, purpose, model_id, expires_at)
  values (uid, p_request_id, p_units, est, est_tok, coalesce(p_premium, false), left(p_purpose, 40), left(p_model, 120),
    ts + make_interval(secs => least(greatest(p_ttl_seconds, 30), 600)));
  return jsonb_build_object('ok', true, 'spent', spent, 'premium_spent', premium_spent, 'messages_today', msgs + 1, 'tokens', tokens,
    'window_used', u.window_used + p_units, 'week_used', u.week_used + p_units);
end;
$$;
revoke all on function public.usage_reserve_v4(uuid, numeric, numeric, numeric, numeric, bigint, numeric, numeric, boolean, integer, bigint, timestamptz, numeric, numeric, text, text, integer, numeric, numeric) from public, anon;
grant execute on function public.usage_reserve_v4(uuid, numeric, numeric, numeric, numeric, bigint, numeric, numeric, boolean, integer, bigint, timestamptz, numeric, numeric, text, text, integer, numeric, numeric) to authenticated;

create or replace function public.admin_finance_summary_v3(p_since timestamptz)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
begin
  return public.admin_finance_summary_v2(p_since) || jsonb_build_object(
    'active_users', jsonb_build_object(
      'd1', (select count(distinct user_id) from public.model_runs where created_at >= now() - interval '1 day'),
      'd7', (select count(distinct user_id) from public.model_runs where created_at >= now() - interval '7 days'),
      'd30', (select count(distinct user_id) from public.model_runs where created_at >= now() - interval '30 days')),
    'health', coalesce((
      select jsonb_agg(jsonb_build_object('provider', provider, 'calls', calls, 'errors', errors,
        'p50_ms', p50, 'p95_ms', p95, 'reserved', reserved, 'actual', actual) order by calls desc)
      from (
        select provider, count(*) as calls, count(*) filter (where status = 'error') as errors,
          round(percentile_cont(0.5) within group (order by latency_ms)) as p50,
          round(percentile_cont(0.95) within group (order by latency_ms)) as p95,
          round(sum(reserved_cost_usd) filter (where reserved_cost_usd is not null and estimated_cost is not null)::numeric, 4) as reserved,
          round(sum(estimated_cost) filter (where reserved_cost_usd is not null and estimated_cost is not null)::numeric, 4) as actual
        from public.model_runs where created_at >= p_since group by provider
      ) h
    ), '[]'::jsonb),
    'top_errors', coalesce((
      select jsonb_agg(jsonb_build_object('error', e, 'count', n) order by n desc) from (
        select left(error_code, 120) as e, count(*) as n from public.model_runs
        where created_at >= p_since and status = 'error' and error_code is not null group by 1 order by 2 desc limit 8
      ) x
    ), '[]'::jsonb),
    'heavy_users_24h', coalesce((
      select jsonb_agg(jsonb_build_object('email', u.email, 'calls', t.calls, 'cost', t.cost) order by t.calls desc)
      from (
        select user_id, count(*) as calls, round(sum(coalesce(estimated_cost, 0))::numeric, 4) as cost
        from public.model_runs where created_at >= now() - interval '1 day' group by user_id having count(*) >= 100 order by 2 desc limit 10
      ) t left join auth.users u on u.id = t.user_id
    ), '[]'::jsonb)
  );
end;
$$;
revoke all on function public.admin_finance_summary_v3(timestamptz) from public, anon;
grant execute on function public.admin_finance_summary_v3(timestamptz) to authenticated;
