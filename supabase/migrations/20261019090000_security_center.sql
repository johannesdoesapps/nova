-- ORBIS AI — Security Center: the Sentinel, Threat Hunter and Code Guardian
-- agents' targets, runs, findings and an append-only audit trail.
-- Ownership of scan targets is re-proved by the server before every active
-- scan; verified_at here is only a display cache, never trusted on its own.

create table public.security_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  hostname text not null check (hostname ~ '^[a-z0-9.-]{1,253}$'),
  token text not null check (char_length(token) between 16 and 80),
  verified_at timestamptz,
  verified_method text check (verified_method in ('http_file', 'dns_txt', 'site_admin')),
  created_at timestamptz not null default now(),
  unique (user_id, hostname)
);

create table public.security_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  parent_id uuid references public.security_runs (id) on delete cascade,
  agent text not null check (agent in ('sentinel', 'threat_hunter', 'code_guardian', 'incident_responder', 'threat_intel', 'coordinated')),
  action text not null check (char_length(action) <= 60),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  asset text check (asset is null or char_length(asset) <= 300),
  scope text check (scope is null or char_length(scope) <= 60),
  tools jsonb not null default '[]'::jsonb check (octet_length(tools::text) <= 50000),
  summary text check (summary is null or char_length(summary) <= 40000),
  model_id text check (model_id is null or char_length(model_id) <= 120),
  stats jsonb not null default '{}'::jsonb check (octet_length(stats::text) <= 20000),
  error text check (error is null or char_length(error) <= 2000),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index security_runs_user_idx on public.security_runs (user_id, started_at desc);
create index security_runs_parent_idx on public.security_runs (parent_id);

create table public.security_findings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  run_id uuid references public.security_runs (id) on delete set null,
  last_run_id uuid references public.security_runs (id) on delete set null,
  agent text not null check (agent in ('sentinel', 'threat_hunter', 'code_guardian', 'incident_responder', 'threat_intel')),
  fingerprint text not null check (char_length(fingerprint) between 8 and 200),
  rule_id text not null check (char_length(rule_id) <= 80),
  title text not null check (char_length(title) between 1 and 300),
  description text not null default '' check (char_length(description) <= 8000),
  severity text not null check (severity in ('critical', 'high', 'medium', 'low', 'info')),
  confidence text not null check (confidence in ('confirmed', 'firm', 'tentative')),
  rationale text not null default '' check (char_length(rationale) <= 2000),
  asset text not null check (char_length(asset) between 1 and 300),
  location text check (location is null or char_length(location) <= 500),
  evidence jsonb not null default '[]'::jsonb check (octet_length(evidence::text) <= 40000),
  evidence_source text not null check (char_length(evidence_source) <= 60),
  remediation text not null default '' check (char_length(remediation) <= 8000),
  refs text[] not null default '{}' check (cardinality(refs) <= 10),
  status text not null default 'open' check (status in ('open', 'investigating', 'fix_proposed', 'fixed', 'accepted_risk', 'verified', 'false_positive')),
  verification text not null default 'not_verified' check (verification in ('not_verified', 'still_present', 'not_detected')),
  verification_note text check (verification_note is null or char_length(verification_note) <= 2000),
  related uuid[] not null default '{}' check (cardinality(related) <= 50),
  duplicate_of uuid references public.security_findings (id) on delete set null,
  user_note text check (user_note is null or char_length(user_note) <= 4000),
  patch text check (patch is null or char_length(patch) <= 30000),
  tests text check (tests is null or char_length(tests) <= 20000),
  occurrences int not null default 1 check (occurrences >= 1),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, fingerprint)
);
create index security_findings_user_idx on public.security_findings (user_id, severity, status);
create index security_findings_run_idx on public.security_findings (run_id);
create index security_findings_last_run_idx on public.security_findings (last_run_id);
create index security_findings_dup_idx on public.security_findings (duplicate_of);
create trigger security_findings_updated_at before update on public.security_findings
  for each row execute function public.set_updated_at();

-- Append-only: users may add and read their own entries, never edit or delete.
create table public.security_audit (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  action text not null check (char_length(action) <= 60),
  run_id uuid references public.security_runs (id) on delete set null,
  finding_id uuid references public.security_findings (id) on delete set null,
  detail jsonb not null default '{}'::jsonb check (octet_length(detail::text) <= 8000),
  created_at timestamptz not null default now()
);
create index security_audit_user_idx on public.security_audit (user_id, created_at desc);
create index security_audit_run_idx on public.security_audit (run_id);
create index security_audit_finding_idx on public.security_audit (finding_id);

alter table public.security_targets enable row level security;
alter table public.security_runs enable row level security;
alter table public.security_findings enable row level security;
alter table public.security_audit enable row level security;

create policy "security_targets_all_own" on public.security_targets for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "security_runs_all_own" on public.security_runs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "security_findings_all_own" on public.security_findings for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "security_audit_select_own" on public.security_audit for select to authenticated
  using (user_id = (select auth.uid()));
create policy "security_audit_insert_own" on public.security_audit for insert to authenticated
  with check (user_id = (select auth.uid()));
