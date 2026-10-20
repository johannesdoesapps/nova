-- ORBIS AI — paid plans. One row per paying user; no row means the Free plan.
-- Users can read their own subscription but never write it: rows are managed
-- by the payment webhook with the service role.
create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'pro')),
  status text not null default 'inactive'
    check (status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'inactive')),
  current_period_end timestamptz,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

alter table public.subscriptions enable row level security;
create policy "subscriptions_select_own" on public.subscriptions for select to authenticated
  using (user_id = (select auth.uid()));

-- Plan windows read recent successful runs per user.
create index model_runs_user_status_created_idx on public.model_runs (user_id, status, created_at);
