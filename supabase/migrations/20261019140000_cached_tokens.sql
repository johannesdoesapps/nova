-- ORBIS AI — record prompt-cache hits separately (they're billed at a lower rate),
-- and show them in the admin request log. The log function gets a new name
-- (admin_request_log_v2) because its result columns changed; the old one is
-- left in place, unused.
alter table public.model_runs add column if not exists cached_input_tokens integer
  check (cached_input_tokens is null or cached_input_tokens >= 0);
comment on column public.model_runs.cached_input_tokens is 'Input tokens served from the provider prompt cache (included in input_tokens), when the provider reports them.';

create or replace function public.admin_request_log_v2(p_limit integer default 100, p_email text default null)
returns table (
  created_at timestamptz,
  request_id uuid,
  user_email text,
  purpose text,
  requested_model text,
  model_id text,
  served_model text,
  fallback_from text,
  routing_reason text,
  status text,
  error_code text,
  latency_ms integer,
  input_tokens integer,
  cached_input_tokens integer,
  output_tokens integer,
  units numeric,
  entitlement text,
  estimated_cost numeric,
  tools text[]
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.admins a where a.user_id = (select auth.uid())) then
    raise exception 'Administrators only' using errcode = '42501';
  end if;
  return query
    select m.created_at, m.request_id, u.email::text, m.purpose, m.requested_model, m.model_id, m.served_model, m.fallback_from,
           m.routing_reason, m.status, m.error_code, m.latency_ms, m.input_tokens, m.cached_input_tokens, m.output_tokens, m.units,
           m.entitlement, m.estimated_cost, m.tools
    from public.model_runs m
    left join auth.users u on u.id = m.user_id
    where p_email is null or u.email ilike p_email
    order by m.created_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;
revoke all on function public.admin_request_log_v2(integer, text) from public, anon;
grant execute on function public.admin_request_log_v2(integer, text) to authenticated;
