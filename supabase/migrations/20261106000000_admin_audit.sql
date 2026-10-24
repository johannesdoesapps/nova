-- ORBIS AI — Admin audit log: who changed platform-wide settings and agents, and when.
-- One row per consequential administrator action (saving platform settings, pausing or resuming an agent).
-- Details are summaries with secrets removed by the server before they're written; the log is append-only:
-- administrators can read and add rows, nobody can change or remove them through the API.

create table if not exists public.admin_audit (
  id bigint generated always as identity primary key,
  actor_id uuid not null default auth.uid(),
  action text not null check (char_length(action) between 1 and 60),
  target text check (target is null or char_length(target) <= 120),
  detail jsonb not null default '{}'::jsonb check (octet_length(detail::text) <= 8000),
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_created on public.admin_audit (created_at desc);

alter table public.admin_audit enable row level security;

drop policy if exists "admin_audit: admins read" on public.admin_audit;
create policy "admin_audit: admins read" on public.admin_audit
  for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

drop policy if exists "admin_audit: admins add their own" on public.admin_audit;
create policy "admin_audit: admins add their own" on public.admin_audit
  for insert to authenticated
  with check (actor_id = (select auth.uid()) and exists (select 1 from public.admins a where a.user_id = (select auth.uid())));

revoke all on public.admin_audit from anon;
revoke update, truncate, references, trigger on public.admin_audit from authenticated;
