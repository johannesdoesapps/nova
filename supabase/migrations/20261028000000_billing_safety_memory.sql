-- Billing safety, customer notifications and memory across chats. Additive only.
--
-- 1. subscriptions.disputed: set by the Stripe webhook while a charge is disputed; a disputed
--    subscription gives no paid access (see paidStatus in src/lib/entitlements.ts).
-- 2. billing_disputes: one row per Stripe dispute, for the admin and the audit trail.
-- 3. notifications: each customer email or owner alert is recorded once per (user, kind, period),
--    so a retried webhook or a busy server never sends the same message twice.
-- 4. user_memories: facts a person asks Orbis to remember across chats. Only they can see,
--    add or delete theirs.

alter table public.subscriptions add column if not exists disputed boolean not null default false;

create table if not exists public.billing_disputes (
  id text primary key,
  user_id uuid references auth.users (id) on delete set null,
  charge_id text,
  amount_usd numeric(12, 2) not null default 0,
  reason text,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.billing_disputes enable row level security;
-- No policies: only the service role (webhook, admin finance) reads or writes disputes.

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid references auth.users (id) on delete cascade,
  kind text not null check (char_length(kind) between 1 and 60),
  period_key text not null check (char_length(period_key) between 1 and 80),
  channel text not null default 'email' check (channel in ('email', 'owner')),
  sent boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index if not exists notifications_once_idx on public.notifications (user_id, kind, period_key) nulls not distinct;
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
create policy "notifications_select_own" on public.notifications for select to authenticated using (user_id = (select auth.uid()));

create table if not exists public.user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  content text not null check (char_length(content) between 1 and 500),
  source text not null default 'manual' check (source in ('manual', 'chat')),
  created_at timestamptz not null default now()
);
create index if not exists user_memories_user_idx on public.user_memories (user_id, created_at desc);
alter table public.user_memories enable row level security;
create policy "user_memories_select_own" on public.user_memories for select to authenticated using (user_id = (select auth.uid()));
create policy "user_memories_insert_own" on public.user_memories for insert to authenticated with check (user_id = (select auth.uid()));
create policy "user_memories_delete_own" on public.user_memories for delete to authenticated using (user_id = (select auth.uid()));
