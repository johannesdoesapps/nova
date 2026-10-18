-- Security advisor fixes: pin search_path on trigger functions, and keep the
-- sign-up trigger function from being callable through the REST API.
alter function public.set_updated_at() set search_path = '';
alter function public.log_price_change() set search_path = '';
revoke execute on function public.handle_new_user() from public, anon, authenticated;
