-- ORBIS AI — hardening from the 26 October 2026 audit (docs/audits/orbis-deep-audit.md, ORB-001, ORB-002, ORB-011,
-- ORB-015, ORB-016, ORB-017). Additive and non-destructive: no rows are changed or deleted.
--
-- Deploy the application code from the same commit FIRST. It records model runs with the service role; with the
-- old code still running, this migration would stop runs from being recorded until the new code is live.

-- ORB-001: users could insert their own model_runs rows (any cost), and every row counts toward the site-wide
-- monthly AI cap and the in-flight checks. Runs are now written by the server with the service role only.
revoke insert on public.model_runs from anon, authenticated;
drop policy if exists "model_runs_insert_own" on public.model_runs;

-- ORB-002 (partial): a reservation's cost estimate comes from the caller, and active holds count toward the
-- site-wide cap. No real request is estimated anywhere near this (the default per-request maximum is $1), so a
-- single hold can no longer hold the whole site's budget. The full fix (reservations made only by the server)
-- is in the audit report.
create or replace function public.usage_holds_clamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')) is distinct from 'service_role' then
    new.est_cost_usd := least(new.est_cost_usd, 5);
  end if;
  return new;
end;
$$;
drop trigger if exists usage_holds_clamp on public.usage_holds;
create trigger usage_holds_clamp before insert or update of est_cost_usd on public.usage_holds
  for each row execute function public.usage_holds_clamp();

-- ORB-017: the site-wide sum of active holds scanned the whole table on every reservation.
create index if not exists usage_holds_active_expiry on public.usage_holds (expires_at) where state = 'active';

-- ORB-016: TRUNCATE ignores row-level security. The blanket revoke in 20261104000000 ran before these tables
-- existed, so Supabase's default privileges granted it again; future tables don't get it either.
revoke truncate on public.mimic_documents, public.mimic_workflows, public.mimic_runs, public.mimic_rules,
  public.mimic_ledger, public.mimic_events, public.mimic_settings, public.bastion_workspace_roles from anon, authenticated;
alter default privileges in schema public revoke truncate on tables from anon, authenticated;

-- ORB-015: Mimic's rows weren't removed with the account. NOT VALID: the cascade applies from now on without
-- checking (or touching) rows already there; orphaned rows from accounts deleted earlier are listed in the report
-- for the owner to decide on.
alter table public.mimic_documents add constraint mimic_documents_user_fk foreign key (user_id) references auth.users (id) on delete cascade not valid;
alter table public.mimic_workflows add constraint mimic_workflows_user_fk foreign key (user_id) references auth.users (id) on delete cascade not valid;
alter table public.mimic_runs add constraint mimic_runs_user_fk foreign key (user_id) references auth.users (id) on delete cascade not valid;
alter table public.mimic_rules add constraint mimic_rules_user_fk foreign key (user_id) references auth.users (id) on delete cascade not valid;
alter table public.mimic_ledger add constraint mimic_ledger_user_fk foreign key (user_id) references auth.users (id) on delete cascade not valid;
alter table public.mimic_events add constraint mimic_events_user_fk foreign key (user_id) references auth.users (id) on delete cascade not valid;
alter table public.mimic_settings add constraint mimic_settings_user_fk foreign key (user_id) references auth.users (id) on delete cascade not valid;

-- ORB-011: the website-ownership token is issued by the server; its owner must not be able to rewrite it.
revoke update on public.security_targets from anon, authenticated;
grant update (verified_at, verified_method) on public.security_targets to authenticated;
