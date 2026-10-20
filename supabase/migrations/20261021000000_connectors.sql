-- ORBIS AI — Connectors: the services each user has connected.
-- One row per user and connector. Tokens are never stored in plain text:
-- `secret` holds them sealed with AES-256-GCM by the server, using a key
-- only the server has (ORBIS_CONNECTOR_KEY) and bound to this user and
-- connector, so the stored value is useless to anyone reading the row.
-- Owners only, enforced by row-level security.

create table if not exists public.connector_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  connector_id text not null check (connector_id ~ '^[a-z][a-z0-9_]{1,39}$'),
  status text not null default 'connected' check (status in ('connected', 'reauth_required', 'error', 'disconnected')),
  account_label text check (account_label is null or char_length(account_label) <= 200),
  scopes text[] not null default '{}' check (cardinality(scopes) <= 50),
  write_enabled boolean not null default false,
  ai_mode text not null default 'auto' check (ai_mode in ('auto', 'mention', 'off')),
  secret text check (secret is null or char_length(secret) <= 20000),
  token_expires_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  connected_at timestamptz not null default now(),
  last_checked_at timestamptz,
  last_used_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (user_id, connector_id)
);

alter table public.connector_accounts enable row level security;
create policy connector_accounts_own on public.connector_accounts for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.connector_accounts from anon, authenticated;
grant select, delete on public.connector_accounts to authenticated;
grant insert (connector_id, status, account_label, scopes, write_enabled, ai_mode, secret, token_expires_at, last_error, connected_at, last_checked_at, last_used_at, updated_at)
  on public.connector_accounts to authenticated;
-- connector_id is updatable only so reconnecting can upsert; a sealed token
-- moved to another connector's row can't be opened (it's bound to its connector).
grant update (connector_id, status, account_label, scopes, write_enabled, ai_mode, secret, token_expires_at, last_error, connected_at, last_checked_at, last_used_at, updated_at)
  on public.connector_accounts to authenticated;

-- A record of every write action a user confirmed (what, where, whether it
-- worked). No message or document content is kept.
create table if not exists public.connector_actions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  connector_id text not null check (connector_id ~ '^[a-z][a-z0-9_]{1,39}$'),
  action text not null check (char_length(action) <= 60),
  status text not null check (status in ('done', 'failed')),
  summary text check (summary is null or char_length(summary) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists connector_actions_user on public.connector_actions (user_id, created_at desc);
alter table public.connector_actions enable row level security;
create policy connector_actions_own on public.connector_actions for select to authenticated
  using (user_id = (select auth.uid()));
create policy connector_actions_insert_own on public.connector_actions for insert to authenticated
  with check (user_id = (select auth.uid()));
revoke all on public.connector_actions from anon, authenticated;
grant select on public.connector_actions to authenticated;
grant insert (connector_id, action, status, summary) on public.connector_actions to authenticated;
