-- ORBIS AI — persistent projects and task history.
-- A code project gets an optional description (its owner can edit it), and the
-- coding agent's runs get an index for listing a user's tasks across all their
-- projects by last activity (the History page). Additive only.

alter table public.code_projects
  add column if not exists description text check (description is null or char_length(description) <= 500);

grant update (description) on public.code_projects to authenticated;

create index if not exists code_agent_runs_user_updated on public.code_agent_runs (user_id, updated_at desc);
