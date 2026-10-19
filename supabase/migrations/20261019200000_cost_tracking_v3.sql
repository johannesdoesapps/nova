-- NOVA AI — cost tracking and budget guard v3.
-- * model_runs records the provider, the model's plan tier and prompt-cache
--   writes, so costs can be broken down by provider and the premium budget
--   (advanced + premium models) enforced on its own.
-- * usage_reserve_v3 checks, under one per-user lock: the monthly AI budget,
--   the premium-model budget, the daily message cap, the monthly token cap and
--   the 5-hour/weekly units, counting requests still in flight.
-- * stripe_events makes webhook handling idempotent; billing_ledger records
--   money actually collected (excluding tax), refunds and failed payments.

alter table public.model_runs
  add column if not exists model_tier text check (model_tier in ('standard', 'advanced', 'premium')),
  add column if not exists cache_write_input_tokens integer check (cache_write_input_tokens >= 0),
  add column if not exists provider text generated always as (split_part(model_id, ':', 1)) stored;
alter table public.model_runs add constraint model_runs_cost_nonnegative
  check (estimated_cost is null or estimated_cost >= 0) not valid;
alter table public.model_runs add constraint model_runs_tokens_nonnegative
  check ((input_tokens is null or input_tokens >= 0) and (output_tokens is null or output_tokens >= 0)) not valid;
create index if not exists model_runs_created_idx on public.model_runs (created_at);

alter table public.usage_holds
  add column if not exists premium boolean not null default false,
  add column if not exists est_tokens bigint not null default 0 check (est_tokens >= 0);

-- Spend on advanced and premium models since a time (runs plus requests in flight).
create or replace function public.usage_premium_spend(p_user uuid, p_since timestamptz, p_now timestamptz, p_fallback_in numeric, p_fallback_out numeric)
returns numeric
language sql stable
set search_path = ''
as $$
  select coalesce((
    select sum(coalesce(m.estimated_cost, (coalesce(m.input_tokens, 2000) * p_fallback_in + coalesce(m.output_tokens, 1000) * p_fallback_out) / 1000000.0))
    from public.model_runs m
    where m.user_id = p_user and m.created_at >= p_since and m.created_at <= p_now and coalesce(m.units, 0) > 0
      and m.model_tier in ('advanced', 'premium')
  ), 0) + coalesce((
    select sum(h.est_cost_usd) from public.usage_holds h
    where h.user_id = p_user and h.state = 'active' and h.expires_at > p_now and h.premium
  ), 0);
$$;
revoke all on function public.usage_premium_spend(uuid, timestamptz, timestamptz, numeric, numeric) from public, anon, authenticated;

create or replace function public.usage_reserve_v3(
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
      + coalesce((select sum(h.est_tokens) from public.usage_holds h
        where h.user_id = uid and h.state = 'active' and h.expires_at > ts), 0)
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
revoke all on function public.usage_reserve_v3(uuid, numeric, numeric, numeric, numeric, bigint, numeric, numeric, boolean, integer, bigint, timestamptz, numeric, numeric, text, text, integer) from public, anon;
grant execute on function public.usage_reserve_v3(uuid, numeric, numeric, numeric, numeric, bigint, numeric, numeric, boolean, integer, bigint, timestamptz, numeric, numeric, text, text, integer) to authenticated;

-- Stripe webhook events already processed (service role only).
create table if not exists public.stripe_events (
  id text primary key,
  type text not null,
  processed_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;

-- Money actually collected (excluding tax), refunds and failed payments (service role writes; admins read via admin_finance_summary_v2).
create table if not exists public.billing_ledger (
  id uuid primary key default gen_random_uuid(),
  stripe_object_id text not null unique,
  user_id uuid references auth.users (id) on delete set null,
  kind text not null check (kind in ('payment', 'refund', 'failed_payment')),
  plan text,
  amount_usd numeric(12, 2) not null default 0,
  tax_usd numeric(12, 2) not null default 0,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists billing_ledger_occurred_idx on public.billing_ledger (occurred_at);
create index if not exists billing_ledger_user_idx on public.billing_ledger (user_id);
alter table public.billing_ledger enable row level security;

-- Admin figures: v1 plus messages, tokens, cost by provider and tier, and the money ledger.
create or replace function public.admin_finance_summary_v2(p_since timestamptz)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  base jsonb;
begin
  base := public.admin_finance_summary(p_since);
  return base || jsonb_build_object(
    'usage', (
      select jsonb_build_object(
        'runs', count(*),
        'messages', count(distinct coalesce(request_id::text, id::text)),
        'input_tokens', coalesce(sum(input_tokens), 0),
        'output_tokens', coalesce(sum(output_tokens), 0),
        'cached_input_tokens', coalesce(sum(cached_input_tokens), 0),
        'failed_runs', count(*) filter (where status = 'error'))
      from public.model_runs where created_at >= p_since
    ),
    'cost_by_provider', coalesce((
      select jsonb_object_agg(provider, cost) from (
        select provider, round(sum(coalesce(estimated_cost, 0))::numeric, 4) as cost from public.model_runs where created_at >= p_since group by provider
      ) p
    ), '{}'::jsonb),
    'cost_by_tier', coalesce((
      select jsonb_object_agg(coalesce(model_tier, 'unknown'), cost) from (
        select model_tier, round(sum(coalesce(estimated_cost, 0))::numeric, 4) as cost from public.model_runs where created_at >= p_since group by model_tier
      ) t
    ), '{}'::jsonb),
    'messages_by_plan', coalesce((
      select jsonb_object_agg(coalesce(entitlement, 'unknown'), n) from (
        select entitlement, count(distinct coalesce(request_id::text, id::text)) as n from public.model_runs where created_at >= p_since group by entitlement
      ) e
    ), '{}'::jsonb),
    'ledger', coalesce((
      select jsonb_object_agg(kind, jsonb_build_object('count', n, 'amount', amount, 'tax', tax)) from (
        select kind, count(*) as n, sum(amount_usd) as amount, sum(tax_usd) as tax from public.billing_ledger where occurred_at >= p_since group by kind
      ) l
    ), '{}'::jsonb),
    'revenue_by_plan', coalesce((
      select jsonb_object_agg(coalesce(plan, 'unknown'), amount) from (
        select plan, sum(amount_usd) as amount from public.billing_ledger where kind = 'payment' and occurred_at >= p_since group by plan
      ) r
    ), '{}'::jsonb)
  );
end;
$$;
revoke all on function public.admin_finance_summary_v2(timestamptz) from public, anon;
grant execute on function public.admin_finance_summary_v2(timestamptz) to authenticated;
