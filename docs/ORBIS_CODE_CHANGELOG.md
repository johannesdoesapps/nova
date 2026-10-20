# Orbis Code — changelog

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
