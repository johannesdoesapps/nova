-- Usage limits v5, modelled on Claude's plans:
-- * The weekly limit resets at a fixed time for each account (every 7 days
--   from when the account was created), not on a rolling 7 days.
-- * A separate weekly limit for premium models (Max), on top of the
--   all-models weekly limit.
-- * Extra usage (credits): when a paid plan's limit is reached, units bought
--   separately can pay for the request instead. Credit-paid requests don't
--   count against the plan's limits or its monthly AI budget.
-- Additive: v4 and the earlier functions stay until nothing calls them.

alter table public.usage_holds
  add column if not exists model_tier text check (model_tier is null or model_tier in ('standard', 'advanced', 'premium')),
  add column if not exists credit boolean not null default false;
alter table public.model_runs add column if not exists paid_with_credits boolean not null default false;

-- Credits: balance per user. Users read their own; only the functions below change it.
create table if not exists public.usage_credits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance numeric(12, 2) not null default 0 check (balance >= 0),
  auto_use boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.usage_credits enable row level security;
drop policy if exists usage_credits_read_own on public.usage_credits;
create policy usage_credits_read_own on public.usage_credits for select to authenticated using (user_id = (select auth.uid()));

create table if not exists public.usage_credit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('purchase', 'use', 'refund', 'grant')),
  units numeric(12, 2) not null,
  amount_usd numeric(10, 2),
  stripe_session text unique,
  request_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists usage_credit_events_user_idx on public.usage_credit_events (user_id, created_at desc);
alter table public.usage_credit_events enable row level security;
drop policy if exists usage_credit_events_read_own on public.usage_credit_events;
create policy usage_credit_events_read_own on public.usage_credit_events for select to authenticated using (user_id = (select auth.uid()));

-- Start of the account's current weekly period: whole weeks after the anchor.
create or replace function public.usage_week_start(p_anchor timestamptz, p_now timestamptz)
returns timestamptz
language sql immutable
set search_path = ''
as $$
  select p_anchor + floor(greatest(extract(epoch from (p_now - p_anchor)), 0) / 604800) * interval '7 days';
$$;

-- The 5-hour window, the current fixed week (all models and premium models), for one user.
-- Counts charged runs and requests in flight; credit-paid ones are left out.
create or replace function public.usage_compute_v2(p_user uuid, p_now timestamptz)
returns table (window_used numeric, window_start timestamptz, week_used numeric, week_start timestamptz, top_used numeric)
language plpgsql stable
set search_path = ''
as $$
declare
  r record;
  w_start timestamptz;
  w_used numeric := 0;
  k_used numeric := 0;
  t_used numeric := 0;
  anchor timestamptz;
  k_start timestamptz;
begin
  select u.created_at into anchor from auth.users u where u.id = p_user;
  k_start := public.usage_week_start(coalesce(anchor, p_now), p_now);
  for r in
    select e.at, e.units, e.tier from (
      select m.created_at as at, m.units, m.model_tier as tier from public.model_runs m
      where m.user_id = p_user and m.created_at > p_now - interval '7 days' and m.created_at <= p_now
        and coalesce(m.units, 0) > 0 and not m.paid_with_credits
      union all
      select h.created_at, h.units, h.model_tier from public.usage_holds h
      where h.user_id = p_user and h.state = 'active' and h.expires_at > p_now and h.units > 0 and not h.credit
    ) e
    order by e.at
  loop
    if w_start is null or r.at >= w_start + interval '5 hours' then
      w_start := r.at;
      w_used := 0;
    end if;
    w_used := w_used + r.units;
    if r.at >= k_start then
      k_used := k_used + r.units;
      if r.tier = 'premium' then
        t_used := t_used + r.units;
      end if;
    end if;
  end loop;
  if w_start is null or p_now >= w_start + interval '5 hours' then
    w_start := null;
    w_used := 0;
  end if;
  return query select w_used, w_start, k_used, k_start, t_used;
end;
$$;
revoke all on function public.usage_compute_v2(uuid, timestamptz) from public, anon, authenticated;

-- Money spent against the monthly AI budget: as before, without credit-paid runs and holds.
create or replace function public.usage_spend_v2(p_user uuid, p_since timestamptz, p_now timestamptz, p_fallback_in numeric, p_fallback_out numeric, p_premium_only boolean default false)
returns numeric
language sql stable
set search_path = ''
as $$
  select coalesce((
    select sum(coalesce(m.estimated_cost, (coalesce(m.input_tokens, 2000) * p_fallback_in + coalesce(m.output_tokens, 1000) * p_fallback_out) / 1000000.0))
    from public.model_runs m
    where m.user_id = p_user and m.created_at >= p_since and m.created_at <= p_now and coalesce(m.units, 0) > 0
      and not m.paid_with_credits and (not p_premium_only or m.model_tier in ('advanced', 'premium'))
  ), 0) + coalesce((
    select sum(h.est_cost_usd) from public.usage_holds h
    where h.user_id = p_user and h.expires_at > p_now and not h.credit and (not p_premium_only or h.premium)
      and not exists (select 1 from public.model_runs r where r.user_id = p_user and r.request_id = h.request_id)
  ), 0);
$$;
revoke all on function public.usage_spend_v2(uuid, timestamptz, timestamptz, numeric, numeric, boolean) from public, anon, authenticated;

create or replace function public.usage_reserve_v5(
  p_request_id uuid,
  p_units numeric,
  p_window_limit numeric,
  p_week_limit numeric,
  p_est_cost_usd numeric,
  p_est_tokens bigint,
  p_budget_usd numeric,
  p_premium_budget_usd numeric,
  p_premium boolean,
  p_daily_limit integer,
  p_token_limit bigint,
  p_period_start timestamptz,
  p_fallback_in numeric,
  p_fallback_out numeric,
  p_purpose text default null,
  p_model text default null,
  p_ttl_seconds integer default 180,
  p_daily_budget_usd numeric default null,
  p_site_cap_usd numeric default null,
  p_top boolean default false,               -- the request uses a premium-tier model
  p_top_week_limit numeric default null,     -- null: no separate premium weekly limit
  p_credits boolean default false            -- this plan may pay with credits when an allowance is used up
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
  refusal jsonb;
  bal numeric := 0;
  auto boolean := true;
  avail numeric := 0;
  tier text := case when p_top then 'premium' when p_premium then 'advanced' else 'standard' end;
  ttl interval := make_interval(secs => least(greatest(p_ttl_seconds, 30), 600));
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

  -- Hard limits: credits can't get past these.
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

  -- The plan's allowances, in the same order as before. The first one used up is the refusal.
  if p_budget_usd is not null then
    spent := public.usage_spend_v2(uid, since, ts, coalesce(p_fallback_in, 0), coalesce(p_fallback_out, 0));
    if spent >= p_budget_usd then
      refusal := jsonb_build_object('ok', false, 'reason', 'budget', 'scope', 'exhausted', 'spent', spent, 'budget', p_budget_usd);
    elsif spent + est > p_budget_usd then
      refusal := jsonb_build_object('ok', false, 'reason', 'budget', 'scope', 'insufficient', 'spent', spent, 'budget', p_budget_usd, 'estimate', est);
    elsif p_premium and p_premium_budget_usd is not null then
      premium_spent := public.usage_spend_v2(uid, since, ts, coalesce(p_fallback_in, 0), coalesce(p_fallback_out, 0), true);
      if premium_spent + est > p_premium_budget_usd then
        refusal := jsonb_build_object('ok', false, 'reason', 'budget', 'scope', 'premium', 'spent', premium_spent, 'budget', p_premium_budget_usd, 'estimate', est);
      end if;
    end if;
  end if;
  if refusal is null and p_daily_budget_usd is not null
     and public.usage_spend_v2(uid, day_start, ts, coalesce(p_fallback_in, 0), coalesce(p_fallback_out, 0)) + est > p_daily_budget_usd then
    refusal := jsonb_build_object('ok', false, 'reason', 'budget', 'scope', 'daily', 'budget', p_daily_budget_usd, 'resets_at', day_start + interval '1 day');
  end if;
  if refusal is null and coalesce(p_token_limit, 0) > 0 then
    select coalesce((select sum(coalesce(m.input_tokens, 0) + coalesce(m.output_tokens, 0)) from public.model_runs m
        where m.user_id = uid and m.created_at >= since and coalesce(m.units, 0) > 0 and not m.paid_with_credits), 0)
      + public.usage_held_tokens(uid, ts)
    into tokens;
    if tokens + est_tok > p_token_limit then
      refusal := jsonb_build_object('ok', false, 'reason', 'tokens', 'used', tokens, 'limit', p_token_limit);
    end if;
  end if;

  select * into u from public.usage_compute_v2(uid, ts);
  if refusal is null and u.week_used + p_units > p_week_limit then
    refusal := jsonb_build_object('ok', false, 'reason', 'limit', 'scope', 'week', 'used', u.week_used, 'limit', p_week_limit,
      'resets_at', u.week_start + interval '7 days');
  end if;
  if refusal is null and p_top and p_top_week_limit is not null and u.top_used + p_units > p_top_week_limit then
    refusal := jsonb_build_object('ok', false, 'reason', 'limit', 'scope', 'top_week', 'used', u.top_used, 'limit', p_top_week_limit,
      'resets_at', u.week_start + interval '7 days');
  end if;
  if refusal is null and u.window_used + p_units > p_window_limit then
    refusal := jsonb_build_object('ok', false, 'reason', 'limit', 'scope', 'window', 'used', u.window_used, 'limit', p_window_limit,
      'resets_at', coalesce(u.window_start, ts) + interval '5 hours');
  end if;

  if refusal is not null then
    -- Extra usage: pay with credits if the plan allows it, the user hasn't turned it off, and enough is left.
    if p_credits then
      select c.balance, c.auto_use into bal, auto from public.usage_credits c where c.user_id = uid;
      avail := coalesce(bal, 0) - coalesce((select sum(h.units) from public.usage_holds h
        where h.user_id = uid and h.credit and h.state = 'active' and h.expires_at > ts), 0);
      if coalesce(auto, true) and p_units > 0 and avail >= p_units then
        insert into public.usage_holds (user_id, request_id, units, est_cost_usd, est_tokens, premium, purpose, model_id, expires_at, model_tier, credit)
        values (uid, p_request_id, p_units, est, est_tok, coalesce(p_premium, false), left(p_purpose, 40), left(p_model, 120), ts + ttl, tier, true);
        return jsonb_build_object('ok', true, 'credit', true, 'credits_left', avail - p_units, 'covered', refusal->>'scope');
      end if;
    end if;
    return refusal || jsonb_build_object('credits', greatest(avail, 0), 'credits_auto', coalesce(auto, true));
  end if;

  insert into public.usage_holds (user_id, request_id, units, est_cost_usd, est_tokens, premium, purpose, model_id, expires_at, model_tier, credit)
  values (uid, p_request_id, p_units, est, est_tok, coalesce(p_premium, false), left(p_purpose, 40), left(p_model, 120), ts + ttl, tier, false);
  return jsonb_build_object('ok', true, 'credit', false, 'spent', spent, 'premium_spent', premium_spent, 'messages_today', msgs + 1, 'tokens', tokens,
    'window_used', u.window_used + p_units, 'week_used', u.week_used + p_units, 'top_used', u.top_used + case when p_top then p_units else 0 end);
end;
$$;
revoke all on function public.usage_reserve_v5(uuid, numeric, numeric, numeric, numeric, bigint, numeric, numeric, boolean, integer, bigint, timestamptz, numeric, numeric, text, text, integer, numeric, numeric, boolean, numeric, boolean) from public, anon;
grant execute on function public.usage_reserve_v5(uuid, numeric, numeric, numeric, numeric, bigint, numeric, numeric, boolean, integer, bigint, timestamptz, numeric, numeric, text, text, integer, numeric, numeric, boolean, numeric, boolean) to authenticated;

-- The caller's usage and credits, for the usage meters.
create or replace function public.usage_status_v2()
returns table (window_used numeric, window_start timestamptz, week_used numeric, week_start timestamptz, top_used numeric, credits numeric, credits_auto boolean)
language sql stable security definer
set search_path = ''
as $$
  select u.window_used, u.window_start, u.week_used, u.week_start, u.top_used,
    coalesce((select c.balance from public.usage_credits c where c.user_id = (select auth.uid())), 0),
    coalesce((select c.auto_use from public.usage_credits c where c.user_id = (select auth.uid())), true)
  from public.usage_compute_v2((select auth.uid()), now()) u
  where (select auth.uid()) is not null;
$$;
revoke all on function public.usage_status_v2() from public, anon;
grant execute on function public.usage_status_v2() to authenticated;

-- Turn "use extra usage automatically" on or off for the caller.
create or replace function public.usage_credits_set_auto(p_on boolean)
returns void
language sql volatile security definer
set search_path = ''
as $$
  insert into public.usage_credits (user_id, auto_use) values ((select auth.uid()), coalesce(p_on, true))
  on conflict (user_id) do update set auto_use = excluded.auto_use, updated_at = now();
$$;
revoke all on function public.usage_credits_set_auto(boolean) from public, anon;
grant execute on function public.usage_credits_set_auto(boolean) to authenticated;

-- Charge a credit-paid request's actual units to the caller's balance (never below zero) and close its hold.
create or replace function public.usage_credit_settle(p_request_id uuid, p_units numeric)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  amount numeric := greatest(coalesce(p_units, 0), 0);
begin
  if uid is null or not exists (select 1 from public.usage_holds h where h.user_id = uid and h.request_id = p_request_id and h.credit) then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('orbis-usage:' || uid::text, 0));
  if amount > 0 then
    update public.usage_credits set balance = greatest(balance - amount, 0), updated_at = now() where user_id = uid;
    insert into public.usage_credit_events (user_id, kind, units, request_id) values (uid, 'use', -amount, p_request_id);
  end if;
  update public.usage_holds set state = 'settled' where user_id = uid and request_id = p_request_id and state = 'active';
end;
$$;
revoke all on function public.usage_credit_settle(uuid, numeric) from public, anon;
grant execute on function public.usage_credit_settle(uuid, numeric) to authenticated;

-- Add bought credits (the Stripe webhook, with the service role). Each checkout session counts once.
create or replace function public.usage_credit_add(p_user uuid, p_units numeric, p_amount_usd numeric, p_session text)
returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  added integer;
begin
  if p_user is null or coalesce(p_units, 0) <= 0 or p_session is null then
    raise exception 'Invalid credit purchase' using errcode = '22023';
  end if;
  insert into public.usage_credit_events (user_id, kind, units, amount_usd, stripe_session)
  values (p_user, 'purchase', p_units, p_amount_usd, p_session)
  on conflict (stripe_session) do nothing;
  get diagnostics added = row_count;
  if added = 0 then
    return false;
  end if;
  insert into public.usage_credits (user_id, balance) values (p_user, p_units)
  on conflict (user_id) do update set balance = public.usage_credits.balance + excluded.balance, updated_at = now();
  return true;
end;
$$;
revoke all on function public.usage_credit_add(uuid, numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.usage_credit_add(uuid, numeric, numeric, text) to service_role;
