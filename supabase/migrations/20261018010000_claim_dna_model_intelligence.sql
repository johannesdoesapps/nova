-- ORBIS AI — Part 4 (Claim DNA & Research Intelligence) and Part 5 (Model Intelligence)
-- All user-owned tables use RLS with the same (select auth.uid()) pattern as the initial schema.

-- ─── usage tracking: richer model_runs ──────────────────────────────────────
alter table public.model_runs
  add column purpose text check (purpose is null or char_length(purpose) <= 40),
  add column category text check (category is null or char_length(category) <= 40),
  add column served_model text check (served_model is null or char_length(served_model) <= 200),
  add column fallback_from text check (fallback_from is null or char_length(fallback_from) <= 120);
create index model_runs_user_model_idx on public.model_runs (user_id, model_id, created_at desc);

-- ─── registry: price provenance ─────────────────────────────────────────────
alter table public.model_registry
  add column price_source_url text check (price_source_url is null or (price_source_url ~* '^https?://' and char_length(price_source_url) <= 2048));

-- Append-only price history so changes can be reviewed and costs re-computed.
create table public.model_price_history (
  id uuid primary key default gen_random_uuid(),
  model_id text not null references public.model_registry (id) on delete cascade,
  input_price numeric(12, 6),
  output_price numeric(12, 6),
  source_url text check (source_url is null or source_url ~* '^https?://'),
  verified_at timestamptz,
  recorded_at timestamptz not null default now()
);
create index model_price_history_model_idx on public.model_price_history (model_id, recorded_at desc);

create or replace function public.log_price_change()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT'
     or new.input_price is distinct from old.input_price
     or new.output_price is distinct from old.output_price then
    insert into public.model_price_history (model_id, input_price, output_price, source_url, verified_at)
    values (new.id, new.input_price, new.output_price, new.price_source_url, new.last_verified_at);
  end if;
  return new;
end $$;
create trigger model_registry_price_history after insert or update on public.model_registry
  for each row execute function public.log_price_change();

-- ─── Claim DNA ──────────────────────────────────────────────────────────────
create table public.claim_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  search_session_id uuid references public.search_sessions (id) on delete set null,
  question text not null check (char_length(question) <= 2000),
  mode text not null check (mode in ('rules', 'model')),
  model_id text,
  summary jsonb not null default '{}'::jsonb,
  report jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (octet_length(report::text) <= 2000000)
);
create index claim_reports_user_created_idx on public.claim_reports (user_id, created_at desc);
create index claim_reports_project_idx on public.claim_reports (project_id);
create trigger claim_reports_updated_at before update on public.claim_reports
  for each row execute function public.set_updated_at();

create table public.hypothesis_arenas (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  claim_report_id uuid references public.claim_reports (id) on delete set null,
  question text not null check (char_length(question) between 1 and 2000),
  arena jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (octet_length(arena::text) <= 500000)
);
create index hypothesis_arenas_user_idx on public.hypothesis_arenas (user_id, updated_at desc);
create trigger hypothesis_arenas_updated_at before update on public.hypothesis_arenas
  for each row execute function public.set_updated_at();

-- ─── Model Intelligence ─────────────────────────────────────────────────────
create table public.blind_trials (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category text not null check (category in ('coding', 'research', 'writing', 'analysis', 'extraction', 'general')),
  prompt text not null check (char_length(prompt) <= 8000),
  prompt_hash text not null,
  test_item_id text,
  winner text not null check (winner in ('A', 'B', 'tie', 'both_bad')),
  arms jsonb not null,
  ratings jsonb not null default '{}'::jsonb,
  note text check (note is null or char_length(note) <= 1000),
  redactions int not null default 0,
  created_at timestamptz not null default now()
);
create index blind_trials_user_created_idx on public.blind_trials (user_id, created_at desc);
create index blind_trials_user_category_idx on public.blind_trials (user_id, category);

create table public.benchmark_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  test_set_id text not null check (char_length(test_set_id) <= 120),
  test_set_name text not null,
  test_set_hash text not null,
  category text not null check (category in ('coding', 'research', 'writing', 'analysis', 'extraction', 'general')),
  model_id text not null,
  display_name text not null,
  served_model text,
  params jsonb not null default '{}'::jsonb,
  simulated boolean not null default false,
  results jsonb not null,
  created_at timestamptz not null default now(),
  check (octet_length(results::text) <= 1000000)
);
create index benchmark_runs_user_created_idx on public.benchmark_runs (user_id, created_at desc);
create index benchmark_runs_user_model_idx on public.benchmark_runs (user_id, model_id, test_set_hash);

-- ─── Row Level Security ─────────────────────────────────────────────────────
alter table public.model_price_history enable row level security;
alter table public.claim_reports enable row level security;
alter table public.hypothesis_arenas enable row level security;
alter table public.blind_trials enable row level security;
alter table public.benchmark_runs enable row level security;

create policy "model_price_history_read" on public.model_price_history for select to anon, authenticated using (true);

create policy "claim_reports_all_own" on public.claim_reports for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.owns_project(project_id));
create policy "hypothesis_arenas_all_own" on public.hypothesis_arenas for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.owns_project(project_id));

-- Trials and benchmark runs are evidence: users can add and delete their own, but not edit them.
create policy "blind_trials_select_own" on public.blind_trials for select to authenticated using (user_id = (select auth.uid()));
create policy "blind_trials_insert_own" on public.blind_trials for insert to authenticated with check (user_id = (select auth.uid()));
create policy "blind_trials_delete_own" on public.blind_trials for delete to authenticated using (user_id = (select auth.uid()));
create policy "benchmark_runs_select_own" on public.benchmark_runs for select to authenticated using (user_id = (select auth.uid()));
create policy "benchmark_runs_insert_own" on public.benchmark_runs for insert to authenticated with check (user_id = (select auth.uid()));
create policy "benchmark_runs_delete_own" on public.benchmark_runs for delete to authenticated using (user_id = (select auth.uid()));
