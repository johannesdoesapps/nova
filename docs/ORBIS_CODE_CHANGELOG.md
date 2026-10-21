# Orbis Code — changelog

## 21 October 2026 — websites from a prompt

### Fixed
- **Website requests failed**: agent steps could only write as much as a chat reply (pages were cut off), and a large file write broke the repeat detector's database limit so the run was stuck ("That file name or size isn't allowed"). Steps now get 16,000 output tokens (or the plan's reply limit when higher), and the detector stores short hashes.
- A build that ran after the computer started wasn't recorded as the run's build.
- An open session didn't notice a run that could continue after an answer given elsewhere.
- The agent column was squeezed to ~230 px with the file list and preview open on a 1200 px screen; it now keeps at least 400 px.

### Added
- `start_preview` (start the site's server on port 3000 and wait until it answers) and `check_preview` (headless Chromium in the project's computer at desktop and phone sizes: errors, failed loads, sideways scrolling, broken links and anchors, placeholder links, forms, the phone menu, screenshots the model sees).
- Website guidance for the agent; earlier sessions' summaries in a new session; old file contents left out of later turns.
- Run checks (`checks` column, migration `20261022040000_code_agent_checks.sql`, applied): development server, browser check and production build, each current or stale, in the report.
- Code start screen: **Build a website** (prompt, examples, new or existing project). Workspace: the preview opens and reloads with the agent's work; Run shares the agent's preview server; **Ask for changes to the site** after each session; `GET /api/code/projects/[id]/preview`.

See ORBIS_CODE_WEBSITES.md and the QA report.

## 20 October 2026 — simpler sidebar, redesigned Code, Stop fix

### Changed
- **Sidebar**: one navigation list (`src/components/studio/nav.ts`) drives the sidebar (expanded, collapsed, phone drawer) and the command palette. The old Chat | Code switch, which repeated the Chat and Code links, is gone: there is one Chat and one Code entry. In Code, the sidebar shows New project and recent projects instead of chats.
- **Code start screen**: "What would you like to build or fix?", how it works in three steps, continue where you left off, Try an example (a small calculator with a failing test), Import from GitHub, New project.
- **Code workspace**: the agent is the main panel. Files and Sessions on the left; editor, changes, preview, terminal and Quick edit open on the right when needed. Phones open on the agent.
- **Progress** is shown as plain-English stages built from the run's real activity (Understanding, Exploring, Planning, Editing, Running checks, Reviewing), each with Details showing the actual commands and output.
- **Permission modes** replace the separate switches: Ask first (default), Review each edit, Let it work, Read only.
- **Report card**: what changed and why, the checks that actually ran, files with Open buttons, anything still open; Review changes, Run tests, Undo all changes.
- **Sessions**: every agent run in the project, reopenable with its report.
- Visitors whose chat needs an account now see "Create a free account" and "Sign in" instead of "Try again".

### Fixed
- **Stop**: a Stop that arrived while a step was saving could be overwritten, and the next step went on to edit files. Steps now save with a conditional update that never undoes a Stop, and the agent re-checks Stop right before any action that changes the project or runs a command.
- The checkpoints list returns 404 for someone else's run, like the other run routes (it returned an empty list before).
- Loading placeholders in the sidebar have `role="status"` (an accessibility error).

### Database
- None.

## 20 October 2026 — agent runtime, native tool calling, checkpoints, verified reports

### Added
- **Native tool calling** for Claude (Messages API tools) and GPT (Chat Completions functions) through a new provider method, `toolTurn`. Other providers keep the JSON reply format. Conversations are stored in one provider-neutral form.
- **Tools**: `inspect_project`, `inspect_diff`, `git_status`, `create_checkpoint`, `restore_checkpoint`, `run_tests`, `inspect_test_results`; `search_code` can search file names.
- **Test results**: output of Vitest, Jest, Mocha, node:test, pytest, unittest and Go parsed into counts and failing tests; the project's test command is detected.
- **Checkpoints** (`code_agent_checkpoints`): saved by the agent before risky changes; restorable from the Changes panel.
- **Bounds**: token budget (600k default), working-time limit (30 min), failed test runs in a row (3), repeated identical steps (3), in addition to the step limit. Each pauses the run and asks.
- **Recovery**: an interrupted step's actions are reported to the model as "may or may not have run"; step requests carry `expectStep`, so a retried request never repeats a step; a request keeps taking steps while young (fewer round trips); a closed tab no longer cuts a model call in half.
- **Usage and cost per run** (tokens, estimated cost from verified prices, model calls, working time), shown while the agent works.
- **Final report**, built by the server from records: files changed with line counts, commands and exit codes, the latest tests, and whether the work is verified (tests passed after the last change), failed, stale or not run.
- **Secrets**: `.env` and similar files are listed but never sent to the model.
- **UI**: read-only badge until the plan is approved, usage line, report card, limit prompts per reason, checkpoints list with Restore, file search in the explorer.
- **Docs**: ORBIS_CODE_ARCHITECTURE, ORBIS_CODE_SECURITY, ORBIS_CODE_TEST_PLAN, ORBIS_CODE_QA_REPORT, ORBIS_RELEASE_CHECKLIST.

### Changed
- Test commands run through `run_command` are recorded as test runs too, and their event titles show the parsed result ("Tests failed (1 passed, 1 failed): npm test").
- `node --test` is on the list of commands that run without asking.
- `POST /api/code/agent/[runId]/step` accepts `{ "expectStep": n }` and may return `skipped: "stale"`.

### Database
- Migration `20261022030000_code_agent_runtime.sql` (additive): new columns on `code_agent_runs` (`token_budget`, `usage`, `active_ms`, `time_limit_ms`, `tests`, `recent`, `last_edit_at`, `report`) and the `code_agent_checkpoints` table with owner-only, add-and-read-only access. Applied to production on 20 October 2026.

### Rollback
- Revert the commit and redeploy. The migration is additive and older code ignores the new columns and table, so it can stay in place.

## Earlier
- Coding agent with plan approval, command policy, change records and revert; Code workspace (projects, editor, terminal, preview, Quick edit, GitHub import and push). See CODE_AGENT.md and CODE_WORKSPACE.md.
