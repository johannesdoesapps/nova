-- ORBIS AI — website checks for coding-agent runs: the preview server the
-- agent started, its latest browser check of the running site, and the
-- latest production build, each recorded from what actually ran.
-- Additive only: one new column.

alter table public.code_agent_runs
  add column if not exists checks jsonb check (checks is null or octet_length(checks::text) <= 20000);

grant update (checks) on public.code_agent_runs to authenticated;
