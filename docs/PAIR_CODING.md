# Pair Coding — two AI models on one coding task

Sidebar → Tools → **Pair Coding** (`/pair`). An **Architect** plans and writes the code; a **Reviewer** (ideally a different model) reviews it independently with evidence, reads the test results and verifies every fix. They take turns until the review passes or the rounds the user allowed are used.

## Architecture

Pair Coding is built on Orbis Code's existing, tested infrastructure rather than beside it:

| Need | How it's met |
|---|---|
| Projects, file explorer, editor (syntax highlighting), terminal, run and preview | The Code workspace (`/pair/<project>` is the same workspace with the pair panel instead of the single agent). Files are stored in the database (`code_files`). |
| Isolated execution | The project's computer: a Vercel Sandbox microVM per project (1 vCPU, 2 GB, time-limited), with network access limited to npm and PyPI, no Orbis environment variables or keys, and Stop. Commands go through the coding agent's command policy: clearly safe commands (tests, builds, installs) run; anything else waits for the user's approval; a never-run list (deleting the system, sudo, publishing, `curl … \| sh` …) is refused. |
| Version control and rollback | Every change the Architect makes is recorded with the file's content before and after (`code_agent_changes`), with a checkpoint before each version (`code_agent_checkpoints`). The Changes panel shows diffs; "Undo all changes" reverts (skipping files changed since, which are listed). Push to GitHub is available from the workspace. |
| Orchestration | `src/lib/code/pair/engine.ts`: a pair task is a coding-agent run with a `pair` state column. Each step is one move — an agent's model call, or a test run — on the existing run lifecycle (one step at a time per task via a lock, a 270-second step budget, Stop, step/token/time limits, history, billing, the final report). |
| Structured outputs | Every agent reply is one JSON object validated with zod (`src/lib/code/pair/protocol.ts`): the plan, code changes (whole files, deletions, and a response to each finding), the review (verdict, findings with severity, category, file, line, **required evidence**, suggestion; ids it verified resolved or still open; test assessment), and the final write-up. A reply that doesn't match is asked for again once; twice in a row stops the task. |
| Streaming | Model replies are streamed; the text so far is saved about every 1.5 seconds and shown in that agent's column while it works. |
| Context across iterations | The request, the plan, the project's files (changed and planned files first, within a size budget; secret files never shown), all open findings with the Architect's responses, the latest test output, and the user's new instructions. |
| Models and keys | Each agent's model is chosen independently from the models enabled on the site (Model selector, or Auto). Provider API keys are server-side environment variables in Vercel (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. — see docs/MODELS.md); they never reach the browser or the sandbox. |
| Failures | Rate limits, timeouts and provider errors: the step isn't counted and can be retried (Continue); three failures in a row, or a rejected request, stop the task with the agent and model named. Model call time is bounded so a step ends before the route's limit. |

## Workflow

1. **Plan** (Architect): summary, architecture, files, tasks, decisions with reasons, test and run commands. Optionally waits for the user's approval or changes.
2. **Implement** (Architect): complete files, applied through the controlled path — paths must be plain project-relative paths (no `..`, no absolute paths), secret files (`.env`, keys) can't be written, 200 KB per file; a checkpoint first; every change recorded.
3. **Test**: the plan's test command in the project's computer, if the computer is on and the command is safe (otherwise it waits for approval, or is skipped with the reason).
4. **Review** (Reviewer): independent review against the priorities (correctness, security, architecture, performance, readability, requirements). Findings without evidence are refused by the format.
5. **Revise** (Architect): answers every open finding — accept (and change the code) or reject with a specific reason — and revises.
6. **Verify** (Reviewer): checks each earlier finding against the current code: resolved, still open, or the rejection accepted. A disputed rejection stays open.
7. Repeat 3–6 until the bar is met — the Reviewer approves, nothing critical or major is open, and the latest tests (if they ran) pass — or:
   - the rounds are used up, or
   - nothing blocking was fixed two reviews in a row (repeated unsuccessful changes),
   and then the user decides: accept the result as it is, allow one more round, or type instructions.
8. **Final** (Architect): summary, how it works, setup steps, run and test commands, known issues (open findings listed honestly). The report's state comes from the checks that ran, not from the agents.

The user can **Stop** at any time (an answer arriving when Stop is pressed isn't applied), **approve** the plan and sensitive commands, **send instructions** while it works (given to the next agent call), and **request revisions** after it ends (a new pair task that continues this one).

## Schema

Migration `20261102000000_code_pair_sessions.sql` (additive): `code_agent_runs.pair jsonb` (≤ 400 KB), insertable and updatable by the owner only (row-level security as for the rest of the run). The user's mid-task instructions are kept as append-only activity events, so a step saving its state can't overwrite them.

## APIs

- `POST /api/code/projects/<id>/agent` with `pair: { architect, reviewer, maxRounds (1–5), approvePlan, runTests }` — start a pair task.
- `POST /api/code/agent/<run>/step` — the next move (the page calls it while open).
- `POST /api/code/agent/<run>/respond` — approve or change the plan, approve or decline a command, answer the end-of-rounds question.
- `POST /api/code/agent/<run>/note` — instructions while it works.
- `POST /api/code/agent/<run>/cancel`, `…/revert`, `GET /api/code/agent/<run>` — as for the coding agent.
- `GET /api/code/tasks?kind=pair` — the user's pair tasks.

## Tests

`tests/pair-protocol.test.ts` (formats, evidence required, finding lifecycle, the bar, stall detection, round limits, prompts, path checks) and the "pair coding" suite in `tests/code-agent-engine.test.ts` (a full loop with a failing then passing test run, rejected findings with reasons, stopping repeated unsuccessful revisions and accepting with issues open, plan approval and changes, user instructions, refused paths, unreadable replies, Stop during an answer, approval for an unrecognised test command, provider failures).

## Limits

- Steps advance while the page is open (no background worker), as for the coding agent.
- Tests run only when the project's computer is on; starting it uses workspace minutes.
- Each agent call counts toward the user's plan like a coding-agent step; a pair task uses several calls per round.
- The Reviewer reads code and test output; it doesn't click through running apps (the coding agent's browser check isn't part of pair tasks yet).
