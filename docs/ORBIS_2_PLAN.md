# Orbis 2.0 — audit and staged plan for the coding agent

Brief: make Orbis a dependable AI coding agent with a personalised workspace. This document records what exists (from reading the code, 23 October 2026), what is missing, the order to build it in, and each stage's report. Details of the existing agent: [ORBIS_CODE_ARCHITECTURE.md](ORBIS_CODE_ARCHITECTURE.md), [ORBIS_CODE_SECURITY.md](ORBIS_CODE_SECURITY.md), [ORBIS_CODE_QA_REPORT.md](ORBIS_CODE_QA_REPORT.md).

## 1. Audit

| Area | What exists (and where) | Keep? |
| --- | --- | --- |
| Frontend | Next.js 16 App Router, React 19, Tailwind v4, Studio shell (`src/components/studio`), home at `/home` | Yes |
| Backend and data | Route handlers (`src/app/api`), Supabase Postgres with row-level security on every user table, column-level grants | Yes |
| Auth | Supabase Auth (email, Google, GitHub); `src/proxy.ts` refreshes sessions and gates consent | Yes |
| Models | Registry of Claude, GPT, Gemini, Grok, DeepSeek, Hugging Face; Auto routing; per-plan tiers; verified prices (`src/lib/ai`) | Yes |
| Provider adapters | `AIProvider.toolTurn`: native tool calling for Anthropic and OpenAI; JSON-format fallback for the others; streaming for chat; abort signals; usage per call | Yes |
| Usage and limits | `enforceLimits` reserve → charge → record, monthly budgets, per-run token/time/step budgets | Yes |
| Conversations | Chat streaming, history, archive, edit, search | Yes |
| **Agent loop** (`src/lib/code/agent/engine.ts`) | Task → context (files, key files, earlier runs) → tool calls validated by schema → results back to the model → iterate; plan approval; command approval; edit review; cancellation re-checked before every action that changes anything; 170 s model timeout; one retry on provider errors; interrupted-step recovery; idempotent steps (`expectStep`); repeat detection; bounded steps, tokens, time, failed test runs | Yes |
| **Tools** (`tool-specs.ts`, `tools.ts`) | inspect project, list/read/search files, write/edit/delete, diff, status, checkpoints and restore, run command, run tests (parsed), preview server, browser check with screenshots, docs search, read-only GitHub, plan, ask, finish | Yes |
| **Isolation** | Each project's commands run in its own Vercel Sandbox microVM (npm/PyPI network only, no Orbis secrets); file paths validated twice; secret files never sent to the model; command policy with a never-run list | Yes |
| **Honest reporting** | The final report is built from records: files changed, commands with exit codes, tests and whether they ran after the last edit, website checks with freshness | Yes |
| **Workspace** (`src/components/code`) | File explorer and search, CodeMirror editor, terminal, agent panel with live activity, sessions, changes panel with per-file diffs, checkpoints, undo, preview | Yes |
| Git | GitHub App import, push to a new branch with confirmation; a local repository in the sandbox for `git status/diff/log` | Yes |
| Testing | 736 unit/integration tests (Vitest, PGlite running the real migrations), live acceptance scripts against production | Yes |
| Logging | Activity log per run (append-only), `reportError`, Vercel runtime logs | Yes |

## 2. Gaps (verified missing)

| # | Gap | Brief step | Notes |
| --- | --- | --- | --- |
| 1 | **Project memory and instructions** that the user can inspect, edit and delete, loaded by relevance; reusable workflows | 5 | Only `AGENTS.md`-style files inside a project were read (as untrusted data). **Done in stage 1.** |
| 2 | **Evaluation suite** with metrics (completion, correctness, tests, wasted calls, recovery, latency, cost, permissions, regressions) | 9 | Tests and one-off acceptance scripts exist; no repeatable benchmark with numbers over time |
| 3 | **Specialised agents** (review, test, debug, architecture, research) with their own scopes | 7 | Read-only runs exist; a review agent can reuse them |
| 4 | **Pull requests** and commits with messages from the agent's work | 8 | Push to a new branch exists; no PR creation |
| 5 | **Runs that continue with no page open** | 2 | Needs a server credential (`SUPABASE_SERVICE_ROLE_KEY`, not configured) and a design that keeps per-user authorisation |
| 6 | **MCP-compatible tool integrations** | 6 | Connectors (Gmail, Drive, GitHub…) exist with their own interface; no MCP client |
| 7 | **Deployment integrations** | 8 | No per-user deploy credentials or infrastructure; will be built only with real credentials and confirmation |
| 8 | **Per-file accept/reject** after a run (today: review before saving, or undo the whole run or a checkpoint) | 4 | Partial |

## 3. Order

1. **Project memory** (stage 1): improves every task, needs no external service, and is the base for workflows and specialised agents.
2. **Evaluation suite**: a fixed set of tasks on fixture projects run through the real engine with real models, recording completion, test results, tool calls, errors recovered, time and cost; run before and after each later stage.
3. **Review agent**: a read-only second pass over a finished run's diff, findings consolidated into the report; then test and debug agents.
4. **Pull requests** from the push-to-branch flow.
5. **Per-file accept/reject** in the changes panel.
6. **MCP client** for user-configured servers (with the same approval rules as connectors).
7. **Background runs** once a server credential and per-user authorisation design are in place.
8. **Deploy integrations** when credentials exist.

## 4. Stage 1 report — project memory

**What was built**

- A `code_project_memory` table: instruction, architecture, decision, preference and workflow notes per project; `always` (every task); `status` active or proposed; `source` user or agent. Row-level security: only the project's owner. Limits: 100 notes per project, 20 suggestions waiting. Id, owner and project can't change.
- Choosing what a task gets (`src/lib/code/memory.ts`): approved notes only; instructions and "always" notes every time; others when they share words with the request (title words count double); within 6,000 characters. The first message lists them; the activity log says "Using N notes from project memory".
- Two agent tools: `search_memory` (approved notes) and `propose_memory` (a suggestion that waits for the user's approval; at most 2 per step; never used until approved).
- System prompt: memory is the user's guidance for the project, to follow unless the request says otherwise.
- API: `GET/POST /api/code/projects/[id]/memory`, `PATCH/DELETE /api/code/projects/[id]/memory/[memoryId]` (approve = `status: "active"`).
- Workspace: a **Memory** tab (beside Editor, Changes, Preview): add, edit, delete, approve or dismiss suggestions, and **Use** a workflow (it fills the agent's request).

**Files**: `supabase/migrations/20261023000000_code_project_memory.sql`, `src/lib/code/memory.ts`, `src/lib/code/memory-store.ts`, `src/app/api/code/projects/[id]/memory/**`, `src/lib/code/agent/{engine,protocol,tool-specs,tools}.ts`, `src/components/code/{memory-panel,workspace}.tsx`, `tests/code-memory.test.ts`, `tests/code-agent-engine.test.ts`, `tests/code-agent-tools.test.ts`.

**Tests**: see the stage report in the changelog for the exact runs and the live check.

**Not done in this stage**: memory is per project (not across a user's projects); relevance is word overlap, not embeddings; suggestions aren't shown inline in the agent's activity with approve buttons (they're in the Memory tab).
