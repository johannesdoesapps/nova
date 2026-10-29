-- ORBIS AI — Orbis Code sessions that keep going, and project agent settings.
--
-- * A session (a coding agent run) now continues over many messages: a follow-up
--   reopens it with the conversation intact, messages sent while it works wait in
--   its inbox for the next step, and it can be rewound to an earlier message or
--   forked into a new session.
-- * Commands can run in the background (several at once) while the agent works.
-- * Each project keeps the agent settings the user chose: their permission rules
--   ("always allow npm test"), MCP servers, and which version of the project's
--   own .orbis/settings.json they trusted.
-- * A project can be copied into a parallel copy for a task and merged back.
--
-- Additive only: new columns with defaults, a wider step limit, two functions.

-- ---------------------------------------------------------------- sessions

alter table public.code_agent_runs
  -- Messages the user sent while the agent was working: [{text, at}], taken by the next step.
  add column if not exists inbox jsonb not null default '[]'
    check (jsonb_typeof(inbox) = 'array' and octet_length(inbox::text) <= 40000),
  -- The session this one was forked from (its conversation was copied).
  add column if not exists forked_from uuid references public.code_agent_runs (id) on delete set null,
  -- Commands running in the background: [{id, jobId, command, startedAt, offset, done?}].
  add column if not exists bg_jobs jsonb not null default '[]'
    check (jsonb_typeof(bg_jobs) = 'array' and octet_length(bg_jobs::text) <= 8000);

-- A session that continues over many messages takes more steps than a single task.
alter table public.code_agent_runs drop constraint if exists code_agent_runs_step_limit_check;
alter table public.code_agent_runs add constraint code_agent_runs_step_limit_check check (step_limit between 1 and 2000);

grant insert (forked_from) on public.code_agent_runs to authenticated;
-- options: the permission mode and model can change between messages of a session. request: a session rewound to
-- before its first message starts again from the message sent next.
grant update (inbox, bg_jobs, options, request) on public.code_agent_runs to authenticated;

-- Add a message to a working session's inbox (at most 20 waiting). Returns how many wait, or nothing when the
-- session isn't the caller's or has ended. Row-level security applies (security invoker).
create or replace function public.code_agent_push_message(p_run uuid, p_text text)
returns int
language sql
security invoker
set search_path = ''
as $$
  update public.code_agent_runs
     set inbox = inbox || jsonb_build_array(jsonb_build_object('text', left(p_text, 4000), 'at', now()))
   where id = p_run
     and status not in ('completed', 'failed', 'cancelled')
     and jsonb_array_length(inbox) < 20
  returning jsonb_array_length(inbox);
$$;

-- Take every waiting message at once (the inbox is emptied in the same statement, so none is lost or given twice).
create or replace function public.code_agent_take_messages(p_run uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  with old as (
    select id, inbox from public.code_agent_runs where id = p_run and jsonb_array_length(inbox) > 0 for update
  )
  update public.code_agent_runs r
     set inbox = '[]'::jsonb
    from old
   where r.id = old.id
  returning old.inbox;
$$;

revoke all on function public.code_agent_push_message(uuid, text) from public, anon;
revoke all on function public.code_agent_take_messages(uuid) from public, anon;
grant execute on function public.code_agent_push_message(uuid, text) to authenticated;
grant execute on function public.code_agent_take_messages(uuid) to authenticated;

-- Rewind points: a checkpoint taken before each message the user sends records how long the conversation was then
-- (messages, and the length of the last one: a new message is often added to the end of the last one).
alter table public.code_agent_checkpoints
  add column if not exists kind text not null default 'manual' check (kind in ('manual', 'turn')),
  add column if not exists transcript_len int check (transcript_len is null or transcript_len >= 0),
  add column if not exists tail_chars int check (tail_chars is null or tail_chars >= 0),
  add column if not exists message text check (message is null or char_length(message) <= 400);
grant insert (kind, transcript_len, tail_chars, message) on public.code_agent_checkpoints to authenticated;

-- ---------------------------------------------------------------- projects

alter table public.code_projects
  -- {rules: {allow: [...], deny: [...]}, mcp: [{name, url, auth?}], trustedSettings: "<sha256>"}; secrets sealed by the server.
  add column if not exists agent_settings jsonb not null default '{}'
    check (jsonb_typeof(agent_settings) = 'object' and octet_length(agent_settings::text) <= 40000),
  -- A parallel copy: the project it was copied from, what it's for, and each file's hash when copied (to merge back).
  add column if not exists parent_project_id uuid references public.code_projects (id) on delete set null,
  add column if not exists copy_task text check (copy_task is null or char_length(copy_task) <= 200),
  add column if not exists copy_base jsonb
    check (copy_base is null or (jsonb_typeof(copy_base) = 'object' and octet_length(copy_base::text) <= 300000));

grant update (agent_settings) on public.code_projects to authenticated;
grant insert (agent_settings, parent_project_id, copy_task, copy_base) on public.code_projects to authenticated;
grant update (copy_base) on public.code_projects to authenticated;
