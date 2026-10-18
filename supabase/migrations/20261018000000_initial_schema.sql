-- NOVA AI — initial schema
-- Every user-owned table has Row Level Security enabled. Policies use
-- (select auth.uid()) so Postgres evaluates it once per statement.

-- gen_random_uuid() is built into Postgres 13+, so no extension is required.

-- ─── helpers ────────────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ─── profiles ───────────────────────────────────────────────────────────────
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (char_length(display_name) <= 80),
  avatar_url text check (char_length(avatar_url) <= 2048),
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- Create a profile row automatically on sign-up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)), 80));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─── projects ───────────────────────────────────────────────────────────────
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_user_updated_idx on public.projects (user_id, updated_at desc);
create trigger projects_updated_at before update on public.projects
  for each row execute function public.set_updated_at();

-- True when project_id is null or belongs to the current user. Used in WITH CHECK
-- clauses so nobody can attach their rows to someone else's project.
create or replace function public.owns_project(p uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select p is null or exists (select 1 from public.projects where id = p and user_id = (select auth.uid()));
$$;

-- ─── conversations & messages ───────────────────────────────────────────────
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  title text not null default 'New conversation' check (char_length(title) between 1 and 200),
  mode text not null default 'research' check (mode in ('research', 'analyst', 'critic', 'coding')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_user_updated_idx on public.conversations (user_id, updated_at desc);
create index conversations_project_idx on public.conversations (project_id);
create trigger conversations_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null check (char_length(content) <= 200000),
  model_id text,
  usage_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at);

-- ─── search ─────────────────────────────────────────────────────────────────
create table public.search_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  query text not null check (char_length(query) between 1 and 2000),
  answer text,
  model_id text,
  created_at timestamptz not null default now()
);
create index search_sessions_user_created_idx on public.search_sessions (user_id, created_at desc);
create index search_sessions_project_idx on public.search_sessions (project_id);

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  search_session_id uuid not null references public.search_sessions (id) on delete cascade,
  position int not null,
  url text not null check (url ~* '^https?://' and char_length(url) <= 2048),
  title text,
  snippet text,
  published_at timestamptz,
  created_at timestamptz not null default now()
);
create index sources_session_idx on public.sources (search_session_id, position);

-- ─── model registry (admin-managed, readable by everyone) ───────────────────
create table public.model_registry (
  id text primary key,
  provider text not null check (provider in ('openai', 'huggingface', 'demo')),
  provider_model_id text not null,
  display_name text not null,
  description text,
  capabilities text[] not null default '{chat}',
  context_window int,
  input_price numeric(12, 6),   -- USD per 1M input tokens; null = unverified
  output_price numeric(12, 6),  -- USD per 1M output tokens; null = unverified
  is_enabled boolean not null default true,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger model_registry_updated_at before update on public.model_registry
  for each row execute function public.set_updated_at();

-- ─── model runs (usage tracking) ────────────────────────────────────────────
create table public.model_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  model_id text not null,
  prompt text,
  response text,
  latency_ms int,
  input_tokens int,
  output_tokens int,
  estimated_cost numeric(14, 8),
  status text not null check (status in ('success', 'error')),
  created_at timestamptz not null default now()
);
create index model_runs_user_created_idx on public.model_runs (user_id, created_at desc);

-- ─── comparisons & favourites ───────────────────────────────────────────────
create table public.model_comparisons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  prompt text not null check (char_length(prompt) <= 20000),
  selected_models text[] not null,
  comparison_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index model_comparisons_user_created_idx on public.model_comparisons (user_id, created_at desc);
create index model_comparisons_project_idx on public.model_comparisons (project_id);

create table public.favorite_models (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  model_id text not null check (char_length(model_id) <= 200),
  source text not null default 'hub' check (source in ('hub', 'registry')),
  created_at timestamptz not null default now(),
  unique (user_id, model_id)
);

-- ─── project notes (saved answers + free-form notes) ────────────────────────
create table public.project_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  content text not null check (char_length(content) <= 100000),
  source_type text not null default 'note' check (source_type in ('note', 'chat', 'search', 'comparison')),
  source_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index project_notes_project_idx on public.project_notes (project_id, created_at desc);
create trigger project_notes_updated_at before update on public.project_notes
  for each row execute function public.set_updated_at();

-- ─── radar (data model only; scheduling arrives in a later stage) ───────────
create table public.radar_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  query text not null check (char_length(query) between 1 and 500),
  frequency text not null default 'daily' check (frequency in ('daily', 'weekly')),
  is_active boolean not null default false,
  last_checked_at timestamptz,
  next_check_at timestamptz,
  created_at timestamptz not null default now()
);
create index radar_tasks_user_idx on public.radar_tasks (user_id);

-- ─── Row Level Security ─────────────────────────────────────────────────────
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.search_sessions enable row level security;
alter table public.sources enable row level security;
alter table public.model_registry enable row level security;
alter table public.model_runs enable row level security;
alter table public.model_comparisons enable row level security;
alter table public.favorite_models enable row level security;
alter table public.project_notes enable row level security;
alter table public.radar_tasks enable row level security;

-- profiles: a user sees and edits only their own row
create policy "profiles_select_own" on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "profiles_update_own" on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- projects
create policy "projects_all_own" on public.projects for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- conversations
create policy "conversations_all_own" on public.conversations for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.owns_project(project_id));

-- messages: via conversation ownership
create policy "messages_all_own" on public.messages for all to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = (select auth.uid())))
  with check (exists (select 1 from public.conversations c where c.id = conversation_id and c.user_id = (select auth.uid())));

-- search sessions & sources
create policy "search_sessions_all_own" on public.search_sessions for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.owns_project(project_id));
create policy "sources_all_own" on public.sources for all to authenticated
  using (exists (select 1 from public.search_sessions s where s.id = search_session_id and s.user_id = (select auth.uid())))
  with check (exists (select 1 from public.search_sessions s where s.id = search_session_id and s.user_id = (select auth.uid())));

-- model registry: read-only for clients; manage it with the service role or SQL editor
create policy "model_registry_read" on public.model_registry for select to anon, authenticated using (true);

-- model runs: users can read and insert their own; no updates or deletes from clients
create policy "model_runs_select_own" on public.model_runs for select to authenticated using (user_id = (select auth.uid()));
create policy "model_runs_insert_own" on public.model_runs for insert to authenticated with check (user_id = (select auth.uid()));

-- comparisons, favourites, notes, radar
create policy "model_comparisons_all_own" on public.model_comparisons for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.owns_project(project_id));
create policy "favorite_models_all_own" on public.favorite_models for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "project_notes_all_own" on public.project_notes for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.owns_project(project_id));
create policy "radar_tasks_all_own" on public.radar_tasks for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.owns_project(project_id));
