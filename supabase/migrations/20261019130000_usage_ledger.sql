-- ORBIS AI — usage accounting that can't be raced or double-charged.
--
-- Every model call is recorded in model_runs with the usage units it was
-- charged (from the model that actually answered), the request it belongs to
-- and why that model was chosen. Before a call starts, usage_reserve() takes a
-- per-user lock, checks the allowance including requests still in flight, and
-- places a hold; a request id can only be reserved once, so duplicate
-- submissions are refused. The hold is settled once the run is recorded, or
-- released if the request fails. Holds expire on their own, so a crashed
-- request can't block a user for long.

alter table public.model_runs
  add column if not exists request_id uuid,
  add column if not exists requested_model text,
  add column if not exists routing_reason text,
  add column if not exists units numeric(10, 2),
  add column if not exists entitlement text,
  add column if not exists error_code text,
  add column if not exists tools text[];

comment on column public.model_runs.units is 'Usage units charged for this run (0 when it was refunded or failed before any output).';
comment on column public.model_runs.entitlement is 'Allowance that applied: plan:free, plan:pro or admin_unlimited.';

create index if not exists model_runs_user_request_idx on public.model_runs (user_id, request_id) where request_id is not null;

-- Users insert their own runs (RLS), so the ledger must not trust what they
-- send: no negative charges, and the time of a run is always the server's, so a
-- backdated row can't move the start of a usage window.
alter table public.model_runs add constraint model_runs_units_nonnegative check (units is null or units >= 0);
create or replace function public.model_runs_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  return new;
end;
$$;
create trigger model_runs_stamp before insert on public.model_runs
  for each row execute function public.model_runs_stamp();

-- Existing runs: charge what the old rule charged (1 unit for low-cost models,
-- 15 for larger ones, successful runs only).
update public.model_runs
set units = case
  when status <> 'success' then 0
  when model_id in (
    'anthropic:claude-sonnet-5-5', 'openai:gpt-5', 'openai:gpt-5.6-terra', 'google:gemini-4-argon',
    'xai:grok-4.3', 'xai:grok-4.7', 'deepseek:deepseek-v4-pro', 'hf:gpt-oss-120b', 'hf:llama-3.3-70b', 'demo:beta'
  ) then 15
  else 1
end
where units is null;

create table public.usage_holds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  request_id uuid not null,
  units numeric(10, 2) not null check (units >= 0),
  purpose text,
  model_id text,
  state text not null default 'active' check (state in ('active', 'settled', 'released')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (user_id, request_id)
);
create index usage_holds_user_active_idx on public.usage_holds (user_id, state, expires_at);

alter table public.usage_holds enable row level security;
create policy "usage_holds_select_own" on public.usage_holds for select to authenticated
  using (user_id = (select auth.uid()));
-- No insert/update/delete policies: holds change only through the functions below.

-- Usage in the current 5-hour window and the last 7 days, counting charged
-- runs and active holds. Same rules as computeUsage() in src/lib/plans.ts: a
-- window opens with the first charge after the previous window closed.
create or replace function public.usage_compute(p_user uuid, p_now timestamptz)
returns table (window_used numeric, window_start timestamptz, week_used numeric, week_oldest timestamptz)
language plpgsql stable
set search_path = ''
as $$
declare
  r record;
  w_start timestamptz;
  w_used numeric := 0;
  k_used numeric := 0;
  k_oldest timestamptz;
begin
  for r in
    select e.at, e.units from (
      select m.created_at as at, m.units from public.model_runs m
      where m.user_id = p_user and m.created_at > p_now - interval '7 days' and m.created_at <= p_now and coalesce(m.units, 0) > 0
      union all
      select h.created_at, h.units from public.usage_holds h
      where h.user_id = p_user and h.state = 'active' and h.expires_at > p_now and h.units > 0
    ) e
    order by e.at
  loop
    if w_start is null or r.at >= w_start + interval '5 hours' then
      w_start := r.at;
      w_used := 0;
    end if;
    w_used := w_used + r.units;
    k_used := k_used + r.units;
    k_oldest := coalesce(k_oldest, r.at);
  end loop;
  if w_start is null or p_now >= w_start + interval '5 hours' then
    w_start := null;
    w_used := 0;
  end if;
  return query select w_used, w_start, k_used, k_oldest;
end;
$$;
revoke all on function public.usage_compute(uuid, timestamptz) from public, anon, authenticated;

-- The caller's usage, for the usage meter.
create or replace function public.usage_status()
returns table (window_used numeric, window_start timestamptz, week_used numeric, week_oldest timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select * from public.usage_compute((select auth.uid()), now()) where (select auth.uid()) is not null;
$$;
revoke all on function public.usage_status() from public, anon;
grant execute on function public.usage_status() to authenticated;

-- Reserve units for one request. Limits come from the server's plan config.
-- Returns ok, or the scope that would be exceeded, or 'duplicate'.
create or replace function public.usage_reserve(
  p_request_id uuid,
  p_units numeric,
  p_window_limit numeric,
  p_week_limit numeric,
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
begin
  if uid is null then
    raise exception 'Sign in required' using errcode = '28000';
  end if;
  if p_units is null or p_units < 0 or p_window_limit is null or p_week_limit is null then
    raise exception 'Invalid usage request' using errcode = '22023';
  end if;
  -- One reservation at a time per user, so concurrent requests can't both pass.
  perform pg_advisory_xact_lock(hashtextextended('orbis-usage:' || uid::text, 0));

  if exists (select 1 from public.usage_holds where user_id = uid and request_id = p_request_id)
     or exists (select 1 from public.model_runs where user_id = uid and request_id = p_request_id) then
    return jsonb_build_object('ok', false, 'reason', 'duplicate');
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

  insert into public.usage_holds (user_id, request_id, units, purpose, model_id, expires_at)
  values (uid, p_request_id, p_units, left(p_purpose, 40), left(p_model, 120), ts + make_interval(secs => least(greatest(p_ttl_seconds, 30), 600)));
  return jsonb_build_object('ok', true, 'window_used', u.window_used + p_units, 'week_used', u.week_used + p_units);
end;
$$;
revoke all on function public.usage_reserve(uuid, numeric, numeric, numeric, text, text, integer) from public, anon;
grant execute on function public.usage_reserve(uuid, numeric, numeric, numeric, text, text, integer) to authenticated;

-- Close the caller's hold: 'settled' once the run is recorded, 'released' when the request failed.
create or replace function public.usage_finish(p_request_id uuid, p_state text)
returns void
language sql volatile security definer
set search_path = ''
as $$
  update public.usage_holds
  set state = case when p_state = 'settled' then 'settled' else 'released' end
  where user_id = (select auth.uid()) and request_id = p_request_id and state = 'active';
$$;
revoke all on function public.usage_finish(uuid, text) from public, anon;
grant execute on function public.usage_finish(uuid, text) to authenticated;

-- Request diagnostics for administrators: why each request used the model and
-- units it did. Metadata only — never prompts or replies.
create or replace function public.admin_request_log(p_limit integer default 100, p_email text default null)
returns table (
  created_at timestamptz,
  request_id uuid,
  user_email text,
  purpose text,
  requested_model text,
  model_id text,
  served_model text,
  fallback_from text,
  routing_reason text,
  status text,
  error_code text,
  latency_ms integer,
  input_tokens integer,
  output_tokens integer,
  units numeric,
  entitlement text,
  estimated_cost numeric,
  tools text[]
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.admins a where a.user_id = (select auth.uid())) then
    raise exception 'Administrators only' using errcode = '42501';
  end if;
  return query
    select m.created_at, m.request_id, u.email::text, m.purpose, m.requested_model, m.model_id, m.served_model, m.fallback_from,
           m.routing_reason, m.status, m.error_code, m.latency_ms, m.input_tokens, m.output_tokens, m.units, m.entitlement,
           m.estimated_cost, m.tools
    from public.model_runs m
    left join auth.users u on u.id = m.user_id
    where p_email is null or u.email ilike p_email
    order by m.created_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;
revoke all on function public.admin_request_log(integer, text) from public, anon;
grant execute on function public.admin_request_log(integer, text) to authenticated;
