-- NOVA AI — custom agents
-- Built-in agents live in code (src/lib/agents/builtins.ts) and are referenced
-- by key. Custom agents are rows owned by one user. A conversation belongs to
-- at most one agent; ordinary chats have neither column set.

create table public.agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 300),
  instructions text not null check (char_length(instructions) between 20 and 8000),
  icon text not null default 'bot' check (char_length(icon) between 1 and 40),
  accent text not null default 'violet' check (accent in ('violet', 'blue', 'teal', 'green', 'amber', 'rose')),
  model_id text check (model_id is null or char_length(model_id) <= 120),
  capabilities text[] not null default '{}'
    check (capabilities <@ array['web_search', 'file_analysis', 'data_analysis', 'code_execution']::text[]),
  starters text[] not null default '{}' check (cardinality(starters) <= 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index agents_user_updated_idx on public.agents (user_id, updated_at desc);
create trigger agents_updated_at before update on public.agents
  for each row execute function public.set_updated_at();

alter table public.agents enable row level security;
create policy "agents_all_own" on public.agents for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- True when a is null or is an agent owned by the current user.
create or replace function public.owns_agent(a uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select a is null or exists (select 1 from public.agents where id = a and user_id = (select auth.uid()));
$$;

alter table public.conversations
  add column agent_id uuid references public.agents (id) on delete cascade,
  add column builtin_agent text check (builtin_agent is null or builtin_agent in ('research', 'coding', 'writing', 'data', 'creative', 'general')),
  add constraint conversations_one_agent check (agent_id is null or builtin_agent is null);
create index conversations_agent_idx on public.conversations (user_id, agent_id, updated_at desc) where agent_id is not null;
create index conversations_builtin_agent_idx on public.conversations (user_id, builtin_agent, updated_at desc) where builtin_agent is not null;

-- Nobody can attach a conversation to someone else's agent.
alter policy "conversations_all_own" on public.conversations
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and public.owns_project(project_id) and public.owns_agent(agent_id));
