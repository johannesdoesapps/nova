-- Product feedback and analytics, first-party and privacy-conscious.
--
-- response_feedback: a user's rating of one result (a reply, a template run,
--   a verification), with an optional comment they write themselves. One per
--   user and result; they can change or remove it.
-- product_events: a short list of named events (see src/lib/analytics/events.ts)
--   with a few non-identifying properties (a template id, a limit's scope).
--   Never prompt or reply text. Users can turn these off in Settings.
-- admin_product_metrics: the measurement plan's figures, computed from these
--   tables and the existing usage records; administrators only. Internal and
--   test accounts are left out.

create table if not exists public.response_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  feature text not null check (feature in ('chat', 'agent', 'template', 'verify', 'compare', 'council', 'code')),
  subject_id text not null check (char_length(subject_id) between 1 and 100),
  rating text not null check (rating in ('helpful', 'incorrect', 'incomplete', 'not_relevant', 'too_slow', 'too_costly', 'other')),
  comment text check (comment is null or char_length(comment) <= 1000),
  model_id text check (model_id is null or char_length(model_id) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, feature, subject_id)
);
create index if not exists response_feedback_created on public.response_feedback (created_at);

alter table public.response_feedback enable row level security;
create policy response_feedback_own on public.response_feedback for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create table if not exists public.product_events (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  event text not null check (event in (
    'useful_result', 'workflow_started', 'workflow_completed', 'workflow_failed',
    'comparison_started', 'comparison_completed', 'verify_completed', 'usage_limit_reached', 'palette_command'
  )),
  props jsonb not null default '{}'::jsonb check (jsonb_typeof(props) = 'object' and pg_column_size(props) <= 512),
  created_at timestamptz not null default now()
);
create index if not exists product_events_event_created on public.product_events (event, created_at);
create index if not exists product_events_user_created on public.product_events (user_id, created_at);

alter table public.product_events enable row level security;
-- Users add their own events and can see them; nobody edits them.
create policy product_events_insert_own on public.product_events for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy product_events_select_own on public.product_events for select to authenticated
  using (user_id = (select auth.uid()));

create or replace function public.admin_product_metrics(p_since timestamptz)
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
    where coalesce(u.email, '') not like '%@orbis.invalid'
      and not exists (select 1 from public.admins a where a.user_id = p.id)
  ),
  runs as (
    select m.user_id, m.created_at, m.purpose, m.status
    from public.model_runs m
    join people pe on pe.id = m.user_id
  ),
  events as (
    select e.user_id, e.event, e.props, e.created_at
    from public.product_events e
    join people pe on pe.id = e.user_id
  ),
  feedback as (
    select f.user_id, f.rating, f.feature, f.created_at
    from public.response_feedback f
    join people pe on pe.id = f.user_id
  ),
  firsts as (
    select pe.id, pe.created_at,
      (select min(r.created_at) from runs r where r.user_id = pe.id) as first_prompt,
      (select min(r.created_at) from runs r where r.user_id = pe.id and r.status = 'success') as first_result,
      least(
        (select min(e.created_at) from events e where e.user_id = pe.id and e.event in ('useful_result', 'workflow_completed', 'verify_completed', 'comparison_completed')),
        (select min(f.created_at) from feedback f where f.user_id = pe.id and f.rating = 'helpful')
      ) as first_useful
    from people pe
  ),
  gaps as (
    select user_id, created_at, created_at - lag(created_at) over (partition by user_id order by created_at) as gap
    from runs
  )
  select jsonb_build_object(
    'since', p_since,
    'generated_at', now(),
    'people', (select count(*) from people),
    'signups', (select count(*) from people where created_at >= p_since),
    'onboarded', (select count(distinct l.user_id) from public.legal_acceptances l join people pe on pe.id = l.user_id where pe.created_at >= p_since),
    'first_prompt', (select count(*) from firsts where created_at >= p_since and first_prompt is not null),
    'activated', (select count(*) from firsts where created_at >= p_since and first_result is not null and first_result < created_at + interval '7 days'),
    'first_useful', (select count(*) from firsts where created_at >= p_since and first_useful is not null),
    'minutes_to_first_result', (
      select percentile_cont(0.5) within group (order by extract(epoch from first_result - created_at) / 60)
      from firsts where created_at >= p_since and first_result is not null),
    'minutes_to_first_useful', (
      select percentile_cont(0.5) within group (order by extract(epoch from first_useful - created_at) / 60)
      from firsts where created_at >= p_since and first_useful is not null),
    'retention', jsonb_build_object(
      'd7_cohort', (select count(*) from people where created_at <= now() - interval '7 days'),
      'd7_returned', (select count(*) from people pe where pe.created_at <= now() - interval '7 days'
        and exists (select 1 from runs r where r.user_id = pe.id and r.created_at >= pe.created_at + interval '7 days')),
      'd30_cohort', (select count(*) from people where created_at <= now() - interval '30 days'),
      'd30_returned', (select count(*) from people pe where pe.created_at <= now() - interval '30 days'
        and exists (select 1 from runs r where r.user_id = pe.id and r.created_at >= pe.created_at + interval '30 days'))
    ),
    'returned_after_gap', (select count(distinct user_id) from gaps where created_at >= p_since and gap >= interval '7 days'),
    'active_users', (select count(distinct user_id) from runs where created_at >= p_since),
    'features', coalesce((
      select jsonb_object_agg(purpose, users)
      from (select coalesce(purpose, 'chat') as purpose, count(distinct user_id) as users from runs where created_at >= p_since and status = 'success' group by 1) f
    ), '{}'::jsonb),
    'events', coalesce((
      select jsonb_object_agg(event, n)
      from (select event, count(*) as n from events where created_at >= p_since group by event) x
    ), '{}'::jsonb),
    'workflows', coalesce((
      select jsonb_agg(jsonb_build_object('template', t, 'started', s, 'completed', c, 'failed', f) order by s desc)
      from (
        select props ->> 'template' as t,
          count(*) filter (where event = 'workflow_started') as s,
          count(*) filter (where event = 'workflow_completed') as c,
          count(*) filter (where event = 'workflow_failed') as f
        from events where created_at >= p_since and event like 'workflow_%' group by 1
      ) w
    ), '[]'::jsonb),
    'limits', coalesce((
      select jsonb_agg(jsonb_build_object('scope', scope, 'times', n, 'users', u) order by n desc)
      from (select coalesce(props ->> 'scope', 'unknown') as scope, count(*) as n, count(distinct user_id) as u from events
            where created_at >= p_since and event = 'usage_limit_reached' group by 1) l
    ), '[]'::jsonb),
    'feedback', coalesce((
      select jsonb_object_agg(rating, n) from (select rating, count(*) as n from feedback where created_at >= p_since group by rating) x
    ), '{}'::jsonb),
    'feedback_by_feature', coalesce((
      select jsonb_agg(jsonb_build_object('feature', feature, 'helpful', h, 'total', t) order by t desc)
      from (select feature, count(*) filter (where rating = 'helpful') as h, count(*) as t from feedback where created_at >= p_since group by feature) x
    ), '[]'::jsonb),
    'projects_created', (
      (select count(*) from public.projects p join people pe on pe.id = p.user_id where p.created_at >= p_since)
      + (select count(*) from public.code_projects c join people pe on pe.id = c.user_id where c.created_at >= p_since)
    ),
    'paid', jsonb_build_object(
      'live_subscriptions', (select count(*) from public.subscriptions s join people pe on pe.id = s.user_id
        where s.stripe_subscription_id is not null and s.status in ('active', 'trialing') and s.plan <> 'free'),
      'any_paid_ever', (select count(*) from public.subscriptions s join people pe on pe.id = s.user_id where s.stripe_subscription_id is not null)
    )
  ) into result;
  return result;
end;
$$;
revoke all on function public.admin_product_metrics(timestamptz) from public, anon;
grant execute on function public.admin_product_metrics(timestamptz) to authenticated;
