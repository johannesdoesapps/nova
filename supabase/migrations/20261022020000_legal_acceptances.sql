-- ORBIS AI — a record of each user accepting the Terms of Service and the
-- Privacy Policy: which document, which version, when, and how (ticked on
-- the sign-up form, or on the "Before you continue" page). Append-only for
-- users: rows can be added and read by their owner, never changed or deleted
-- (they go when the account is deleted).

create table if not exists public.legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  document text not null check (document in ('terms', 'privacy')),
  version text not null check (char_length(version) between 1 and 40),
  method text not null default 'prompt' check (method in ('signup', 'prompt')),
  accepted_at timestamptz not null default now()
);
create index if not exists legal_acceptances_user on public.legal_acceptances (user_id, version);

alter table public.legal_acceptances enable row level security;
create policy legal_acceptances_select_own on public.legal_acceptances for select to authenticated
  using (user_id = (select auth.uid()));
create policy legal_acceptances_insert_own on public.legal_acceptances for insert to authenticated
  with check (user_id = (select auth.uid()));
revoke all on public.legal_acceptances from anon, authenticated;
grant select on public.legal_acceptances to authenticated;
grant insert (document, version, method) on public.legal_acceptances to authenticated;

-- Sign-ups with email record the acceptance ticked on the form (sent as
-- `terms_version` in the sign-up metadata) as the account is created.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(
      nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
      split_part(new.email, '@', 1)
    ), 80)
  );
  if nullif(trim(new.raw_user_meta_data ->> 'terms_version'), '') is not null then
    insert into public.legal_acceptances (user_id, document, version, method)
    select new.id, d, left(trim(new.raw_user_meta_data ->> 'terms_version'), 40), 'signup'
    from unnest(array['terms', 'privacy']) as d;
  end if;
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
