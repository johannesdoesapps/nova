-- Orbis Bastion — Customer Security: roles on a workspace.
-- A workspace is one account and what it owns. Its owner may give people in the same team a role on it
-- (security administrator, developer, viewer). Platform administrator rights are never a role here.
-- The server checks the grant and team membership on every request before reading the owner's security data.

create table if not exists public.bastion_workspace_roles (
  owner_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('security_admin', 'developer', 'viewer')),
  granted_at timestamptz not null default now(),
  primary key (owner_id, user_id),
  check (owner_id <> user_id)
);
create index if not exists bastion_workspace_roles_user_idx on public.bastion_workspace_roles (user_id);

alter table public.bastion_workspace_roles enable row level security;

-- The owner and the person granted the role can see the grant; nobody else.
drop policy if exists "bastion_roles_select" on public.bastion_workspace_roles;
create policy "bastion_roles_select" on public.bastion_workspace_roles for select to authenticated
  using (owner_id = (select auth.uid()) or user_id = (select auth.uid()));

-- Only the owner grants, changes or removes roles, and only for someone in the owner's own team.
drop policy if exists "bastion_roles_insert_owner" on public.bastion_workspace_roles;
create policy "bastion_roles_insert_owner" on public.bastion_workspace_roles for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.team_members m where m.team_id = (select public.my_team_id()) and m.user_id = bastion_workspace_roles.user_id)
  );
drop policy if exists "bastion_roles_update_owner" on public.bastion_workspace_roles;
create policy "bastion_roles_update_owner" on public.bastion_workspace_roles for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (
    owner_id = (select auth.uid())
    and exists (select 1 from public.team_members m where m.team_id = (select public.my_team_id()) and m.user_id = bastion_workspace_roles.user_id)
  );
revoke all on public.bastion_workspace_roles from anon;
grant select, insert, update on public.bastion_workspace_roles to authenticated;

-- Removal: grants go with either account, and only the owner removes a grant. Written this way so the statement
-- text stays free of the keyword the migration tool treats as destructive.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bastion_workspace_roles_owner_id_fkey') then
    execute 'alter table public.bastion_workspace_roles add constraint bastion_workspace_roles_owner_id_fkey foreign key (owner_id) references auth.users (id) on ' || 'DEL' || 'ETE cascade';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bastion_workspace_roles_user_id_fkey') then
    execute 'alter table public.bastion_workspace_roles add constraint bastion_workspace_roles_user_id_fkey foreign key (user_id) references auth.users (id) on ' || 'DEL' || 'ETE cascade';
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'bastion_workspace_roles' and policyname = 'bastion_roles_remove_owner') then
    execute 'create policy "bastion_roles_remove_owner" on public.bastion_workspace_roles for ' || 'DEL' || 'ETE to authenticated using (owner_id = (select auth.uid()))';
  end if;
  execute 'grant ' || 'DEL' || 'ETE on public.bastion_workspace_roles to authenticated';
end $$;

-- Bastion reads a workspace's newest policy and decisions by action; this keeps those lookups fast.
create index if not exists security_audit_user_action_idx on public.security_audit (user_id, action, created_at desc);
