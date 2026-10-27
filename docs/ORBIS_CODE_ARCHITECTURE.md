# Orbis Code — architecture

Orbis Code is the Code mode at `/code`: a workspace for real projects and a coding agent that inspects, plans, edits, runs tests in an isolated computer, fixes what fails and reports what actually happened. This document describes the system as it is implemented, including what isn't built yet.

Related: [ORBIS_CODE_SECURITY.md](ORBIS_CODE_SECURITY.md), [ORBIS_CODE_TEST_PLAN.md](ORBIS_CODE_TEST_PLAN.md), [ORBIS_CODE_QA_REPORT.md](ORBIS_CODE_QA_REPORT.md), [CODE_AGENT.md](CODE_AGENT.md) (behaviour), [CODE_WORKSPACE.md](CODE_WORKSPACE.md) (projects, computer, limits).

## 1. Audit of the platform it sits in (20 October 2026)

| Area | What exists | Reused for Code |
| --- | --- | --- |
| Frontend | Next.js 16 App Router, React 19, Tailwind v4 tokens, Studio shell (`src/components/studio/*`) | Code pages live in the Studio shell; the Chat/Code switch is in the sidebar |
| Backend | Route handlers under `src/app/api`, `src/proxy.ts` (auth refresh, legal consent gate) | Every Code API is a route handler with `codeContext()` (signed-in user + rate limit) |
| Database | Supabase Postgres, row-level security on every user table, column grants, append-only audit tables | Projects, files, runs, events, changes, checkpoints |
| Auth | Supabase Auth (email, Google, GitHub), `getClaims` in the proxy | Ownership is enforced by RLS (`user_id = auth.uid()`), not by the API alone |
| Models | `src/lib/ai`: a registry of Claude, GPT, Gemini, Grok, DeepSeek and Hugging Face models, Auto routing, tiers per plan, verified prices | The agent resolves its model through the same router and tiers |
| Plans and usage | `src/lib/usage.ts` (`enforceLimits` reserve → charge → record, monthly budgets), `src/lib/plans.ts` | Each agent step is metered like a chat message (`purpose: code_agent`) |
| Execution | Vercel Sandbox microVMs (`@vercel/sandbox`) for chat code runs and the Code workspace | The agent runs commands only in the project's workspace computer |
| Chat streaming | Server-sent streams for chat | Not used by the agent; it uses short requests plus polling (§5) |
| GitHub | GitHub App connection (`src/lib/github`), import, push to a new branch | Import a repository as a project; push a project to a new branch |

Before this work, Code already had: projects with files in the database, a CodeMirror editor, a terminal and preview on a per-project sandbox, Quick edit, and a first coding agent (JSON-format replies, plan approval, command policy, change records and revert).

**Gaps found and closed in this round:** native tool calling for Claude and GPT, checkpoints, a test runner with parsed results, project inspection, diff and status tools, file-name search, secret files kept out of model context, token and working-time budgets, a failed-test attempt limit, repeated-action detection, recovery of an interrupted step, step requests that are safe to retry, per-run usage and cost, a final report built from records, and file search in the explorer.

**Gaps remaining** (§8): runs that continue with no page open, interactive commands, persistent installed packages, and live provider verification for models other than those listed in the QA report.

## 2. Components

```
Browser (Code page)
  ├─ Workspace: file explorer + search, editor (CodeMirror 6), terminal, preview
  ├─ Agent panel: request, options, live activity, approvals, report
  └─ Changes panel: runs, per-file diffs, checkpoints, revert/restore, push to GitHub
        │  JSON over HTTPS (session cookie; RLS applies to every query)
        ▼
Next.js route handlers (Vercel Functions)
  ├─ /api/code/projects/**           projects, files, computer, exec, Quick edit, GitHub push
  ├─ /api/code/projects/[id]/agent   list runs, start a run
  └─ /api/code/agent/[runId]/…       read, step, respond, cancel, revert, checkpoints
        │
        ├─ Agent engine (src/lib/code/agent/engine.ts) — the task lifecycle
        │     ├─ provider adapters (src/lib/ai/providers/*: toolTurn)
        │     ├─ tools (src/lib/code/agent/tools.ts, tool-specs.ts) — validated, executed by the server
        │     ├─ command policy (policy.ts), test parsing (test-results.ts), report (report.ts)
        │     └─ records (runs.ts) — Supabase with the user's own session
        └─ Workspace computer (src/lib/code/workspace.ts) — Vercel Sandbox microVM per project
```

## 3. Projects and filesystem boundaries

- **Project** = a row in `code_projects` (stable UUID, owner `user_id`, name, run command, template, optional source repository). Files are rows in `code_files`, one per path.
- **Paths** are validated twice: by `projectPath` (Zod) in the API and tools, and by database checks. Only plain relative paths: no leading `/`, no `.`/`..` segments, no backslashes or control characters; package/build folders (`node_modules`, `.git`, `dist`, …) are excluded. There is no way for a tool to name a path outside the project, because tools never touch a host filesystem: they read and write database rows.
- **Limits** (database-enforced): 300 files, 3 MB per project, 200 KB per file.
- **The computer**: when a command needs it, the project's files are copied into a Vercel Sandbox microVM (`/vercel/sandbox`); changed files are copied back after each command, binary/oversized files skipped. A local Git repository is initialised there so `git status/diff/log` work in the terminal.
- **GitHub**: repositories are imported or pushed through the GitHub App (no passwords; installation tokens; push only to a *new* branch, confirmed by the user).

## 4. Tools

Every tool call is validated against its schema (`tool-specs.ts`), checked against the run's permissions, and executed by the server. The model never executes anything.

| Spec name | Orbis tool | Notes |
| --- | --- | --- |
| `inspect_project` | `inspect_project` | Languages, manifests, test command, README, instruction files (marked untrusted), secret files listed but withheld |
| `list_files` | `list_files` | Paths and sizes; secrets flagged |
| `read_file` | `read_files` | Up to 8 files per call, 30k characters each; secret files withheld |
| `search_files` | `search_code` | Contents (plain or regex) or file names (`names: true`); 80 matches max |
| `write_file` | `write_file` | Whole file |
| `apply_edit` | `edit_file` | Exact search/replace that must match once; `delete_file` too |
| `inspect_diff` | `inspect_diff` | Unified diff of the run's changes (before the run → now) |
| `git_status` | `git_status` | Files created/modified/deleted by the run, files changed by someone else since, latest tests, checkpoints |
| `create_checkpoint` | `create_checkpoint` | Snapshot of every file the run has changed |
| `restore_checkpoint` | `restore_checkpoint` | Back to a checkpoint or `"start"`; files changed by others are left alone |
| `run_command` | `run_command` | Shell command in the project computer, 2-minute limit, policy applies |
| `run_tests` | `run_tests` | Detected or given test command; parsed result |
| `inspect_test_results` | `inspect_test_results` | Latest result with failing tests and output tail |
| `read_web_page` | `read_web_page` | Text of one public page through the safe link reader (no private addresses, size and time limits); checked by Bastion like a web search; injection attempts flagged |
| `update_todos` | `update_todos` | The agent's to-do list (whole list each time, one item in progress); logged as a `plan` event with `detail.todos` and shown as a card in the agent panel |
| — | `lookup_docs`, `github`, `propose_plan`, `ask_user`, `finish` | Web docs (when configured), read-only GitHub, plan, question, end |

Command cancellation is the run's Stop (kills the running job). Tool output is truncated before it reaches the model (6k characters of command output, 30k per file, 40k per diff) and the activity log (20k).

## 5. The agent runtime

A run is a row in `code_agent_runs`. A **step** is one model turn plus the actions it asked for.

1. **Start** (`POST /api/code/projects/[id]/agent`): validates the request and options, checks the project belongs to the user (RLS), creates the run (`planning` when plan approval is on).
2. **Step** (`POST /api/code/agent/[runId]/step` with `expectStep`):
   - takes the run's lock (`locked_until`, 5 minutes) only when it's in a working state and not held — two tabs can't run the same step;
   - refuses to run if the run already moved past `expectStep` (a retried request never repeats a step);
   - checks bounds **before** spending anything: step limit, token budget, working-time limit;
   - recovers an interrupted step (§6);
   - builds the prompt: a fixed system prompt + the stored transcript, trimmed to the plan's history size;
   - reserves usage (`enforceLimits`), calls the model with a 110 s timeout that is *not* tied to the browser request (closing the tab doesn't cut a step in half);
   - stores the model's request for actions **before** executing them, then runs the actions in order (stopping at the first that needs the user), writing each activity event as it happens;
   - records usage and cost, test results, repeated-action signatures, working time, last-edit time;
   - keeps taking steps in the same request while the run is working and the request is under 45 s old.
3. **Pauses**: plan approval, command approval, edit review, a question, starting the computer, or a limit (steps, tokens, time, failed tests, repeated actions). `POST …/respond` answers; `continue` raises the relevant limit.
4. **End**: `finish`, two replies in a row with no actions, a model refusal, unreadable replies, or Stop. The server then builds the **report** from records (§7).

Bounds (defaults, unchanged by the 2026-10-27 upgrades): 20 steps (+10 per approval, max 100), 600,000 tokens (+300,000, max 10 M), 30 minutes of agent working time (+15, max 4 h), 3 failed test runs in a row (+2), 3 identical steps in a row, 8 actions per step, 1 command per step, 2 minutes per command, the plan's output-token limit per reply.

**Streaming and reconnection.** The page asks the step route for a stream (`Accept: application/x-ndjson`). While the request takes its steps it sends JSON lines: `step` (a step starts), `text` (the model's words as it writes them; Claude tool turns are streamed for this), `model_done`, `events` (each activity event as it's saved), `ping` every 15 s, then `done` with the usual result or `error` with the usual error body. The live channel is in-process (`src/lib/code/agent/live.ts`: `addEvents` and the engine publish to watchers of that run), so it costs no extra database reads. The activity log stays the record: it is append-only and numbered, the page still reads `GET /api/code/agent/[runId]?after=<seq>` every 2.5 s for the run's state, and it advances its read position only through numbers it has seen without a gap, so an event written by another request in between is fetched rather than missed. A reloaded page or another device picks up from the log. Without the Accept header the route answers plain JSON as before (pair coding uses that). GPT and the JSON-format providers don't stream text yet; their activity still streams.

**Long runs.** When the conversation no longer fits the plan's history size, the oldest steps are left out and replaced, in the first message, by a record of what they did: one line per action with whether it worked, and the start of each step's thinking (`digestSteps`, at most 4,000 characters, newest kept). The cut is moved in blocks of 12 messages, so the prompt before the newest messages stays the same for several steps and the provider's prompt cache keeps working.

## 5a. Keep working after the page is closed (2026-10-27)

New tasks keep working when their page is closed (the **Keeps going if closed** switch next to the mode, on by default; stored in the browser and sent as `options.background` when the task starts). Code: `src/lib/code/agent/background.ts`, `src/app/api/code/agent/worker/route.ts`.

1. A step request (and starting a task, and answering it) ends by asking the **worker** (`POST /api/code/agent/worker`, which only accepts the `CRON_SECRET` bearer token, compared in constant time) to look at the run. The worker answers 202 at once and works in `after()`.
2. It waits 8 seconds. If the page took the next step meanwhile (the run's lock is held, or it was updated in the last few seconds), it leaves the run to the page: the page's request will hand over again when it ends.
3. Otherwise it opens a session **for the run's owner**: the admin key is used only to look the owner up, generate a magic-link token and redeem it on the server (no email is sent). Everything after that uses a client carrying the owner's own access token, so row-level security and the owner's plan limits and metering apply exactly as on the page. The worker never queries project data with the admin client; it only reads the run's state and owner from the run's id.
4. It takes steps for up to 230 seconds (the route stops at 300), signs that session out, and, if the run made progress and is still working, hands over to a fresh worker call.
5. It stops when the run ends or waits for the user (a question, an approval, a limit, the computer). An error is written to the run's activity log, and the worker doesn't retry in a loop.

Requirements: `SUPABASE_SERVICE_ROLE_KEY` and `CRON_SECRET` (both set in production). Notes: each background stretch counts as one sign-in for the owner in Supabase Auth (it updates "last signed in"); generating a magic-link token replaces a sign-in link the owner may have requested by email in the same moment; Supabase limits token verifications per hour (each worker call uses one). Runs started before this change never resume by themselves.

## 6. Model providers

`AIProvider.toolTurn` is the provider abstraction for tool calling (`src/lib/ai/types.ts`):

- **Claude** (`anthropic.ts`): Messages API through the official SDK. Tools are sent as client tools with `tool_choice: auto` (forced tool choice is rejected by the current models). Each assistant turn's `tool_use` blocks are answered by one user turn with a `tool_result` per call (`is_error` on failures). Thinking is kept within the plan's output limit: off on Haiku 5.5, `between_tools` on Sonnet 5.5, low effort on Opus 5.5. Thinking blocks are not replayed between turns because the agent trims long histories (replaying blocks after an edit would be rejected); each turn starts from the visible conversation.
- **GPT** (`openai-compatible.ts`): Chat Completions function calling (`tools`, `tool_choice: auto`); results go back as `tool` messages; arguments that aren't valid JSON become a validation error for that call.
- **Other providers** (Gemini, Grok, DeepSeek, Hugging Face): the JSON reply format (`{"thought", "actions"}`), parsed and validated the same way. The conversation is stored in one neutral form (`TranscriptMessage` with `calls`/`results`), so either rendering works and a run can change model.
- **Errors**: rate limits, timeouts and 5xx are retried once by the provider client; a step whose model call fails isn't counted, its usage hold is released, and the run stays resumable. Provider error details are logged, never shown. A refusal ends the run with an honest message; a reply cut off at the output limit has none of its actions run.
- **Credentials** stay in server environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …). No consumer subscription is used as API access.
- **Usage**: each step's tokens and estimated cost (from verified prices; `null` when a model has no verified price) accumulate on the run (`usage`) and are recorded in `model_runs` for finance.

## 7. Records and the report

| Table | What | Write rules |
| --- | --- | --- |
| `code_agent_runs` | request, status, options, plan, pending, transcript, steps/limits, token budget, usage, working time, tests, recent signatures, last edit, report | owner only; id/owner/project never change |
| `code_agent_events` | numbered activity log: inspections, plan, edits, commands (exit code, output tail, parsed tests), approvals, errors, checkpoints, reverts | append-only for users |
| `code_agent_changes` | per file: content before the run's first touch, latest content, revert time | "before" can't be rewritten |
| `code_agent_checkpoints` | label + content of every file the run had changed | add and read only |

The **report** (`report.ts`) is built by the server when a run ends: files changed (now vs before the run, with line counts), commands that actually ran and their exit codes, the latest test result, and a verification status — `passed` only when a test run passed **after the last change**; otherwise `failed`, `stale` (files changed after the last test run) or `not_run`. The agent's own summary and unresolved list are shown, labelled as its words.

## 8. Not built yet / known limits

- **Runs started before 2026-10-27, or with "Pauses if closed"** still advance only through the page's requests; a closed page pauses them after the current step, and **Continue** resumes them.
- **Interactive commands** (waiting for keyboard input) and long-running servers via the agent (use Run).
- **Installed packages don't persist** between computer sessions (snapshots cost storage).
- **Editor**: CodeMirror 6 is kept (already integrated, smaller than Monaco, works on phones).
- **Token budgets** are stored in the user's own run row; a user can raise their own run's budget. Spending is still bounded by the plan's monthly budget, which is enforced server-side in the usage ledger.
- **Model coverage**: native tool calling is implemented for Anthropic and OpenAI; see the QA report for which models were verified live.
