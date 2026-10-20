-- ORBIS AI — saved Council and Arena sessions (each model's answer, critiques,
-- synthesis, sources, and the user's ratings). Private to their owner.
create table public.council_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('council', 'arena')),
  question text not null check (char_length(question) between 1 and 12000),
  mode text not null check (mode in ('quick', 'deep', 'blind', 'open')),
  models text[] not null check (cardinality(models) between 1 and 4),
  result jsonb not null check (octet_length(result::text) <= 400000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index council_sessions_user_idx on public.council_sessions (user_id, kind, created_at desc);
create trigger council_sessions_updated_at before update on public.council_sessions
  for each row execute function public.set_updated_at();
alter table public.council_sessions enable row level security;
create policy "council_sessions_all_own" on public.council_sessions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
