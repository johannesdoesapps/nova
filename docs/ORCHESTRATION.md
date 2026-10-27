# Orbis Orchestrator — multi-agent task orchestration (backend, phase 1–2)

Configurable AI agent profiles, a persistent task queue and a central scheduler that never lets more than
**3 AI model executions** run at the same time across the whole orchestrator. Backend only: no dashboard,
no code writing, no Git merging, no deployment.

## Phase 1 — audit of the existing codebase

| Area | What exists | Reused for the orchestrator |
|---|---|---|
| Frameworks | Next.js 16 App Router (route handlers in `src/app/api/**/route.ts`), React 19, TypeScript, Tailwind v4 | Route handlers under `/api/orchestrator/*` |
| Hosting | Vercel functions (`maxDuration` up to 300 s), `after()` for background work, Vercel Cron (daily) | Worker route + `after()` kicks; the daily cron also kicks the worker |
| Database | Supabase Postgres, SQL migrations in `supabase/migrations`, Row Level Security everywhere, `security definer` functions for atomic multi-row changes (e.g. `usage_reserve_v5`, `code_workspace_reserve`) | New `orch_*` tables and functions in one migration |
| Auth | Supabase Auth; `requireUser()` (`src/lib/auth.ts`); administrators are rows in `public.admins` (`isAdmin()`, SQL `public.is_admin()`) | Orchestrator endpoints are admin-only and RLS-restricted to the row's owner |
| AI providers | `src/lib/ai`: Anthropic (native SDK) and OpenAI-compatible adapters for OpenAI, Google Gemini, xAI, DeepSeek, Hugging Face; model registry (`model_registry` table → `ORBIS_MODELS` → defaults) with capabilities and prices; keys only in server env (`KEY_VARS`) | Wrapped by the orchestrator's provider layer; no new SDKs |
| Metering | Usage ledger: `enforceLimits` (atomic reservation against the plan's allowance and budget), `recordRunLater`, `releaseUsage`; site-wide "Pause all AI" | Every orchestrator model call is reserved and recorded against the task owner's plan |
| Background work | Code agent worker (`/api/code/agent/worker`, `CRON_SECRET`-protected, `ownerSession()` acts as the owner so RLS and metering apply); Workforce Commander (lease per task, page-driven ticks) | Same worker pattern and owner sessions |
| Queues | No queue service (no Redis, Vercel Queues or pg-boss); queues are Postgres tables with leases | Durable queue in Postgres |
| Agent systems | Code agent (one run per task), Workforce (fixed pipeline, hard-coded agents, admin-only), agent platform (fixed catalogue, template DAG workflows), helper sub-agents | Patterns (leases, read-only tools, untrusted-data fencing, redaction); none of them has database-defined agents or a global model limit, so they are left unchanged |
| Git / execution | GitHub push/pull for Code projects; Vercel Sandbox workspaces; Workforce sandboxes with allow-listed checks | Not used in this phase (no writes, no commands) |
| Secrets | Provider keys in Vercel env; `src/lib/secrets.ts` (detect credentials), `src/lib/workforce/redact.ts` (patterns + known env values), `src/lib/connectors/crypto.ts` (AES-GCM sealing) | Redaction of outputs, errors and events; keys never leave the server |
| Safety controls | Bastion: lockdown and per-agent suspension (`agentSuspended`), admin audit log (`admin_audit`) | Lockdown/suspension of `orchestrator` stops dispatch; agent and settings changes are audited |
| Tests / quality | Vitest (unit + PGlite running the real migrations), ESLint, `tsc --noEmit`; PostgreSQL 16 binaries are installed in this environment | PGlite tests on the real migration; a separate race test on a real PostgreSQL server with parallel connections |

## Plan

1. **Reuse**: the AI provider registry and adapters, usage ledger, admin check + RLS conventions, owner
   sessions and the `CRON_SECRET` worker pattern, Bastion controls, admin audit log, redaction and prompt fencing.
2. **New**: `src/lib/orchestrator/*` (types, state machine, provider layer, store, scheduler/worker, executor,
   planner, server guard), `/api/orchestrator/*` routes, one migration, tests and this document.
3. **Integration**: tasks are created by admins through the API; creating a task kicks the worker; the worker
   (service role for queue functions, the task owner's own session for model calls and project files) claims
   work, runs it and kicks itself while work remains. The daily cron also kicks it.
4. **The 3-execution limit** is enforced in Postgres (see below), never by an in-memory counter.
5. **Database**: `orch_settings`, `orch_slots` (exactly three rows), `orch_agents`, `orch_tasks`,
   `orch_attempts`, `orch_events`, plus `orch_claim`, `orch_finish`, `orch_reconcile`, `orch_cancel` and
   triggers for state transitions and dependencies.
6. **Credentials**: provider keys stay in server environment variables; agent profiles store only a provider
   id and model id; responses report "configured: yes/no" and the env var name, never key material.
7. **Tests**: PGlite on the real migration (limit, queue, transitions, recovery, RLS), worker tests with a
   mock provider (clearly marked), provider/security tests, and a race test on a real PostgreSQL server.

Scope decision: the 3-slot limit governs **every model call made by the orchestrator** (task attempts,
retries, planning sub-tasks) across all projects, agents, workers and users. Orbis's existing chat, code agent
and Workforce keep their own limits; wiring them into the same slots would throttle the whole site to three
simultaneous answers and is left as an explicit decision for later (the slot functions are reusable).

## Architecture (as built)

```
admin ──HTTPS──▶ /api/orchestrator/*  (requireOrchestrator: signed in + administrator + rate limit; zod input)
                     │  agents, tasks, settings: the admin's own Supabase session → RLS (owner_id = auth.uid() and is_admin())
                     │  POST /tasks → after(): kick
                     ▼
              POST /api/orchestrator/worker  (CRON_SECRET only; answers 202, works in after(), ≤ 285 s)
                     │  runWorker loop: paused? → orch_claim → kick one more worker → executeAttempt → orch_finish → repeat
                     ▼
   Postgres  orch_claim / orch_finish / orch_reconcile  (service role only, one advisory lock, 3 slot rows)
                     │
                     ▼
   executeAttempt (one attempt = one slot): task owner's session → ModelGateway (resolve exact model →
   enforceLimits → provider adapter → recordRunLater) ; read-only project tools ; planner creates sub-tasks
```

| File | What it does |
|---|---|
| `supabase/migrations/20261110000000_orchestrator.sql` | Tables, constraints, indexes, RLS, column grants, state-transition and dependency triggers, queue functions |
| `src/lib/orchestrator/types.ts` | Roles, statuses, transitions, tools, limits, zod schemas, row → API views |
| `src/lib/orchestrator/errors.ts` | Error kinds and the retry decision; messages redacted |
| `src/lib/orchestrator/providers.ts` | Provider adapters (Orbis's six providers), model checks, capability detection, metered `orbisGateway` |
| `src/lib/orchestrator/tools.ts` | `read_project` (list_files, search_code, read_files): read-only, secret files withheld, output redacted and fenced |
| `src/lib/orchestrator/planner.ts` | Strict plan schema, dependency validation (earlier sub-tasks only → no cycles), ≤ 8 sub-tasks |
| `src/lib/orchestrator/executor.ts` | One attempt: lease/cancel check before every model call, time limit via AbortController, tool loop, planning |
| `src/lib/orchestrator/worker.ts` | The worker loop (claim, run, finish, hand over, wait for a retry due within 45 s) |
| `src/lib/orchestrator/background.ts` | Production wiring: service client, owner sessions, Bastion pause (fail closed), self-kick |
| `src/lib/orchestrator/server.ts` | Service layer for the routes: admin check, agent CRUD with checks and audit, tasks, settings, live provider check |
| `src/app/api/orchestrator/**/route.ts` | The HTTP API (below) |
| `src/app/api/cron/daily/route.ts` | Also kicks a worker once a day when orchestrator tasks are queued (backstop) |

### Task lifecycle

`queued → running → completed | failed | queued (retry)`; `queued ↔ blocked` (waiting for dependencies or for an
enabled agent); any unfinished state → `cancelled`; `queued/blocked → failed` when a dependency failed or was
cancelled. `completed`, `failed` and `cancelled` are final. The `orch_tasks_before_update` trigger refuses every
other transition, and only the service role (queue functions) can change status: an administrator cannot set a
task's status, output, attempts or agent snapshot directly (column grants). Scheduler steps 1–9 of the brief map to
`orch_claim` (pick the highest-priority due task, check dependencies, choose an enabled matching agent, check the
limit, take a slot atomically, start an attempt) and `orch_finish` / `orch_after_attempt` (record the result,
release the slot, retry or finish, unblock dependents); the worker then claims again, so the next queued task
starts as soon as a slot is free.

Agent selection: the assigned agent (if `agentId` is given the task is locked to it), otherwise the enabled agent of
the same administrator whose `task_types` include the task type (a generalist with no types takes any `execute`
task; a Lead Developer with no types takes `plan` tasks), ordered by priority, then by how busy it is. Disabled or
deleted agents never receive new work; locked tasks wait (`blocked`) and are re-queued when the agent is enabled.

### Retries, timeouts and recovery

- Retry policy: the agent's `maxAttempts` (1–5) and `retryBackoffSeconds`, applied at the task's first dispatch
  unless the task set its own `maxAttempts`. Backoff is exponential (`backoff × 2^(attempt-1)`, capped at 1 h).
  Errors that would happen again (missing or rejected credentials, unknown model, plan allowance, provider billing,
  bad request, refusal) are not retried.
- Time limit: each attempt is cut off at the agent's `timeoutSeconds` (10–270 s, inside one 300 s function call).
- Leases: a slot's lease lasts the time limit + `lease_grace_seconds` (30 s). Before every claim, expired leases
  are reconciled: the attempt is marked `interrupted`, the slot freed, and the task re-queued (or failed when it
  has no attempts left). A worker whose lease was reclaimed finds out before its next model call and records
  nothing (`orch_finish` returns `stale`), so a task is never completed by a worker that lost it and never
  assumed complete because a worker stopped.
- Idempotency: `orch_finish` only accepts the lease holder, once; duplicates return `stale`. Claiming uses
  `for update skip locked` under the advisory lock, so a task is dispatched once per attempt.
- Restarts: all state is in Postgres; a crashed worker's slot comes back when its lease expires.

## API

All routes need a signed-in Orbis **administrator** (401 signed out, 403 otherwise), validate input with strict zod
schemas (unknown fields → 400), are rate-limited per administrator, and only show the caller's own agents and tasks.

| Method and path | Purpose |
|---|---|
| `GET /api/orchestrator/agents` | List agent profiles |
| `POST /api/orchestrator/agents` | Create (`name, role, provider, modelId` required; `description, systemInstructions, enabled, allowedTools, permissions, taskTypes, priority, timeoutSeconds, maxAttempts, retryBackoffSeconds, maxOutputTokens, maxTurns` optional). Returns `{ agent, warnings }` |
| `GET /api/orchestrator/agents/:id` | One profile |
| `PATCH /api/orchestrator/agents/:id` | Change any field, including `enabled` and the model (re-checked) — same id, no re-creation |
| `DELETE /api/orchestrator/agents/:id` | Delete the profile (409 while it is running); tasks and attempts are kept with the agent's name and model |
| `GET /api/orchestrator/agents/:id/tasks` | The agent's tasks |
| `GET /api/orchestrator/tasks?status=&projectId=&agentId=&limit=` | List tasks |
| `POST /api/orchestrator/tasks` | Queue a task: `{ projectId, title, input?, kind?: "execute" \| "plan", taskType?, agentId?, priority?, dependsOn?, maxAttempts? }` |
| `GET /api/orchestrator/tasks/:id` | Task with attempts, sub-tasks and its event history |
| `POST /api/orchestrator/tasks/:id/cancel` | Cancel it and its unfinished sub-tasks |
| `GET /api/orchestrator/settings` | `maxConcurrency` (1–3), the hard limit and the three slots |
| `PATCH /api/orchestrator/settings` | `{ maxConcurrency: 1 \| 2 \| 3 }` |
| `GET /api/orchestrator/providers` | Providers, whether credentials are configured, the env var name, models and capabilities |
| `POST /api/orchestrator/providers/check` | A real call of a few tokens (`{ provider, modelId }`); takes a slot (429 when all are busy) |
| `POST /api/orchestrator/worker` | Internal: `Authorization: Bearer $CRON_SECRET` only |

Roles: `lead_developer`, `frontend_developer`, `backend_developer`, `security_engineer`, `qa_engineer`,
`code_reviewer`, `custom`. Tools: only `read_project` exists in this phase; asking for anything else (for example
`run_commands`, `write_files`, `git_push`, `deploy`) is refused.

## Providers and credentials

| Provider id | Credential (server environment variable) | Native tool calling in the orchestrator |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | yes |
| `openai` | `OPENAI_API_KEY` | yes |
| `google` | `GEMINI_API_KEY` | no (answers without tools) |
| `xai` | `XAI_API_KEY` | no |
| `deepseek` | `DEEPSEEK_API_KEY` | no |
| `huggingface` | `HUGGINGFACE_API_KEY` | no |

Models come from Orbis's model registry (database → `ORBIS_MODELS` → built-in list); an agent can only use a
registered model of its provider, and the gateway never substitutes another one. Keys are never stored in the
database or returned; the API reports `configured` and the variable's name. A profile can be saved without
credentials (with a warning); its tasks then fail with `auth`/`not_configured` and are not retried. The workers
also need `SUPABASE_SERVICE_ROLE_KEY` (queue functions and opening owner sessions) and `CRON_SECRET`
(worker route). New providers are added with `registerProviderAdapter()` plus their models in the registry.

## How the 3-execution limit is enforced

1. `orch_slots` has exactly three rows (`check (slot_no between 1 and 3)`); there is nowhere to record a fourth
   execution. `orch_settings.max_concurrency` is `check (between 1 and 3)`, and the code reads `least(…, 3)`.
2. Every execution takes a slot first, inside `pg_advisory_xact_lock(727100)`, which serialises all slot
   changes across every connection, worker, server and project: task attempts and retries (`orch_claim`),
   planning tasks (they are attempts too) and live provider checks (`orch_acquire_slot`). A queued, blocked or
   saved item holds no slot.
3. Under the lock, `orch_claim` reconciles expired leases, counts busy slots and refuses when the count has reached
   the setting. The lease, the attempt row and the task's `running` status are written in the same transaction.
4. An attempt's model calls are made one after another, so one slot is one model execution; tool calls run
   locally between model calls; the agents have no sub-agents.
5. Every outcome releases the slot: success, failure, timeout and cancellation (`orch_finish`), and a crashed or
   frozen worker (lease expiry → `orch_reconcile`). Lowering the setting takes effect at the next claim; running
   executions finish.
6. Nothing is counted in memory: a restart loses no state, and any number of function instances can run workers.

Not covered by the limit (scope decision above): Orbis's existing chat, code agent, Workforce and other features.

## Security

- Admin-only routes, plus RLS on every table (`owner_id = auth.uid() and is_admin()`); queue functions are executable by
  `service_role` only; `orch_cancel` checks admin + ownership itself. Cross-owner project, parent, agent and
  dependency references are refused by triggers.
- Model calls run in the task owner's own session (RLS, plan metering, Bastion), not with the service role.
- Agents can read the task's project only: secret files (`.env`, keys) are never sent, file contents and outputs are
  redacted for credentials, and everything the model reads is fenced as untrusted data. No terminal, writes, Git or
  deployment exist in this phase.
- Bastion lockdown or suspending the `orchestrator` agent stops dispatch and live checks (fail closed when
  Bastion's controls can't be read).
- Plan output is validated (strict schema, bounded size, acyclic). Task text and dependency outputs are data.
- Agent creation, changes, enable/disable, deletion and settings changes are written to `admin_audit`.
- Limits: per-attempt time limit, max turns, max output tokens, max attempts, plan allowance and budget
  (usage ledger), max 8 sub-tasks, max 20 dependencies.

## Setup

1. Apply `supabase/migrations/20261110000000_orchestrator.sql` (not applied to production yet).
2. Set `CRON_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` and at least one provider key (table above) in the server
   environment. Nothing else is required; no new services.
3. As an administrator: `POST /api/orchestrator/agents`, optionally `POST /api/orchestrator/providers/check`, then
   `POST /api/orchestrator/tasks` with a Code project id.

## Tests (run 2026-10-27, in this environment)

| Suite | What it covers | Kind | Result |
|---|---|---|---|
| `tests/orchestrator-db.test.ts` | Slots, 1 then 3 executions with the 4th queued, limit across projects/owners, settings 1–3, provider-check slots, retries/backoff, non-retryable errors, cancel, duplicate/stale finish, expired-lease recovery, restart, dependencies, transitions, agents (disabled, locked, deleted, selection), RLS | Real migrations on PGlite | 24/24 passed |
| `tests/orchestrator-race.test.ts` | 20 simultaneous dispatchers → exactly 3 win; 12 workers × 60 tasks → peak ≤ 3 running/slots (asserted ≥ 2, so it really ran in parallel), all 60 completed, 60 attempts (none dispatched twice); limit 1 → 1 winner | Real PostgreSQL 16 server, parallel connections (`ORCH_PG_URL`; skipped without it) | 3/3 passed |
| `tests/orchestrator-worker.test.ts` | Workers end to end: 6 workers × 6 tasks → never more than 3 model calls in flight, next starts when one ends; limit 1; Bastion pause; retry after the agent's backoff with no slot held; task-level attempt limit; credentials error not retried; timeout; cancellation mid-task; reclaimed lease records nothing and the task is retried once; owner-session failure; planning → sub-tasks in dependency order, each in its own slot; invalid plan rejected; tool permissions, `.env` withheld, secrets redacted from output; model without tool calling | **MOCK model gateway** (no provider called) on PGlite | 15/15 passed |
| `tests/orchestrator-api.test.ts` | Every route: 401 signed out, 403 non-admin, worker secret only; agent create/validate/update/model switch/enable/disable/delete with history kept; no profile limit; per-admin privacy; rate limit; tasks create/list/detail/cancel; settings 1–3; providers never return a key; live check without credentials and at the slot limit; Bastion pause | Real route handlers + RLS on PGlite; sign-in replaced; no provider called | 19/19 passed |
| `tests/orchestrator-unit.test.ts` | Error classification and retry decisions, redaction, provider/model checks, capability detection, no model substitution, adapter registration, planner validation, lifecycle, schemas, prompt, tool grants | Pure | 34/34 passed |
| Whole repository | `npx vitest run` with `ORCH_PG_URL` set | — | 145 files, 2,021 tests passed |
| `tsc --noEmit`, ESLint on changed files, `npm run build` | — | — | passed |

**No real-provider test was run**: there are no provider credentials in this environment. Nothing here shows that
an orchestrator task has run against a real model. The first real check is
`POST /api/orchestrator/providers/check` after the migration is applied and a key is configured.

## Limitations and open decisions

- The migration is **not applied** to production, and the code is not deployed.
- The 3-execution limit covers the orchestrator only (see the scope decision); Orbis's other AI features are
  not counted.
- A retry that is due more than 45 s later starts when something wakes a worker: a new task, another worker
  finishing, or the daily cron (a backstop at most once a day). There is no minute-level scheduler.
- One attempt must finish within 270 s (one function call); longer tasks need splitting (planning tasks) or a
  later phase.
- Native tool calling is wired for Anthropic and OpenAI only; agents on the other providers answer without
  reading the project (they are warned when saved).
- Agents only read projects: no file writes, commands, Git or deployment, and so no approval flow yet
  (`permissions.requireApprovalFor` is stored for the next phase but nothing uses it).
- Admin-only: ordinary users can't use the orchestrator in this phase.
- No dashboard (out of scope); the API is the interface.
