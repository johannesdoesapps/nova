-- A signed-in person deletes their own account. Everything they own goes with
-- it (every table's link to auth.users cascades); billing ledger rows stay,
-- no longer linked to them (set null). Refused for administrators (so the
-- last one can't disappear by accident) and while a paid plan is on.

create or replace function public.delete_own_account()
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'Sign in to delete your account.' using errcode = '28000';
  end if;
  if exists (select 1 from public.admins a where a.user_id = uid) then
    raise exception 'Administrators can''t delete their account here. Remove admin access first.' using errcode = '42501';
  end if;
  if exists (select 1 from public.subscriptions s where s.user_id = uid and s.plan <> 'free' and s.status in ('active', 'trialing', 'past_due')) then
    raise exception 'Cancel your paid plan first, then delete your account.' using errcode = '55000';
  end if;
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.delete_own_account() from public, anon;
grant execute on function public.delete_own_account() to authenticated;
