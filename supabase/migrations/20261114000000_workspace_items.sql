-- ORBIS AI — the Cybersecurity and Website Builder workspaces.
--
-- * workspace_items: the saved projects of both workspaces — a security report,
--   a risk register, a drafted website, a saved analysis. One row per item,
--   owned by its user, with free-form JSON content per kind. Create, edit,
--   duplicate and delete are ordinary row operations; "history" is the list
--   ordered by updated_at.
-- * The conversations.builtin_agent check is widened so a conversation can
--   attach to any built-in agent id (the workspaces add 20 of them), instead
--   of listing each one and needing a migration for every new agent.
--
-- Additive: one new table, one relaxed check constraint.

create table if not exists public.workspace_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- Which workspace the item belongs to.
  workspace text not null check (workspace in ('cyber', 'web')),
  -- The kind of item within the workspace (a slug: a tool id or a template id).
  kind text not null check (kind ~ '^[a-z][a-z0-9-]{1,48}$'),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  -- The item's content: whatever the tool or template stores (fields, generated text, builder blocks…).
  data jsonb not null default '{}' check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 600000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists workspace_items_user on public.workspace_items (user_id, workspace, updated_at desc);

alter table public.workspace_items enable row level security;

-- At most 500 items per user per workspace, so a runaway loop can't fill the table.
create or replace function public.workspace_items_limit()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' and (select count(*) from public.workspace_items w where w.user_id = new.user_id and w.workspace = new.workspace) >= 500 then
    raise exception 'You have reached the limit of 500 saved items in this workspace.' using errcode = '54000';
  end if;
  return new;
end;
$$;
revoke all on function public.workspace_items_limit() from public, anon, authenticated;
drop trigger if exists workspace_items_limit on public.workspace_items;
create trigger workspace_items_limit before insert or update on public.workspace_items
  for each row execute function public.workspace_items_limit();

drop policy if exists workspace_items_own on public.workspace_items;
create policy workspace_items_own on public.workspace_items for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

revoke all on public.workspace_items from anon, authenticated;
grant select, delete on public.workspace_items to authenticated;
grant insert (workspace, kind, title, data) on public.workspace_items to authenticated;
grant update (title, data, updated_at) on public.workspace_items to authenticated;

-- ---------------------------------------------------------------- built-in agents
-- Widen the allow-list to cover the Cybersecurity and Website Builder workspace
-- agents, while still rejecting unknown ids (so a typo or a forged value can't
-- attach a conversation to a non-existent built-in agent).
alter table public.conversations drop constraint if exists conversations_builtin_agent_check;
alter table public.conversations add constraint conversations_builtin_agent_check
  check (builtin_agent is null or builtin_agent in (
    'research', 'coding', 'writing', 'data', 'creative', 'general',
    'security-analyst', 'vulnerability-assessor', 'pentest-assistant', 'threat-intel', 'malware-analyst',
    'network-security', 'security-auditor', 'incident-responder', 'phishing-detector', 'compliance-advisor',
    'web-designer', 'web-developer', 'frontend-developer', 'backend-developer', 'ux-designer',
    'seo-optimiser', 'content-writer', 'site-auditor', 'ecommerce-builder', 'site-maintainer'
  ));
