# Orbis Code — test plan

What is tested, how, and where. Automated tests run with `npx vitest run`; database tests run the real migrations on PGlite (in-process Postgres). Live tests run against https://tryorbis.app with a dedicated test account and a disposable project; results are in [ORBIS_CODE_QA_REPORT.md](ORBIS_CODE_QA_REPORT.md).

## Automated tests

| Area (spec requirement) | File | What it checks |
| --- | --- | --- |
| Workspace path restrictions | `code-agent-tools.test.ts` → "tool calls are validated", `code-agent.test.ts` → "refuses unsafe paths", `code-workspace*.test.ts` | `../x`, `/etc/passwd`, `node_modules/…` rejected by the tool layer; database path checks |
| Cross-user authorization | `code-agent-db.test.ts`, `code-workspace-db.test.ts` | Another user can't see, create, change or add to runs, events, changes, checkpoints, projects or files (RLS on the real migrations) |
| File reads and edits | `code-agent.test.ts` → "agent tools" | list/read/search, write/edit/delete saved and recorded; edit must match once |
| Diff generation | `code-agent-tools.test.ts` → "diffs, status and checkpoints" | Unified diff format, created/deleted files, git-status listing, changes by others flagged |
| Checkpoints and restore | same | Restore to a checkpoint and to the start; files changed by someone else left alone; read-only before approval; DB: add/read only |
| Tool-call validation | `code-agent-tools.test.ts`, `code-agent.test.ts` | Unknown tools, non-object arguments, schema violations; every call answered with its id |
| Command approvals | `code-agent.test.ts` → "command policy", "asks before other commands" | allow/ask/block lists, chained commands, approval flow, `ask` and `off` modes |
| Destructive-command prevention | same + `code-agent-tools.test.ts` → "applies the command rules to a test command" | `rm -rf /`, `sudo`, `git push`, publish, deploy, curl-pipe-shell blocked, also when hidden in a chain or passed to `run_tests` |
| Command timeouts | `code-agent-tools.test.ts` → "reports a test run that timed out" | Timed-out command reported as such, never as passed |
| Test results | `code-agent-tools.test.ts` → "test results", "running tests" | Vitest, Jest, pytest, unittest, node:test, Mocha parsing; verdict rules; test-command detection |
| Cancellation | `code-agent-engine.test.ts` → "stops when the user cancels while the model is thinking", "cancels a run that's waiting" | Nothing runs after Stop; report written |
| Provider errors | `code-agent-engine.test.ts` → "doesn't count a step the model failed to answer", `agent-providers.test.ts` | Step not counted, usage hold released, run resumable; 429/401/503 mapped, retried once, details hidden |
| Provider adapters | `agent-providers.test.ts` | Claude and GPT request shapes (tools, tool choice, thinking/effort settings), tool calls parsed, invalid JSON arguments, cut-off replies, refusals |
| Streaming and reconnection | `code-agent-engine.test.ts` (events written as actions run); the page polls the numbered log | Activity is persisted per action; a new page reads from any sequence number |
| Task resumption | `code-agent-engine.test.ts` → "recovers an interrupted step" | Calls without results are answered "may or may not have run" before the next turn |
| Duplicate execution | `code-agent-engine.test.ts` → "never repeats a step when a request is retried", "doesn't run a step while another holds the run" | `expectStep` and the lock |
| Iteration limits | `code-agent-engine.test.ts` → "bounds" | Step limit, token budget, failed tests in a row, repeated actions, cut-off replies |
| Usage accounting | `code-agent-engine.test.ts` → "adds up tokens and cost", full-loop test | Tokens and cost per call, unknown prices stay unknown, estimates marked |
| Secret redaction | `code-agent-engine.test.ts` → "removes credentials", `code-agent-tools.test.ts` → "never sends a secrets file's contents to the AI" | Log scrubbing; `.env` contents never in any tool result |
| Final report | `code-agent-tools.test.ts` → "the final report", engine full-loop test | Files and commands from records; "passed" only after a passing run that followed the last edit |
| End-to-end (mocked model) | `code-agent-engine.test.ts` → "inspects, plans, waits for approval, fixes, tests, finishes" | The whole lifecycle with a failing test fixed and verified |

## Live acceptance test (production)

Disposable project with a small app and a deliberately failing test. Steps, each recorded with evidence:

1. Open Code, create the project, open the agent.
2. Ask: "The tests fail. Find the bug, fix it, and make the tests pass."
3. Observe inspection (project overview, files read), the plan, approve it.
4. Observe the edit, the diff, the real test run on the project's computer (output and exit code).
5. If the tests fail, the agent corrects and reruns.
6. Inspect the report: verified result, changed files, commands.
7. Restore the run's start (revert) and confirm the bug is back.
8. Negative checks: a forbidden command (`git push`) is blocked; reading outside the project is refused; another user's run id returns not found; Stop during a run ends it with nothing further run; a read-only run (before approval) can't edit.
9. Repeat the core loop with a GPT model (native tool calling) and note the result.

## Not covered

- Load testing (not run against production by policy).
- Real provider outages (simulated in unit tests only).
- Browser-level automated UI tests in CI (the live run drives the real UI with Playwright from this environment).
