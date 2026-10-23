-- Team plan: one subscription pays for several seats; every member gets the team's plan (Pro or Max)
-- with their own allowance (limits are never pooled). Additive only.
--
-- teams         one row per team, written by the Stripe webhook (status, seats, period) and by
--               team_create (name, owner). The subscription's quantity is the number of seats.
-- team_members  who is in which team; a person can be in one team at a time; the owner takes a seat.
-- team_invites  pending invitations by email; only a hash of the invite code is stored.
--
-- Members can read their own team and its member list; only the owner sees invites. All writes go
-- through the security-definer functions below (or the webhook's service role), which check roles,
-- seats and email addresses, so the browser can't add itself to a team or raise its seat count.

create table if not exists public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  owner_id uuid not null references auth.users (id) on delete cascade,
  plan text not null default 'pro' check (plan in ('pro', 'max')),
  billing_interval text not null default 'month' check (billing_interval in ('month', 'year')),
  seats integer not null default 0 check (seats between 0 and 1000),
  status text not null default 'incomplete' check (status in ('active', 'trialing', 'past_due', 'canceled', 'incomplete', 'inactive')),
  price_usd numeric(10, 2),
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  disputed boolean not null default false,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists teams_owner_idx on public.teams (owner_id);
create index if not exists teams_customer_idx on public.teams (stripe_customer_id);
create trigger teams_updated_at before update on public.teams for each row execute function public.set_updated_at();

create table if not exists public.team_members (
  team_id uuid not null references public.teams (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create unique index if not exists team_members_one_team_idx on public.team_members (user_id);

create table if not exists public.team_invites (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  email text not null check (char_length(email) between 3 and 320),
  token_hash text not null unique,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  revoked_at timestamptz
);
create index if not exists team_invites_team_idx on public.team_invites (team_id);

alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;

-- The caller's team (security definer so policies don't recurse through team_members).
create or replace function public.my_team_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select team_id from public.team_members where user_id = (select auth.uid()) limit 1;
$$;
revoke all on function public.my_team_id() from public, anon;
grant execute on function public.my_team_id() to authenticated;

create policy "teams_select_member" on public.teams for select to authenticated using (id = (select public.my_team_id()) or owner_id = (select auth.uid()));
create policy "team_members_select_team" on public.team_members for select to authenticated using (team_id = (select public.my_team_id()));
create policy "team_invites_select_owner" on public.team_invites for select to authenticated
  using (exists (select 1 from public.teams t where t.id = team_id and t.owner_id = (select auth.uid())));

-- Start a team: the caller becomes its owner (and first member). Refused if they're already in a team.
-- A team the caller owns that never got paid for is reused, so a cancelled checkout leaves no clutter.
create or replace function public.team_create(p_name text, p_plan text, p_interval text)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  tid uuid;
begin
  if uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if p_plan not in ('pro', 'max') or p_interval not in ('month', 'year') then raise exception 'Invalid plan' using errcode = '22023'; end if;
  select t.id into tid from public.teams t join public.team_members m on m.team_id = t.id where m.user_id = uid;
  if tid is not null then
    if exists (select 1 from public.teams where id = tid and owner_id = uid and status in ('incomplete', 'inactive', 'canceled')) then
      update public.teams set name = left(btrim(p_name), 80), plan = p_plan, billing_interval = p_interval where id = tid;
      return tid;
    end if;
    raise exception 'You are already in a team' using errcode = '23505';
  end if;
  insert into public.teams (name, owner_id, plan, billing_interval) values (left(btrim(p_name), 80), uid, p_plan, p_interval) returning id into tid;
  insert into public.team_members (team_id, user_id, role) values (tid, uid, 'owner');
  return tid;
end;
$$;
revoke all on function public.team_create(text, text, text) from public, anon;
grant execute on function public.team_create(text, text, text) to authenticated;

-- Invite someone by email (owner only). Seats in use = members + open invites; it can't pass the seat count.
create or replace function public.team_invite_create(p_team uuid, p_email text, p_token_hash text)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  t public.teams%rowtype;
  used integer;
  iid uuid;
begin
  select * into t from public.teams where id = p_team for update;
  if t.id is null or t.owner_id is distinct from uid then raise exception 'Only the team owner can invite people' using errcode = '42501'; end if;
  if t.status not in ('active', 'trialing', 'past_due') then raise exception 'The team has no active subscription' using errcode = '22023'; end if;
  if exists (select 1 from public.team_members m join auth.users u on u.id = m.user_id where m.team_id = p_team and lower(u.email) = lower(btrim(p_email))) then
    raise exception 'That person is already in the team' using errcode = '23505';
  end if;
  update public.team_invites set revoked_at = now() where team_id = p_team and lower(email) = lower(btrim(p_email)) and accepted_at is null and revoked_at is null;
  select (select count(*) from public.team_members where team_id = p_team)
       + (select count(*) from public.team_invites where team_id = p_team and accepted_at is null and revoked_at is null and expires_at > now())
    into used;
  if used >= t.seats then raise exception 'All seats are in use. Add seats or remove someone first.' using errcode = '22023'; end if;
  insert into public.team_invites (team_id, email, token_hash, created_by) values (p_team, lower(btrim(p_email)), p_token_hash, uid) returning id into iid;
  return iid;
end;
$$;
revoke all on function public.team_invite_create(uuid, text, text) from public, anon;
grant execute on function public.team_invite_create(uuid, text, text) to authenticated;

-- Accept an invite: only the invited email address can, while a seat is free and they aren't in another team.
create or replace function public.team_accept_invite(p_token_hash text)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  me text;
  inv public.team_invites%rowtype;
  t public.teams%rowtype;
  members integer;
begin
  if uid is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  select lower(email) into me from auth.users where id = uid;
  select * into inv from public.team_invites where token_hash = p_token_hash for update;
  if inv.id is null or inv.revoked_at is not null or inv.accepted_at is not null or inv.expires_at <= now() then
    raise exception 'This invitation is no longer valid' using errcode = '22023';
  end if;
  if inv.email <> me then raise exception 'This invitation is for a different email address' using errcode = '42501'; end if;
  if exists (select 1 from public.team_members where user_id = uid) then raise exception 'You are already in a team' using errcode = '23505'; end if;
  select * into t from public.teams where id = inv.team_id for update;
  if t.status not in ('active', 'trialing', 'past_due') then raise exception 'The team has no active subscription' using errcode = '22023'; end if;
  select count(*) into members from public.team_members where team_id = t.id;
  if members >= t.seats then raise exception 'The team has no free seats' using errcode = '22023'; end if;
  insert into public.team_members (team_id, user_id, role) values (t.id, uid, 'member');
  update public.team_invites set accepted_at = now() where id = inv.id;
  return t.id;
end;
$$;
revoke all on function public.team_accept_invite(text) from public, anon;
grant execute on function public.team_accept_invite(text) to authenticated;

-- Remove a member (owner), or leave (the member themself). The owner can't be removed.
create or replace function public.team_remove_member(p_team uuid, p_user uuid)
returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  uid uuid := (select auth.uid());
  t public.teams%rowtype;
begin
  select * into t from public.teams where id = p_team;
  if t.id is null then return false; end if;
  if p_user = t.owner_id then raise exception 'The owner can''t leave the team; cancel the subscription instead' using errcode = '22023'; end if;
  if uid is distinct from t.owner_id and uid is distinct from p_user then raise exception 'Only the owner can remove members' using errcode = '42501'; end if;
  delete from public.team_members where team_id = p_team and user_id = p_user;
  return found;
end;
$$;
revoke all on function public.team_remove_member(uuid, uuid) from public, anon;
grant execute on function public.team_remove_member(uuid, uuid) to authenticated;

-- Withdraw an open invitation (owner).
create or replace function public.team_revoke_invite(p_invite uuid)
returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  update public.team_invites i set revoked_at = now()
  where i.id = p_invite and i.accepted_at is null and i.revoked_at is null
    and exists (select 1 from public.teams t where t.id = i.team_id and t.owner_id = (select auth.uid()));
  return found;
end;
$$;
revoke all on function public.team_revoke_invite(uuid) from public, anon;
grant execute on function public.team_revoke_invite(uuid) to authenticated;

-- The team's members with their email addresses (members of that team only). Never chats or usage details.
create or replace function public.team_roster()
returns table (user_id uuid, email text, role text, joined_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select m.user_id, u.email::text, m.role, m.joined_at
  from public.team_members m join auth.users u on u.id = m.user_id
  where m.team_id = (select public.my_team_id())
  order by m.role desc, m.joined_at;
$$;
revoke all on function public.team_roster() from public, anon;
grant execute on function public.team_roster() to authenticated;
