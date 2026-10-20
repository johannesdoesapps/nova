-- ORBIS AI — billing periods for Pro subscriptions. The AI budget guard counts
-- spend from the start of the current billing period; the Stripe webhook
-- (service role) keeps these columns in sync. Users still can't write them.
alter table public.subscriptions
  add column if not exists current_period_start timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false;
