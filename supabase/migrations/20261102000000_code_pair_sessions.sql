-- ORBIS AI — Pair coding: two AI agents (an Architect and a Reviewer) work on
-- one coding task. A pair task is an ordinary coding-agent run (same project,
-- files, activity log, change records, checkpoints, history and billing) with
-- its two-agent state kept here: the plan, each review's findings and their
-- status, the Architect's responses, rounds, and the live text of the step in
-- progress. Owner-only like the rest of the run (row-level security).

alter table public.code_agent_runs
  add column if not exists pair jsonb check (pair is null or octet_length(pair::text) <= 400000);

grant insert (pair) on public.code_agent_runs to authenticated;
grant update (pair) on public.code_agent_runs to authenticated;
