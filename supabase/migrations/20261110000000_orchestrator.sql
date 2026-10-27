-- ORBIS AI — Orchestrator: configurable agent profiles, a persistent task queue, and a global limit of at most
-- three AI model executions at the same time (docs/ORCHESTRATION.md).
--
-- The limit is enforced here, not in application memory:
--   * orch_slots has exactly three rows (slot_no 1..3, enforced by a check constraint); an execution may only run
--     while it holds one, so a fourth simultaneous execution is impossible whatever the application does;
--   * orch_settings.max_concurrency (1..3) lowers the limit further;
--   * every slot change happens inside one of the functions below, which take the same transaction-scoped
--     advisory lock first, so concurrent workers are serialised and can't both take the last free slot;
--   * every slot has a lease that expires (execution timeout + grace); expired leases are reclaimed and their
--     attempts recorded as interrupted (outcome unknown) before any new work is dispatched.
--
-- Profiles, tasks, attempts and events belong to one administrator (RLS: owner_id = auth.uid() and is_admin()).
-- Queue functions (claim, finish, reconcile, slot leases) are for the server's service role only.

-- ---------------------------------------------------------------- settings and slots

create table if not exists public.orch_settings (
  id smallint primary key default 1 check (id = 1),
  max_concurrency smallint not null default 3 check (max_concurrency between 1 and 3),
  lease_grace_seconds int not null default 30 check (lease_grace_seconds between 5 and 300),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
insert into public.orch_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.orch_slots (
  slot_no smallint primary key check (slot_no between 1 and 3),
  lease_id uuid unique,
  attempt_id uuid,
  task_id uuid,
  owner_id uuid,
  purpose text check (purpose is null or char_length(purpose) <= 60),
  acquired_at timestamptz,
  expires_at timestamptz,
  check ((lease_id is null) = (expires_at is null))
);
insert into public.orch_slots (slot_no) values (1), (2), (3) on conflict (slot_no) do nothing;

-- ---------------------------------------------------------------- agent profiles

create table if not exists public.orch_agents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  description text not null default '' check (char_length(description) <= 2000),
  role text not null check (role in ('lead_developer', 'frontend_developer', 'backend_developer', 'security_engineer', 'qa_engineer', 'code_reviewer', 'custom')),
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{1,30}$'),
  model_id text not null check (char_length(model_id) between 1 and 120),
  system_instructions text not null default '' check (char_length(system_instructions) <= 20000),
  enabled boolean not null default true,
  allowed_tools text[] not null default '{}' check (cardinality(allowed_tools) <= 20),
  permissions jsonb not null default '{}'::jsonb check (jsonb_typeof(permissions) = 'object' and octet_length(permissions::text) <= 4000),
  task_types text[] not null default '{}' check (cardinality(task_types) <= 30),
  priority smallint not null default 50 check (priority between 0 and 100),
  timeout_seconds int not null default 120 check (timeout_seconds between 10 and 270),
  max_attempts smallint not null default 2 check (max_attempts between 1 and 5),
  retry_backoff_seconds int not null default 30 check (retry_backoff_seconds between 5 and 3600),
  max_output_tokens int not null default 4000 check (max_output_tokens between 256 and 32000),
  max_turns smallint not null default 4 check (max_turns between 1 and 8),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);
create index if not exists orch_agents_owner on public.orch_agents (owner_id, priority desc);
create trigger orch_agents_updated_at before update on public.orch_agents for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- tasks, attempts, events

create table if not exists public.orch_tasks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  project_id uuid references public.code_projects (id) on delete set null,
  parent_id uuid references public.orch_tasks (id) on delete set null,
  kind text not null default 'execute' check (kind in ('execute', 'plan')),
  task_type text not null default 'general' check (task_type ~ '^[a-z][a-z0-9_-]{0,39}$'),
  title text not null check (char_length(title) between 1 and 200),
  input text not null default '' check (char_length(input) <= 20000),
  status text not null default 'queued' check (status in ('queued', 'running', 'blocked', 'completed', 'failed', 'cancelled')),
  -- Why the task is blocked: waiting for its dependencies, or for an enabled agent that can take it.
  block_kind text check (block_kind is null or block_kind in ('dependencies', 'agent')),
  status_reason text check (status_reason is null or char_length(status_reason) <= 500),
  -- The agent asked for (agent_locked: only this agent may run it) or chosen at dispatch; null after a profile is deleted.
  agent_id uuid references public.orch_agents (id) on delete set null,
  agent_locked boolean not null default false,
  -- What actually ran last (kept when the profile is changed or deleted).
  agent_name text,
  provider text,
  model_id text,
  priority smallint not null default 50 check (priority between 0 and 100),
  depends_on uuid[] not null default '{}' check (cardinality(depends_on) <= 20),
  attempts smallint not null default 0 check (attempts >= 0),
  max_attempts smallint not null default 2 check (max_attempts between 1 and 5),
  retry_backoff_seconds int not null default 30 check (retry_backoff_seconds between 5 and 3600),
  -- True until the task's retry policy is fixed: its first dispatch then takes the policy of the agent that runs it.
  policy_from_agent boolean not null default true,
  run_after timestamptz not null default now(),
  current_attempt_id uuid,
  output text check (output is null or char_length(output) <= 100000),
  error text check (error is null or char_length(error) <= 4000),
  usage jsonb not null default '{}'::jsonb check (jsonb_typeof(usage) = 'object' and octet_length(usage::text) <= 4000),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  duration_ms bigint,
  updated_at timestamptz not null default now(),
  check (status <> 'blocked' or block_kind is not null)
);
create index if not exists orch_tasks_queue on public.orch_tasks (priority desc, created_at) where status = 'queued';
create index if not exists orch_tasks_owner on public.orch_tasks (owner_id, created_at desc);
create index if not exists orch_tasks_agent on public.orch_tasks (agent_id, created_at desc);
create index if not exists orch_tasks_parent on public.orch_tasks (parent_id);
create index if not exists orch_tasks_blocked_deps on public.orch_tasks using gin (depends_on) where status = 'blocked';

create table if not exists public.orch_attempts (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.orch_tasks (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  attempt_no smallint not null check (attempt_no between 1 and 5),
  agent_id uuid,
  agent_name text,
  provider text,
  model_id text,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted')),
  worker_id text check (worker_id is null or char_length(worker_id) <= 100),
  slot_no smallint,
  lease_id uuid,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finished_at timestamptz,
  error_kind text check (error_kind is null or char_length(error_kind) <= 40),
  error text check (error is null or char_length(error) <= 4000),
  model_calls int not null default 0,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(12, 6),
  unique (task_id, attempt_no)
);
create index if not exists orch_attempts_running on public.orch_attempts (expires_at) where status = 'running';

create table if not exists public.orch_events (
  id bigint generated always as identity primary key,
  task_id uuid references public.orch_tasks (id) on delete cascade,
  owner_id uuid references auth.users (id) on delete cascade,
  kind text not null check (char_length(kind) between 1 and 40),
  from_status text,
  to_status text,
  detail jsonb not null default '{}'::jsonb check (octet_length(detail::text) <= 8000),
  created_at timestamptz not null default now()
);
create index if not exists orch_events_task on public.orch_events (task_id, id);

-- ---------------------------------------------------------------- task rules (triggers)

-- New tasks: owner checks for the project, parent, agent and dependencies; the initial status comes from the
-- dependencies (blocked until they complete). A dependency that already failed or was cancelled is refused.
create or replace function public.orch_tasks_before_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  dep record;
  waiting int := 0;
begin
  if new.owner_id is null then raise exception 'A task needs an owner.'; end if;
  if new.project_id is not null and not exists (select 1 from public.code_projects p where p.id = new.project_id and p.user_id = new.owner_id) then
    raise exception 'Project not found.' using errcode = '42501';
  end if;
  if new.parent_id is not null and not exists (select 1 from public.orch_tasks t where t.id = new.parent_id and t.owner_id = new.owner_id) then
    raise exception 'Parent task not found.' using errcode = '42501';
  end if;
  if new.agent_id is not null and not exists (select 1 from public.orch_agents a where a.id = new.agent_id and a.owner_id = new.owner_id) then
    raise exception 'Agent not found.' using errcode = '42501';
  end if;
  if new.agent_locked and new.agent_id is null then raise exception 'A task locked to an agent needs that agent.'; end if;
  if (select count(distinct d) from unnest(new.depends_on) d) <> cardinality(new.depends_on) then raise exception 'Duplicate dependency.'; end if;
  for dep in select t.id, t.status, t.title, t.owner_id from unnest(new.depends_on) d left join public.orch_tasks t on t.id = d loop
    if dep.id is null or dep.owner_id <> new.owner_id then raise exception 'Dependency not found.' using errcode = '42501'; end if;
    if dep.status in ('failed', 'cancelled') then raise exception 'Dependency "%" has %.', left(dep.title, 80), dep.status using errcode = '23514'; end if;
    if dep.status <> 'completed' then waiting := waiting + 1; end if;
  end loop;
  new.attempts := 0;
  new.current_attempt_id := null;
  new.output := null;
  new.error := null;
  new.started_at := null;
  new.completed_at := null;
  new.duration_ms := null;
  new.run_after := now();
  new.created_at := now();
  if waiting > 0 then
    new.status := 'blocked';
    new.block_kind := 'dependencies';
    new.status_reason := format('Waiting for %s task%s to complete.', waiting, case when waiting = 1 then '' else 's' end);
  else
    new.status := 'queued';
    new.block_kind := null;
    new.status_reason := null;
  end if;
  return new;
end;
$$;
create trigger orch_tasks_before_insert before insert on public.orch_tasks for each row execute function public.orch_tasks_before_insert();

-- Status changes follow the lifecycle; anything else is refused.
--   queued  → running | blocked | cancelled | failed
--   blocked → queued | cancelled | failed
--   running → completed | failed | queued (retry) | cancelled
--   completed, failed, cancelled are final.
create or replace function public.orch_tasks_before_update()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status is distinct from old.status then
    if not (
      (old.status = 'queued' and new.status in ('running', 'blocked', 'cancelled', 'failed')) or
      (old.status = 'blocked' and new.status in ('queued', 'cancelled', 'failed')) or
      (old.status = 'running' and new.status in ('completed', 'failed', 'queued', 'cancelled'))
    ) then
      raise exception 'Invalid task status change: % → %.', old.status, new.status using errcode = '23514';
    end if;
    if new.status <> 'blocked' then new.block_kind := null; end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger orch_tasks_before_update before update on public.orch_tasks for each row execute function public.orch_tasks_before_update();

-- Every status change is recorded.
create or replace function public.orch_tasks_log()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.orch_events (task_id, owner_id, kind, to_status, detail)
    values (new.id, new.owner_id, 'created', new.status, jsonb_build_object('reason', new.status_reason, 'kind', new.kind, 'type', new.task_type, 'agent', new.agent_id, 'dependsOn', to_jsonb(new.depends_on)));
  elsif new.status is distinct from old.status then
    insert into public.orch_events (task_id, owner_id, kind, from_status, to_status, detail)
    values (new.id, new.owner_id, 'status', old.status, new.status, jsonb_build_object('reason', new.status_reason, 'attempt', new.current_attempt_id, 'attempts', new.attempts));
  end if;
  return null;
end;
$$;
create trigger orch_tasks_log after insert or update on public.orch_tasks for each row execute function public.orch_tasks_log();

-- When an agent is created or enabled, the owner's tasks that were waiting for an agent go back to the queue.
create or replace function public.orch_agents_requeue()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.enabled and (tg_op = 'INSERT' or not old.enabled or new.task_types is distinct from old.task_types or new.role is distinct from old.role) then
    update public.orch_tasks set status = 'queued', status_reason = null, run_after = now()
    where owner_id = new.owner_id and status = 'blocked' and block_kind = 'agent'
      and (not agent_locked or agent_id = new.id);
  end if;
  return null;
end;
$$;
create trigger orch_agents_requeue after insert or update on public.orch_agents for each row execute function public.orch_agents_requeue();

-- ---------------------------------------------------------------- queue internals (service role only)

-- Dependents of finished tasks: unblock those whose dependencies all completed; fail those with a dependency that
-- failed or was cancelled (and theirs, in turn).
create or replace function public.orch_resolve_dependents(p_changed uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  frontier uuid[] := p_changed;
  next_ids uuid[];
  r record;
begin
  while cardinality(frontier) > 0 loop
    next_ids := '{}';
    for r in
      select t.id, t.depends_on from public.orch_tasks t
      where t.status = 'blocked' and t.block_kind = 'dependencies' and t.depends_on && frontier
      for update
    loop
      if exists (select 1 from public.orch_tasks d where d.id = any (r.depends_on) and d.status in ('failed', 'cancelled')) then
        update public.orch_tasks t set status = 'failed', completed_at = now(),
          error = (select format('Not run: dependency "%s" %s.', left(d.title, 80), d.status) from public.orch_tasks d where d.id = any (r.depends_on) and d.status in ('failed', 'cancelled') limit 1),
          status_reason = 'A dependency did not complete.'
        where t.id = r.id;
        next_ids := next_ids || r.id;
      elsif not exists (select 1 from public.orch_tasks d where d.id = any (r.depends_on) and d.status <> 'completed') then
        update public.orch_tasks t set status = 'queued', status_reason = null, run_after = now() where t.id = r.id;
      end if;
    end loop;
    frontier := next_ids;
  end loop;
end;
$$;

-- After an attempt ends: complete, retry (bounded, with exponential backoff) or fail the task. A task the owner
-- cancelled while it ran stays cancelled. Returns the task's new status. p_now: retry without waiting (an
-- interrupted attempt says nothing about the provider, so there's nothing to back off from).
create or replace function public.orch_after_attempt(p_task uuid, p_attempt uuid, p_succeeded boolean, p_output text, p_error text, p_retryable boolean, p_now boolean default false)
returns text language plpgsql security definer set search_path = '' as $$
declare
  t public.orch_tasks%rowtype;
  wait_s int;
begin
  select * into t from public.orch_tasks where id = p_task for update;
  if t.id is null or t.current_attempt_id is distinct from p_attempt then return coalesce(t.status, 'missing'); end if;
  if t.status = 'cancelled' then
    update public.orch_tasks set current_attempt_id = null, completed_at = coalesce(completed_at, now()),
      duration_ms = (extract(epoch from (now() - coalesce(started_at, now()))) * 1000)::bigint
    where id = t.id;
    return 'cancelled';
  end if;
  if t.status <> 'running' then return t.status; end if;
  if p_succeeded then
    update public.orch_tasks set status = 'completed', status_reason = null, output = p_output, error = null, current_attempt_id = null,
      completed_at = now(), duration_ms = (extract(epoch from (now() - coalesce(started_at, now()))) * 1000)::bigint
    where id = t.id;
    perform public.orch_resolve_dependents(array[t.id]);
    return 'completed';
  end if;
  if p_retryable and t.attempts < t.max_attempts then
    wait_s := case when p_now then 0 else least(3600, t.retry_backoff_seconds * power(2, greatest(t.attempts - 1, 0))::int) end;
    update public.orch_tasks set status = 'queued', error = left(p_error, 4000), current_attempt_id = null,
      status_reason = left(format('Retry %s of %s in %ss after: %s', t.attempts + 1, t.max_attempts, wait_s, coalesce(p_error, 'an error')), 500),
      run_after = now() + make_interval(secs => wait_s)
    where id = t.id;
    return 'queued';
  end if;
  update public.orch_tasks set status = 'failed', error = left(coalesce(p_error, 'Failed.'), 4000), current_attempt_id = null,
    status_reason = case when p_retryable then format('Gave up after %s attempt%s.', t.attempts, case when t.attempts = 1 then '' else 's' end) else 'Not retried: this error would happen again.' end,
    completed_at = now(), duration_ms = (extract(epoch from (now() - coalesce(started_at, now()))) * 1000)::bigint
  where id = t.id;
  perform public.orch_resolve_dependents(array[t.id]);
  return 'failed';
end;
$$;

-- Reclaim expired leases. An attempt whose lease ran out without a result is recorded as interrupted (its outcome is
-- unknown: nothing it produced was saved) and its task is retried or failed like any other failed attempt.
-- Caller must hold the dispatch lock.
create or replace function public.orch_reconcile_locked()
returns int language plpgsql security definer set search_path = '' as $$
declare
  r record;
  n int := 0;
begin
  for r in select a.id, a.task_id, a.lease_id from public.orch_attempts a where a.status = 'running' and a.expires_at < now() for update loop
    update public.orch_attempts set status = 'interrupted', finished_at = now(), error_kind = 'interrupted',
      error = 'The worker stopped without reporting a result before its lease expired, so the outcome is unknown and nothing from this attempt was kept.'
    where id = r.id;
    update public.orch_slots set lease_id = null, attempt_id = null, task_id = null, owner_id = null, purpose = null, acquired_at = null, expires_at = null
    where lease_id = r.lease_id;
    insert into public.orch_events (task_id, owner_id, kind, detail)
    select r.task_id, t.owner_id, 'attempt_interrupted', jsonb_build_object('attempt', r.id) from public.orch_tasks t where t.id = r.task_id;
    perform public.orch_after_attempt(r.task_id, r.id, false, null, 'Interrupted: the worker stopped before reporting a result (outcome unknown).', true, true);
    n := n + 1;
  end loop;
  -- Leases not tied to an attempt (e.g. a provider check), or left behind by an attempt that already ended.
  update public.orch_slots s set lease_id = null, attempt_id = null, task_id = null, owner_id = null, purpose = null, acquired_at = null, expires_at = null
  where s.lease_id is not null and (s.expires_at < now() or (s.attempt_id is not null and not exists (select 1 from public.orch_attempts a where a.id = s.attempt_id and a.status = 'running')));
  return n;
end;
$$;

-- Take a free slot if the configured limit allows one. Caller must hold the dispatch lock.
create or replace function public.orch_take_slot_locked(p_seconds int, p_purpose text, p_attempt uuid, p_task uuid, p_owner uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  lim int;
  active int;
  s smallint;
  lease uuid := gen_random_uuid();
  grace int;
  until timestamptz;
begin
  select max_concurrency, lease_grace_seconds into lim, grace from public.orch_settings where id = 1;
  lim := least(coalesce(lim, 3), 3);
  select count(*) into active from public.orch_slots where lease_id is not null;
  if active >= lim then return null; end if;
  select slot_no into s from public.orch_slots where lease_id is null order by slot_no limit 1 for update;
  if s is null then return null; end if;
  until := now() + make_interval(secs => least(greatest(p_seconds, 1), 270) + coalesce(grace, 30));
  update public.orch_slots set lease_id = lease, attempt_id = p_attempt, task_id = p_task, owner_id = p_owner, purpose = left(p_purpose, 60), acquired_at = now(), expires_at = until
  where slot_no = s;
  return jsonb_build_object('slot', s, 'lease', lease, 'expiresAt', until);
end;
$$;

-- ---------------------------------------------------------------- queue API (service role only)

-- Dispatch: reclaim expired leases, then — if a slot is free — take the next eligible queued task, choose its agent,
-- record a new attempt and hold a slot for it, all in one transaction under the dispatch lock. Returns the work, or
-- null when there's nothing to run or no capacity. p_max_seconds: the most time the caller can give an attempt.
create or replace function public.orch_claim(p_worker text, p_max_seconds int default 270)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  t public.orch_tasks%rowtype;
  a public.orch_agents%rowtype;
  att uuid;
  slot jsonb;
  lim int;
  active int;
begin
  perform pg_advisory_xact_lock(727100);
  perform public.orch_reconcile_locked();
  select least(max_concurrency, 3) into lim from public.orch_settings where id = 1;
  select count(*) into active from public.orch_slots where lease_id is not null;
  if active >= coalesce(lim, 3) then return null; end if;
  for t in
    select * from public.orch_tasks where status = 'queued' and run_after <= now() order by priority desc, created_at limit 25 for update skip locked
  loop
    a := null;
    if t.agent_id is not null then
      select * into a from public.orch_agents where id = t.agent_id;
      if a.id is not null and not a.enabled then
        if t.agent_locked then
          update public.orch_tasks set status = 'blocked', block_kind = 'agent', status_reason = left(format('Waiting: agent "%s" is disabled.', a.name), 500) where id = t.id;
          continue;
        end if;
        a := null;
      end if;
    elsif t.agent_locked then
      update public.orch_tasks set status = 'blocked', block_kind = 'agent', status_reason = 'Waiting: the agent this task was assigned to was deleted.' where id = t.id;
      continue;
    end if;
    if a.id is null then
      select ag.* into a from public.orch_agents ag
      where ag.owner_id = t.owner_id and ag.enabled
        and (t.task_type = any (ag.task_types) or (cardinality(ag.task_types) = 0 and t.kind = 'execute') or (t.kind = 'plan' and ag.role = 'lead_developer' and cardinality(ag.task_types) = 0))
      order by ag.priority desc, (select count(*) from public.orch_attempts x where x.agent_id = ag.id and x.status = 'running'), ag.created_at
      limit 1;
      if a.id is null then
        update public.orch_tasks set status = 'blocked', block_kind = 'agent',
          status_reason = left(format('Waiting for an enabled agent that handles "%s" tasks.', t.task_type), 500)
        where id = t.id;
        continue;
      end if;
    end if;
    -- Leave it for a worker with more time left.
    if a.timeout_seconds > p_max_seconds then continue; end if;
    att := gen_random_uuid();
    slot := public.orch_take_slot_locked(a.timeout_seconds, 'task', att, t.id, t.owner_id);
    if slot is null then return null; end if;
    insert into public.orch_attempts (id, task_id, owner_id, attempt_no, agent_id, agent_name, provider, model_id, worker_id, slot_no, lease_id, expires_at)
    values (att, t.id, t.owner_id, t.attempts + 1, a.id, a.name, a.provider, a.model_id, left(p_worker, 100), (slot ->> 'slot')::smallint, (slot ->> 'lease')::uuid, (slot ->> 'expiresAt')::timestamptz);
    update public.orch_tasks set status = 'running', status_reason = null, agent_id = a.id, agent_name = a.name, provider = a.provider, model_id = a.model_id,
      attempts = t.attempts + 1, current_attempt_id = att, started_at = coalesce(started_at, now()),
      -- The retry policy of the agent that runs it (unless the task set its own).
      max_attempts = case when t.policy_from_agent then a.max_attempts else t.max_attempts end,
      retry_backoff_seconds = case when t.policy_from_agent then a.retry_backoff_seconds else t.retry_backoff_seconds end,
      policy_from_agent = false
    where id = t.id;
    insert into public.orch_events (task_id, owner_id, kind, detail)
    values (t.id, t.owner_id, 'dispatched', jsonb_build_object('attempt', att, 'attemptNo', t.attempts + 1, 'agent', a.id, 'agentName', a.name, 'provider', a.provider, 'model', a.model_id, 'slot', slot -> 'slot', 'worker', left(p_worker, 100)));
    return jsonb_build_object('attemptId', att, 'taskId', t.id, 'ownerId', t.owner_id, 'leaseId', slot ->> 'lease', 'slot', slot -> 'slot',
      'expiresAt', slot ->> 'expiresAt', 'attemptNo', t.attempts + 1, 'agentId', a.id, 'timeoutSeconds', a.timeout_seconds);
  end loop;
  return null;
end;
$$;

-- An attempt ended. Only the holder of the attempt's lease can finish it, once: a late or duplicate call (the lease
-- was reclaimed, or it already finished) changes nothing and returns 'stale'. Releases the slot.
create or replace function public.orch_finish(p_attempt uuid, p_lease uuid, p_outcome text, p_output text, p_error text, p_error_kind text, p_retryable boolean, p_usage jsonb default '{}'::jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  at public.orch_attempts%rowtype;
  tusage jsonb;
begin
  if p_outcome not in ('succeeded', 'failed', 'timed_out', 'cancelled') then raise exception 'Unknown outcome %.', p_outcome; end if;
  perform pg_advisory_xact_lock(727100);
  select * into at from public.orch_attempts where id = p_attempt for update;
  if at.id is null or at.status <> 'running' or at.lease_id is distinct from p_lease then return 'stale'; end if;
  update public.orch_attempts set status = p_outcome, finished_at = now(), error = left(p_error, 4000), error_kind = left(p_error_kind, 40),
    model_calls = coalesce((p_usage ->> 'modelCalls')::int, 0), input_tokens = coalesce((p_usage ->> 'inputTokens')::int, 0),
    output_tokens = coalesce((p_usage ->> 'outputTokens')::int, 0), cost_usd = (p_usage ->> 'costUsd')::numeric
  where id = at.id;
  update public.orch_slots set lease_id = null, attempt_id = null, task_id = null, owner_id = null, purpose = null, acquired_at = null, expires_at = null
  where lease_id = p_lease;
  select usage into tusage from public.orch_tasks where id = at.task_id;
  update public.orch_tasks set usage = jsonb_build_object(
      'modelCalls', coalesce((tusage ->> 'modelCalls')::int, 0) + coalesce((p_usage ->> 'modelCalls')::int, 0),
      'inputTokens', coalesce((tusage ->> 'inputTokens')::bigint, 0) + coalesce((p_usage ->> 'inputTokens')::int, 0),
      'outputTokens', coalesce((tusage ->> 'outputTokens')::bigint, 0) + coalesce((p_usage ->> 'outputTokens')::int, 0),
      'costUsd', case when (tusage ? 'costUsd' and tusage ->> 'costUsd' is null) or (p_usage ? 'costUsd' and p_usage ->> 'costUsd' is null) then null
                      else coalesce((tusage ->> 'costUsd')::numeric, 0) + coalesce((p_usage ->> 'costUsd')::numeric, 0) end)
  where id = at.task_id;
  insert into public.orch_events (task_id, owner_id, kind, detail)
  values (at.task_id, at.owner_id, 'attempt_' || p_outcome, jsonb_build_object('attempt', at.id, 'attemptNo', at.attempt_no, 'errorKind', p_error_kind, 'error', left(p_error, 500), 'usage', p_usage));
  return public.orch_after_attempt(at.task_id, at.id, p_outcome = 'succeeded', p_output, p_error, p_retryable and p_outcome in ('failed', 'timed_out'));
end;
$$;

-- Reclaim expired leases now (also done at every dispatch).
create or replace function public.orch_reconcile()
returns int language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(727100);
  return public.orch_reconcile_locked();
end;
$$;

-- A slot for a model execution that isn't a task attempt (a live provider check). Null when none is free.
create or replace function public.orch_acquire_slot(p_seconds int, p_purpose text, p_owner uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(727100);
  perform public.orch_reconcile_locked();
  return public.orch_take_slot_locked(p_seconds, p_purpose, null, null, p_owner);
end;
$$;

create or replace function public.orch_release_slot(p_lease uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform pg_advisory_xact_lock(727100);
  update public.orch_slots set lease_id = null, attempt_id = null, task_id = null, owner_id = null, purpose = null, acquired_at = null, expires_at = null
  where lease_id = p_lease and attempt_id is null;
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

-- Whether the attempt still holds its lease and its task wasn't cancelled (workers check between model calls).
create or replace function public.orch_attempt_state(p_attempt uuid, p_lease uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when a.id is null or a.status <> 'running' or a.lease_id is distinct from p_lease then 'stale'
    when t.status = 'cancelled' then 'cancelled'
    else 'running' end
  from (select 1) one
  left join public.orch_attempts a on a.id = p_attempt
  left join public.orch_tasks t on t.id = a.task_id;
$$;

-- ---------------------------------------------------------------- owner actions

-- Cancel a task (and its sub-tasks). A queued or blocked task ends at once; a running one is marked cancelled and
-- its worker stops at the next check (its slot is released when the attempt ends or its lease expires).
create or replace function public.orch_cancel(p_task uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  t public.orch_tasks%rowtype;
  ids uuid[];
begin
  if not public.is_admin() then raise exception 'Not allowed.' using errcode = '42501'; end if;
  -- The dispatch lock first, like every other queue change (row locks after it), so this can't deadlock with them.
  perform pg_advisory_xact_lock(727100);
  select * into t from public.orch_tasks where id = p_task and owner_id = (select auth.uid()) for update;
  if t.id is null then raise exception 'Task not found.' using errcode = 'P0002'; end if;
  if t.status in ('completed', 'failed', 'cancelled') then return t.status; end if;
  with recursive tree as (
    select id from public.orch_tasks where id = p_task
    union all
    select c.id from public.orch_tasks c join tree on c.parent_id = tree.id
  )
  select array_agg(id) into ids from tree;
  update public.orch_tasks set status = 'cancelled', status_reason = 'Cancelled by its owner.',
    completed_at = case when status = 'running' then completed_at else now() end
  where id = any (ids) and status in ('queued', 'blocked', 'running');
  perform public.orch_resolve_dependents(ids);
  return 'cancelled';
end;
$$;

-- ---------------------------------------------------------------- access

alter table public.orch_settings enable row level security;
alter table public.orch_slots enable row level security;
alter table public.orch_agents enable row level security;
alter table public.orch_tasks enable row level security;
alter table public.orch_attempts enable row level security;
alter table public.orch_events enable row level security;

revoke all on public.orch_settings, public.orch_slots, public.orch_agents, public.orch_tasks, public.orch_attempts, public.orch_events from anon, authenticated;

create policy orch_settings_admin_read on public.orch_settings for select to authenticated using ((select public.is_admin()));
create policy orch_settings_admin_update on public.orch_settings for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
grant select on public.orch_settings to authenticated;
grant update (max_concurrency, updated_by, updated_at) on public.orch_settings to authenticated;

create policy orch_slots_admin_read on public.orch_slots for select to authenticated using ((select public.is_admin()));
grant select on public.orch_slots to authenticated;

create policy orch_agents_owner on public.orch_agents for all to authenticated
  using (owner_id = (select auth.uid()) and (select public.is_admin()))
  with check (owner_id = (select auth.uid()) and (select public.is_admin()));
grant select, delete on public.orch_agents to authenticated;
grant insert (name, description, role, provider, model_id, system_instructions, enabled, allowed_tools, permissions, task_types, priority, timeout_seconds, max_attempts, retry_backoff_seconds, max_output_tokens, max_turns)
  on public.orch_agents to authenticated;
grant update (name, description, role, provider, model_id, system_instructions, enabled, allowed_tools, permissions, task_types, priority, timeout_seconds, max_attempts, retry_backoff_seconds, max_output_tokens, max_turns)
  on public.orch_agents to authenticated;

create policy orch_tasks_owner_read on public.orch_tasks for select to authenticated using (owner_id = (select auth.uid()) and (select public.is_admin()));
create policy orch_tasks_owner_insert on public.orch_tasks for insert to authenticated with check (owner_id = (select auth.uid()) and (select public.is_admin()));
grant select on public.orch_tasks to authenticated;
grant insert (project_id, parent_id, kind, task_type, title, input, agent_id, agent_locked, priority, depends_on, max_attempts, retry_backoff_seconds, policy_from_agent)
  on public.orch_tasks to authenticated;

create policy orch_attempts_owner_read on public.orch_attempts for select to authenticated using (owner_id = (select auth.uid()) and (select public.is_admin()));
grant select on public.orch_attempts to authenticated;
create policy orch_events_owner_read on public.orch_events for select to authenticated using (owner_id = (select auth.uid()) and (select public.is_admin()));
grant select on public.orch_events to authenticated;

revoke all on function public.orch_tasks_before_insert(), public.orch_tasks_before_update(), public.orch_tasks_log(), public.orch_agents_requeue() from public, anon, authenticated;
revoke all on function public.orch_resolve_dependents(uuid[]), public.orch_after_attempt(uuid, uuid, boolean, text, text, boolean, boolean), public.orch_reconcile_locked(),
  public.orch_take_slot_locked(int, text, uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.orch_claim(text, int), public.orch_finish(uuid, uuid, text, text, text, text, boolean, jsonb), public.orch_reconcile(),
  public.orch_acquire_slot(int, text, uuid), public.orch_release_slot(uuid), public.orch_attempt_state(uuid, uuid) from public, anon, authenticated;
grant execute on function public.orch_claim(text, int), public.orch_finish(uuid, uuid, text, text, text, text, boolean, jsonb), public.orch_reconcile(),
  public.orch_acquire_slot(int, text, uuid), public.orch_release_slot(uuid), public.orch_attempt_state(uuid, uuid) to service_role;
revoke all on function public.orch_cancel(uuid) from public, anon;
grant execute on function public.orch_cancel(uuid) to authenticated;
