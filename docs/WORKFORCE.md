# Nova Workforce — internal AI engineering workforce

`/workforce` (operators only). Specialised agents analyse, plan, build, test, repair,
review, security-check and verify changes to Nova — or any registered npm project — in
isolated workspaces. People approve what matters; nothing is pushed, merged or deployed.

## Architecture (inside the existing Next.js app)

```
Dashboard (/workforce, /workforce/tasks/[id])
   │  REST: /api/workforce/*  (admin-only; RLS enforces it again in Postgres)
   ▼
Nova Commander  src/lib/workforce/commander.ts   persistent state machine, ticks under a lease
   ├─ Agent registry        agents.ts           ids, versions, permissions, limits, models
   ├─ Executors             executors.ts        one per step type; the only code that touches tools
   ├─ Model adapter         models.ts / models-nova.ts   Nova providers + Auto routing, budgets, schema validation
   ├─ Workspace manager     workspace.ts / sandbox-vercel.ts   Vercel Sandbox microVM per task
   ├─ Allow-listed checks   checks.ts           only package.json scripts; no arbitrary commands
   ├─ Store                 store.ts / supabase-store.ts   wf_* tables (tasks, steps, events, approvals, memory)
   ├─ Metrics/benchmarks    metrics.ts
   └─ Report                report.ts           built from stored results, never by a model
```

Reused from Nova: Supabase auth + RLS (`is_admin()`), the multi-provider AI layer, Auto
routing and usage records (`model_runs`, purpose `workforce`), the glass UI and the Security
Team's secret/code rules. The Python engine (`engine/`) has a workflow runtime but isn't
deployed, so the Workforce runs in the web app and mirrors its patterns (hash-bound
approvals, usage ledger, event log).

## The workflow

UNDERSTAND → PLAN → APPROVE → BUILD → TEST → REPAIR → REVIEW → SECURITY → VERIFY → DELIVER

| Step | Agent | What actually happens |
|---|---|---|
| prepare | DevOps | Creates a Vercel Sandbox, clones the repo, `npm ci --ignore-scripts` with network limited to the npm registry, then **network denied** |
| baseline | QA Hunter | Runs required checks on the untouched code (in parallel with planning) so pre-existing failures are known |
| map | Archaeologist | `git ls-files`, `git grep` on keywords, project memory → model maps relevant files (paths validated against the repo) |
| plan | Architect | Model plan validated: files must exist (or not, for new files), protected paths rejected, risk raised to *high* for auth/migrations/CI/config |
| gate-plan | Commander | Approval bound to the plan's hash. Collaborate: always. Execute: automatic for low/medium risk, **high risk always needs a person**. Assist stops here |
| build | Builder | Model edits validated (exact unique search/replace, only planned files + tests, no protected files) and applied all-or-nothing; git checkpoint |
| test-N | QA Hunter | Runs required checks; new failures vs. baseline are separated from pre-existing ones |
| repair-N | Self-Heal | Model fix from real failure output; bounded by `maxRepairAttempts`; stops when the same failure repeats |
| security | Sentinel | Secret/code rules on **added lines** + optional AI diff review (quotes must exist in the diff); blocks at the configured severity |
| review | Reviewer | Independent model review of the real diff and real check results; assesses every acceptance criterion |
| buildcheck | DevOps | `npm run build` with network limited to Google Fonts |
| verify | Commander | Deterministic: required checks passed, build passed, reviewer approved, criteria met, no blocking security finding, non-empty diff |

A task is **Completed** only when verification passes; otherwise **Needs attention** with the
reasons. The report lists every check that actually ran with exit codes.

Task states: created (queued) → analyzing → planned → awaiting approval → running →
verifying → completed, plus failed, blocked, cancelled, needs attention and paused.

## Controls

- **Approvals** are rows bound to a payload hash; the orchestrator re-checks them before
  acting. "Revise plan" (reject with a note) re-plans; reject without a note cancels.
- **Budgets**: per-task USD (estimated from registry prices) and token limits are checked
  *before* each model call; exceeding them blocks the step and creates a budget approval.
  Models without a known price are refused unless explicitly allowed.
- **Limits**: max concurrent tasks (queue), parallel steps (one model call at a time per task),
  step timeouts, step retries, repair attempts.
- **Cancel** kills running checks (SIGTERM to the runner's process group), cancels pending
  steps, expires approvals and stops the sandbox. A model call already in flight finishes, but
  its result is discarded.
- **Pause/Resume**, **Retry** (failed/blocked steps; recreates the workspace from the stored
  diff), **Rework** (back to the builder with review findings and verification problems).
- **Emergency stop** pauses every active task and stops running checks; nothing advances
  until it's released.
- **Agent enable/disable**: disabled agents get no new steps; the task waits for attention.
- **Autonomy**: Assist / Collaborate / Execute, capped by the settings maximum. Continuous
  Operations is not implemented.

## Isolation and safety

- One disposable Vercel Sandbox (Firecracker microVM) per task, 45-minute timeout; no Nova
  secrets or environment variables are passed in.
- Commands are argv arrays from a fixed allow-list (`npm ci`, `npm run <existing script>`,
  `npx next typegen`, fixed git subcommands). Models never choose commands.
- Network: npm registry during install (lifecycle scripts disabled), denied otherwise; checks
  can open only pre-approved domains (Google Fonts for the build).
- File writes are limited to the task's workspace, the planned files and test files; `.git`,
  `node_modules`, `.env*`, build output and (by default) dependency manifests are protected.
- Repository content, logs and tool output are fenced as untrusted data in prompts.
- Secrets are redacted (patterns and known env values) from outputs, events and prompts.
- Every significant action is in `wf_events`; `audit` entries can't be edited or deleted.
- Operators are administrators; RLS restricts every Workforce row to its admin owner.

### Known limitations
- **Runner**: tasks advance while a task page is open (the page drives short ticks). Closing
  it pauses progress safely; reopening resumes. A background worker (Vercel Cron or Queues)
  is the next step.
- **Delivery**: changes are delivered as a reviewed diff/patch. Pushing a branch or opening a
  pull request needs a GitHub token with write access and is not implemented yet.
- **Nova Optimizer** and **Nova Visual** are registered as not available (no benchmark harness;
  no headless browser in the sandbox yet). Nothing is claimed for them.
- Only npm projects on GitHub; private repositories need `GITHUB_TOKEN`.
- Costs are estimates; sandbox time is reported as minutes, not dollars.

## Production run (2026-10-19)

A real task ("add a clamp utility with tests") was run on the live deployment against
`johannesdoesapps/nova`:

- Verified: project registration detected the real checks (typecheck, lint, test, build);
  Nova DevOps created a Vercel Sandbox (deny-all network after install) and cloned the repo
  at `c74c190` in about 19 s; the Archaeologist listed 456 files and searched them; the
  budget gate blocked the unpriced model as designed; Retry recreated the workspace; the
  failed task stopped its sandbox. Every step is in the task's audit log.
- Not reached: every model call failed because the deployment's `OPENAI_API_KEY` contains
  spaces or invalid characters (ordinary chat fails the same way). No plan, edit or
  verification was produced, and none is claimed. After re-pasting the key, run a task again.
- Found and fixed: Retry/Rework left the previous workspace running when the task had been
  blocked rather than failed; it is now stopped first (covered by a test).
- OpenAI prices are not in the model registry, so Workforce refuses OpenAI models unless
  **Allow unpriced models** is turned on in Workforce → Settings (budgets then count tokens
  and calls, not dollars).

## Setup

1. Apply `supabase/migrations/20261019100000_workforce.sql`.
2. Deploy on Vercel (Sandbox uses the function's OIDC token automatically). For local
   development set `NOVA_SANDBOX_TOKEN`, `NOVA_SANDBOX_TEAM_ID`, `NOVA_SANDBOX_PROJECT_ID`.
3. Make your account an admin (`insert into public.admins (user_id) values ('…')`).
4. Open `/workforce` → Projects → register `owner/repo` → New task.

## Stage 2 and 3 readiness

- **Autonomous Developer** = the same runtime pointed at any registered repository; nothing
  is Nova-specific except the default project.
- **Customer platform (not built yet)**. Minimum work before exposing it:
  1. Tenancy: add `org_id` to wf_* tables and RLS by org membership instead of `is_admin()`;
     internal operator privileges must never apply to customer agents.
  2. Agent definitions from the database (versioned rows) with a permission schema checked
     against a per-org policy; customer agents get read-only tools by default.
  3. Per-org sandboxes, secrets (BYO keys) and billing tied to the existing usage records.
  4. Workflow definitions as data (the Commander's graph extension rules become configurable).
  5. Marketplace only after security review, versioning and isolation are in place.
