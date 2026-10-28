-- Usage estimates before costly tasks, and an in-app inbox of updates on work that runs in the background.

-- What one run of a feature typically uses, across all accounts, for people who haven't run it yet. Usage records
-- carry no run id, so records of one account and feature closer than 15 minutes count as one run. Only aggregates
-- leave the function, and only when enough people ran it (at least 3 accounts and 5 runs in 30 days), so nobody's
-- own pattern can be read back.
create or replace function public.usage_typical_run(p_purposes text[])
returns table (typical numeric, low numeric, high numeric, runs integer)
language sql
stable
security definer
set search_path = ''
as $$
  with recent as (
    select user_id, created_at, coalesce(units, 0) as units
    from public.model_runs
    where purpose = any (p_purposes)
      and created_at >= now() - interval '30 days'
      and user_id is not null
      and coalesce(entitlement, '') <> 'admin_unlimited'
  ),
  marked as (
    select user_id, created_at, units,
      case when lag(created_at) over w is null or created_at - lag(created_at) over w > interval '15 minutes' then 1 else 0 end as starts
    from recent
    window w as (partition by user_id order by created_at)
  ),
  numbered as (
    select user_id, units, sum(starts) over (partition by user_id order by created_at rows unbounded preceding) as run_no
    from marked
  ),
  per_run as (
    select user_id, run_no, sum(units) as units from numbered group by user_id, run_no having sum(units) > 0
  )
  select
    round(percentile_cont(0.5) within group (order by units)::numeric, 2),
    round(percentile_cont(0.1) within group (order by units)::numeric, 2),
    round(percentile_cont(0.9) within group (order by units)::numeric, 2),
    count(*)::int
  from per_run
  having count(*) >= 5 and count(distinct user_id) >= 3;
$$;
revoke all on function public.usage_typical_run(text[]) from public, anon;
grant execute on function public.usage_typical_run(text[]) to authenticated;

-- Updates for the signed-in user: a task finished, failed or needs them. Written by the user's own session (the page,
-- or the background worker acting as the owner); links stay inside Orbis.
create table if not exists public.user_notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('task_done', 'task_failed', 'task_waiting')),
  dedupe_key text not null check (char_length(dedupe_key) between 1 and 120),
  title text not null check (char_length(title) between 1 and 200),
  body text check (char_length(body) <= 600),
  href text check (href ~ '^/[A-Za-z0-9]' and href !~ '//' and char_length(href) <= 300),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create unique index if not exists user_notifications_once_idx on public.user_notifications (user_id, dedupe_key);
create index if not exists user_notifications_user_idx on public.user_notifications (user_id, created_at desc);
alter table public.user_notifications enable row level security;
create policy "user_notifications_select_own" on public.user_notifications for select to authenticated using (user_id = (select auth.uid()));
create policy "user_notifications_insert_own" on public.user_notifications for insert to authenticated with check (user_id = (select auth.uid()) and read_at is null);
create policy "user_notifications_update_own" on public.user_notifications for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "user_notifications_delete_own" on public.user_notifications for delete to authenticated using (user_id = (select auth.uid()));
-- Only the read mark can change after an update is written.
revoke update on public.user_notifications from authenticated;
grant update (read_at) on public.user_notifications to authenticated;
