-- NOVA AI — name new profiles from Google sign-ups too. Google (via Supabase
-- Auth) provides `full_name` / `name` instead of the `display_name` set by the
-- email sign-up form. Only new users are affected; existing profiles are kept.
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
  return new;
end $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
