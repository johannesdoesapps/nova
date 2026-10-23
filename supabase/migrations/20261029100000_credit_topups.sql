-- Automatic top-ups of extra usage, opt-in only. Additive only.
--
-- A customer on a paid plan can choose to have Orbis buy extra usage for them when their balance falls below a
-- level they choose, up to a monthly limit they set, charged to a card they saved for this purpose. Their consent
-- (the exact wording, the time) is stored with the settings. Settings are written only by the server (service role).
--
-- credit_topups records every attempt. At most one attempt per person can be pending at a time (partial unique
-- index), and the Stripe PaymentIntent id is unique, so a retry or two servers can't charge twice.

create table if not exists public.credit_topup_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default false,
  packs integer not null default 1 check (packs between 1 and 10),
  below_units numeric(12, 2) not null default 0 check (below_units >= 0),
  monthly_cap_usd numeric(10, 2) not null default 0 check (monthly_cap_usd >= 0),
  stripe_customer_id text,
  payment_method_id text,
  consent_text text,
  consent_at timestamptz,
  disabled_reason text,
  updated_at timestamptz not null default now()
);
alter table public.credit_topup_settings enable row level security;
create policy "credit_topup_settings_select_own" on public.credit_topup_settings for select to authenticated using (user_id = (select auth.uid()));

create table if not exists public.credit_topups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  units numeric(12, 2) not null check (units > 0),
  amount_usd numeric(10, 2) not null check (amount_usd > 0),
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  payment_intent_id text unique,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists credit_topups_one_pending_idx on public.credit_topups (user_id) where status = 'pending';
create index if not exists credit_topups_user_idx on public.credit_topups (user_id, created_at desc);
alter table public.credit_topups enable row level security;
create policy "credit_topups_select_own" on public.credit_topups for select to authenticated using (user_id = (select auth.uid()));
