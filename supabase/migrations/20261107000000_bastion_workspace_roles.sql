-- Orbis Bastion — Customer Security: roles on a workspace.
-- A workspace is one account and what it owns. Its owner may give people in the same team a role on it
-- (security administrator, developer, viewer). Platform administrator rights are never a role here.
-- The server checks the grant and team membership on every request before reading the owner's security data.

create table if not exists public.bastion_workspace_roles (
  owner_id uuid not null references auth.users (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('security_admin', 'developer', 'viewer')),
  granted_at timestamptz not null default now(),
  primary key (owner_id, user_id),
  check (owner_id <> user_id)
);
create index if not exists bastion_workspace_roles_user_idx on public.bastion_workspace_roles (user_id);

alter table public.bastion_workspace_roles enable row level security;

-- The owner and the person granted the role can see the grant; nobody else.
create policy "bastion_roles_select" on public.bastion_workspace_roles for select to authenticated
  using (owner_id = (select auth.uid()) or user_id = (select auth.uid()));

-- Only the owner grants, changes or removes roles, and only for someone in the owner's own team.
create policy "bastion_roles_insert_owner" on public.bastion_workspace_roles for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.team_members m where m.team_id = (select public.my_team_id()) and m.user_id = bastion_workspace_roles.user_id)
  );
create policy "bastion_roles_update_owner" on public.bastion_workspace_roles for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.team_members m where m.team_id = (select public.my_team_id()) and m.user_id = bastion_workspace_roles.user_id)
  );
create policy "bastion_roles_delete_owner" on public.bastion_workspace_roles for delete to authenticated
  using (owner_id = (select auth.uid()));

revoke all on public.bastion_workspace_roles from anon;
grant select, insert, update, delete on public.bastion_workspace_roles to authenticated;

-- Bastion reads a workspace's newest policy and decisions by action; this keeps those lookups fast.
create index if not exists security_audit_user_action_idx on public.security_audit (user_id, action, created_at desc);
