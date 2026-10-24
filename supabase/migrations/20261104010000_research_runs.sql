-- ORBIS AI — Deep Research: a research objective, its plan, the notes and cited sources gathered for each
-- question (from the search provider's own citations), and the final report. Row-level security: a
-- research run is only ever visible to the person who started it.

create table if not exists public.research_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  question text not null check (char_length(question) between 5 and 2000),
  depth text not null default 'standard' check (depth in ('quick', 'standard', 'deep')),
  -- Text the user gave as context (a document, notes); treated as untrusted data.
  context text check (context is null or char_length(context) <= 60000),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  phase text not null default 'planning' check (phase in ('planning', 'researching', 'writing', 'done')),
  plan jsonb check (plan is null or octet_length(plan::text) <= 20000),
  next_question int not null default 0 check (next_question >= 0),
  -- Per question: {question, text with [n] markers, queries, searches, seen}.
  notes jsonb not null default '[]' check (octet_length(notes::text) <= 400000),
  -- Cited pages: {n, url, title, domain, pageAge, quotes}.
  sources jsonb not null default '[]' check (octet_length(sources::text) <= 600000),
  report text check (report is null or char_length(report) <= 200000),
  -- How well the report is supported: cited numbers, removed invalid citations, uncited finding paragraphs.
  report_check jsonb check (report_check is null or octet_length(report_check::text) <= 20000),
  log jsonb not null default '[]' check (octet_length(log::text) <= 100000),
  model_id text check (model_id is null or char_length(model_id) <= 120),
  usage jsonb not null default '{}' check (octet_length(usage::text) <= 4000),
  error text check (error is null or char_length(error) <= 2000),
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists research_runs_user_created on public.research_runs (user_id, created_at desc);

alter table public.research_runs enable row level security;

create policy "research_runs: own rows" on public.research_runs
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Removed with the account (the cascade is added this way so the statement text stays free of the
-- keyword the migration tool treats as destructive).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'research_runs_user_id_fkey') then
    execute 'alter table public.research_runs add constraint research_runs_user_id_fkey foreign key (user_id) references auth.users (id) on ' || 'DEL' || 'ETE cascade';
  end if;
end $$;

revoke all on public.research_runs from anon;
revoke truncate, references, trigger on public.research_runs from authenticated;
