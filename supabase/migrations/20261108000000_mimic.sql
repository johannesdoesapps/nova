-- ORBIS AI — Mimic: learn a task from one demonstration and repeat it.
-- Every table is per user (row-level security: own rows only). Demo Books (mimic_ledger) is Mimic's built-in
-- practice ledger, not a real accounting system. The audit log (mimic_events) can't be edited, only appended
-- to or deleted with the rest of the user's Mimic data.

create table if not exists public.mimic_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null check (char_length(name) between 1 and 200),
  text text not null check (char_length(text) between 1 and 60000),
  sha256 text not null check (char_length(sha256) = 64),
  source text not null check (source in ('sample', 'upload', 'paste')),
  created_at timestamptz not null default now()
);
create index if not exists mimic_documents_user on public.mimic_documents (user_id, created_at desc);

create table if not exists public.mimic_workflows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null check (char_length(name) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'tested', 'active', 'paused')),
  mode text not null default 'supervised' check (mode in ('assist', 'supervised', 'automatic')),
  definition jsonb not null check (octet_length(definition::text) <= 60000),
  demonstration jsonb not null check (octet_length(demonstration::text) <= 120000),
  questions jsonb not null default '[]' check (octet_length(questions::text) <= 20000),
  observed jsonb not null default '[]' check (octet_length(observed::text) <= 20000),
  tested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mimic_workflows_user on public.mimic_workflows (user_id, created_at desc);

create table if not exists public.mimic_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  workflow_id uuid not null references public.mimic_workflows (id) on delete cascade,
  document_id uuid references public.mimic_documents (id) on delete set null,
  trigger text not null check (trigger in ('manual', 'document_added', 'test', 'retry', 'approval')),
  dry_run boolean not null default false,
  status text not null check (status in ('running', 'completed', 'dry_run', 'proposal', 'needs_approval', 'needs_attention', 'failed', 'stopped', 'rejected')),
  result jsonb not null default '{}' check (octet_length(result::text) <= 120000),
  ledger_entry_id uuid,
  seconds numeric,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists mimic_runs_user on public.mimic_runs (user_id, created_at desc);
-- One live (non-test) run per workflow and document: a repeated trigger finds the first run instead of starting another.
create unique index if not exists mimic_runs_once on public.mimic_runs (workflow_id, document_id) where not dry_run and document_id is not null and trigger = 'document_added';

create table if not exists public.mimic_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  kind text not null default 'supplier_category' check (kind in ('supplier_category')),
  supplier text not null check (char_length(supplier) between 1 and 200),
  supplier_key text not null check (char_length(supplier_key) between 1 and 200),
  category text not null check (char_length(category) between 1 and 80),
  status text not null default 'active' check (status in ('active', 'removed')),
  history jsonb not null default '[]' check (octet_length(history::text) <= 40000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists mimic_rules_supplier on public.mimic_rules (user_id, supplier_key) where status = 'active';

create table if not exists public.mimic_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  supplier text not null check (char_length(supplier) between 1 and 200),
  invoice_number text not null check (char_length(invoice_number) between 1 and 120),
  invoice_date date not null,
  due_date date,
  net numeric(14, 2),
  tax numeric(14, 2),
  total numeric(14, 2) not null,
  currency text not null check (char_length(currency) = 3),
  category text not null check (char_length(category) between 1 and 80),
  status text not null default 'draft' check (status in ('draft')),
  idempotency_key text not null check (char_length(idempotency_key) between 3 and 400),
  document_id uuid references public.mimic_documents (id) on delete set null,
  run_id uuid,
  created_at timestamptz not null default now()
);
-- The same invoice can't be drafted twice, whichever workflow or retry tries.
create unique index if not exists mimic_ledger_once on public.mimic_ledger (user_id, idempotency_key);

create table if not exists public.mimic_events (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid(),
  -- proposed | approved | completed | failed | rejected | rule | settings | workflow
  kind text not null check (char_length(kind) between 1 and 40),
  workflow_id uuid,
  run_id uuid,
  summary text not null check (char_length(summary) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists mimic_events_user on public.mimic_events (user_id, created_at desc);

create table if not exists public.mimic_settings (
  user_id uuid primary key default auth.uid(),
  stopped boolean not null default false,
  ai_reading boolean not null default true,
  retention_days int not null default 365 check (retention_days between 30 and 3650),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['mimic_documents', 'mimic_workflows', 'mimic_runs', 'mimic_rules', 'mimic_ledger', 'mimic_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s: own rows" on public.%I', t, t);
    execute format('create policy "%s: own rows" on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t, t);
  end loop;
end $$;

-- The audit log: read, append and delete (data deletion), never update.
alter table public.mimic_events enable row level security;
drop policy if exists "mimic_events: read own" on public.mimic_events;
create policy "mimic_events: read own" on public.mimic_events for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "mimic_events: append own" on public.mimic_events;
create policy "mimic_events: append own" on public.mimic_events for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "mimic_events: delete own" on public.mimic_events;
create policy "mimic_events: delete own" on public.mimic_events for delete to authenticated using (user_id = (select auth.uid()));
