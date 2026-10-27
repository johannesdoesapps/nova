-- ORBIS AI — Coding agent commands that run longer than one step.
--
-- A command still running when its step has to end keeps running in the
-- project's computer (up to 10 minutes in all); the run remembers it here so
-- the agent can wait for it in later steps (wait_for_command) and Stop can end
-- it. {jobId, command, tool, startedAt, offset}; null when none is running.

alter table public.code_agent_runs add column if not exists job jsonb
  check (job is null or (jsonb_typeof(job) = 'object' and octet_length(job::text) <= 4000));
grant update (job) on public.code_agent_runs to authenticated;
