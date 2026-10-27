# Coding agent (Code mode)

The agent works on one Code project at a time. The user describes a change. The agent then:

1. inspects the files;
2. plans, and waits for the user to approve the plan (this is on by default);
3. edits files;
4. runs tests, builds and other commands on the project's computer;
5. fixes what fails;
6. finishes with a summary.

Every action runs for real on the server. The results the agent sees, and the page shows, are what actually happened. When something can't run, it says so: for example, when the computer is off, commands are turned off, or web search isn't set up.

Code: `src/lib/code/agent/` (`types.ts`, `policy.ts`, `tool-specs.ts`, `protocol.ts`, `tools.ts`, `test-results.ts`, `report.ts`, `runs.ts`, `engine.ts`).
APIs: `src/app/api/code/projects/[id]/agent`, `src/app/api/code/agent/[runId]/…` (read, step, respond, cancel, revert, checkpoints).

Architecture, security, tests and the latest QA results: [ORBIS_CODE_ARCHITECTURE.md](ORBIS_CODE_ARCHITECTURE.md), [ORBIS_CODE_SECURITY.md](ORBIS_CODE_SECURITY.md), [ORBIS_CODE_TEST_PLAN.md](ORBIS_CODE_TEST_PLAN.md), [ORBIS_CODE_QA_REPORT.md](ORBIS_CODE_QA_REPORT.md).
Screens: `src/components/code/agent-panel.tsx` and `changes-panel.tsx`.

## How a run works

- **Runs** are rows in `code_agent_runs`. Each one stores:
  - the request and the user's options;
  - the plan;
  - what the run is waiting for (`pending`);
  - the agent's working memory (`transcript`, trimmed);
  - a step count and a step limit.
- **The page drives the run.** It calls `POST /api/code/agent/[runId]/step` with the step number it expects (`expectStep`); a request keeps taking steps while it's under 45 seconds old. So the agent works while the page is open; if the page is closed, the run pauses after the current step and shows **Continue**.
  - Each step is **one model call**, followed by the actions the model asked for.
  - Each step takes a lock (`locked_until`), so two tabs can't run the same step, and a retried request (`expectStep` already passed) never repeats one.
- **Tool calling.** Claude and GPT models get the tools natively (Messages API tools, Chat Completions functions). Other models answer with one JSON object, `{"thought", "actions": [{tool, args}]}`. Either way there are at most 8 actions per step, and every call is validated by the server before it runs.
- **Tools** (`tool-specs.ts`, `tools.ts`):
  - `inspect_project`, `list_files`, `read_files`, `search_code` (contents or file names);
  - `write_file`, `edit_file` (exact search/replace) and `delete_file`;
  - `inspect_diff`, `git_status`, `create_checkpoint`, `restore_checkpoint`;
  - `run_command`, `run_tests` (parsed results) and `inspect_test_results`;
  - `lookup_docs`, only when web search is configured and the plan has searches left;
  - `github` (read files, search issues, list repos), only when the user's GitHub connection is usable;
  - `propose_plan`, `ask_user` and `finish`.
- **Pauses.** A run stops and waits for the user to approve a plan, approve a command, review edits (when that option is on), answer a question, start the computer, or decide whether to go on after a limit: 20 steps, 600,000 tokens, 30 minutes of work, 3 failed test runs in a row, or the same actions three steps running.
  - The user answers with `POST …/respond`, using `approve`, `reject`, `answer`, `continue` or `stop`. Approving a command runs it right away; `continue` after a limit raises that limit.
- **Recovery.** The model's request for actions is stored before they run. If a step is cut off, the next one tells the model which actions may or may not have run, so it checks before repeating them.
- **Verification.** The agent calling `finish` ends its work, not the verification. Orbis then runs the checks that apply and haven't run since the agent's last change, through the same tool code: the project's tests (when it has a test setup) and a browser inspection (for a website whose preview is running). This is the *verifying* phase (`checks.verify`, one check per step, at most 2 tries per check; it survives an interrupted step). A check that applies but can't run — commands off, "Review every change" mode, the computer off, no preview server — is recorded as *not run* with the reason. `POST …/verify` re-runs every check that applies on a finished run (the click counts as approval).
- **Report.** When a run ends, the server builds a report from its records: files changed, commands and exit codes, the latest test run, and a checklist of every check that applies or ran (tests, build, server, browser inspection) with status (passed, failed, out of date, couldn't complete, not run), time, command, details and failing output.
- **Stop.** `POST …/cancel` stops the run. If a command is running, it is killed. A step that's in progress notices within seconds and ends.

## Task states

Worked out in `src/lib/code/agent/verdict.ts` from the run's status and its checklist — never from the agent's summary:

| State | Meaning |
| --- | --- |
| Queued | Created; no step taken yet |
| Working | Planning or working |
| Waiting for you | Paused for an approval, an answer, the computer or a limit |
| Verifying | The agent finished; Orbis is running the checks |
| Done and verified | Checks ran after the last change and every check that applies passed |
| Done, with warnings | A check failed, went out of date, couldn't complete or didn't run, or the agent left problems open |
| Done, not verified | No checks ran (or the record of checks is missing) |
| Failed / Stopped | The run ended with an error / the user stopped it |

A browser inspection (the page loads at desktop and phone sizes without errors, broken links or layout problems) is labelled as an inspection, separate from automated tests; it never stands in for tests the project has.

## Permission modes

The task box offers four presets of the run's options (the server enforces each):

| Mode | Options | What the agent may do |
| --- | --- | --- |
| **Ask first** (default) | plan approval on, safe commands | Read and plan; after the plan is approved, edit files and run tests, builds and installs; ask before other commands |
| **Review every change** | plan approval, edit review, every command asks | Nothing changes without an approval for the plan, each set of edits and each command |
| **Work on its own** | no plan approval, safe commands | Edit and run tests, builds and installs without asking; still asks before other commands; blocked commands never run |
| **Read-only** | `readOnly: true`, commands off | Read and answer only; edit, restore, checkpoint, command and plan tools aren't offered and are refused by the server |

## What the page shows

Progress is grouped into plain-English stages built only from the run's events: *Understanding your request* (the run started), *Exploring the project* (inspections), *Planning the changes* (a plan), *Editing files* (edits, restores), *Running checks* (commands and tests, blocked commands in red), *Reviewing the results* (finished). A stage appears only once an event of that kind exists. Each stage shows the agent's own notes and a one-line summary; **Details** lists the underlying events and command output. When a session ends, the verification panel shows the overall state and why, the task, the agent's summary (labelled as its words), each check with its status in words and an icon, the checks that didn't run and why, the files changed (each opens the file; a deleted one opens the changes), the commands run, open points and next steps, with **Review changes**, **Re-run checks**, **Open preview** and **Undo all changes**. The page ignores a response older than the state it already shows, carries on a run left verifying, and steps a run again when the connection it lost comes back.

## Safety

- **Isolation.** Commands run only in the project's own workspace computer (see CODE_WORKSPACE.md):
  - a Vercel Sandbox microVM;
  - none of Orbis's keys or credentials inside it;
  - network access to npm and PyPI only.
- **Command rules** (`policy.ts`):
  - **Run on their own:** tests, builds, linters, package installs, read-only commands, and running a project file.
  - **Need the user's approval:** anything else. This includes deleting files, writing outside the project, command substitution, and background jobs.
  - **Never run:** deleting the whole project or system, `sudo`, disk tools, fork bombs, publishing packages, `git push`, deploy CLIs, piping downloads into a shell, and killing every process.
  - **Chained commands** are judged part by part.
  - **Per run,** the user can choose "ask before every command" or "no commands".
- **Limits.** One command per step. A step waits up to 2 minutes for a command; one still running then keeps running in the background, up to 10 minutes in all, and the agent waits for it in later steps with `wait_for_command` (the run remembers it in `code_agent_runs.job`; Stop or the end of the run ends it). Meanwhile no other command runs. Long-running servers belong to `start_preview` or the Run button.
- **Plans first.** Until the plan is approved, edits and commands are refused.
- **Edit review (optional).** Proposed edits are shown as diffs and saved only when approved. If a file changed in the meantime, nothing is saved and the agent is told.
- **Untrusted content.** File contents, command output, web pages and repository text are given to the model as data. The system prompt tells it to ignore instructions inside them.
- **Secrets.** Before the activity log is stored, likely credentials are removed from it (API keys, bearer tokens, GitHub/Slack/AWS tokens and JWTs). Files that usually hold credentials (`.env`, keys, `credentials.json`, …) are listed but their contents are never sent to the model. The computer never holds Orbis's own secrets.
- **Audit trail.** `code_agent_events` records each run's activity:
  - what was read, searched, edited, run (with exit code and output), approved, declined and reverted.
  - It is append-only for users: they can add rows but never change or delete them.
  - It lives in the user's own rows, so it's a record for them, not tamper-proof evidence.
- **Changes and revert.** `code_agent_changes` keeps each file's content from before the run first touched it, and its latest content.
  - Users can't rewrite the "before".
  - **Revert** (a whole run, or one file) puts files back.
  - Files changed since the run are reported as conflicts and left alone unless the user confirms.
  - Files changed by commands (formatters, installs) are recorded too.
- **Never claims what didn't happen.** Results come from real executions. The prompt forbids the model from claiming runs or tests that no result shows.

## Metering

- **Steps.** Each step is reserved, charged and recorded like a chat message, with purpose `code_agent`, the plan's model tiers and the plan's output limit. A model failure isn't charged.
- **Per run.** Tokens, estimated cost (from verified prices; unknown when a model has none), model calls and working time are added up on the run and shown while it works and in its report.
- **Commands** use the project computer's workspace minutes.
- **Web lookups** count toward the plan's web searches.
- **Reply size.** The plan's output limit is respected. The agent is told to write big files in parts.

## Git and GitHub

- **Local history.** When the computer starts, the project is committed into a local Git repository (`git status`, `git diff`, `git log` work and are on the safe list). Package and build folders are excluded. This history stays in the computer.
- **Push to GitHub** (Changes → Push to GitHub, `POST /api/code/projects/[id]/github-push`):
  - The project's files become one commit on a **new branch**, on top of the repository's default branch.
  - Files deleted by agent runs are removed there too. Nothing else is deleted.
  - Existing branches are never written to. The user then opens a pull request from the link Orbis returns.
  - The user confirms in a dialog, and each push is recorded in `connector_actions`.
- **Requirements for pushing:**
  - the GitHub App from GITHUB.md;
  - **Contents: Read and write** permission. Read-only is enough for import. Without write permission, GitHub refuses and the user is told why.
  - At the time of writing the GitHub App isn't configured on tryorbis.app, so pushing can't work there yet. It has been tested only against a fake GitHub API.

## Live view, to-do list and long tasks (2026-10-27)

- **Live view:** while the agent works, its words appear as it writes them ("Writing…"), and each action shows up as it happens instead of at the next check of the log.
- **To-do list:** for tasks with three or more steps the agent keeps a to-do list (`update_todos`), shown under the task with what's done and what it's on now.
- **Web pages:** the agent can read a public web page (`read_web_page`), such as documentation or a changelog; the text is treated as data, and Bastion checks the request.
- **Keeps going if closed:** new tasks keep working after you close the page (switch next to the mode; on by default). Orbis continues the task as you, with your plan's limits, and stops when it needs you (a question, an approval, a limit). Come back to the project to see where it got to. See ORBIS_CODE_ARCHITECTURE.md §5a.
- **Slash commands:** type `/` in the task box for shortcuts: `/plan`, `/auto`, `/fix`, `/test`, `/review` and `/explain` (both read only), `/docs`, `/new`, `/help`. They only pick the mode and phrase the task (`src/lib/code/slash.ts`); the mode's approvals still apply.
- **Helpers (sub-agents):** with Claude and GPT, the agent can hand up to 3 questions at once to read-only helper agents (`delegate`, `src/lib/code/agent/subagent.ts`). Each lists, searches and reads files (secrets withheld) for at most 6 turns and reports back; they can't change anything. Every helper call is metered like the agent's own and counts toward the run's token budget.
- **Pull requests:** the push dialog can also open a pull request from the new branch into the default branch (title and description; nothing is merged). If GitHub refuses (the Orbis GitHub App needs "Pull requests: Read and write"), the push still stands and the dialog says why.
- **Long tasks:** when a run's history gets long, older steps are replaced by a short record of what they did (each action and whether it worked), so the agent doesn't lose track, and the prompt cache keeps working.

## Not yet

- The agent doesn't deploy. Orbis has no deploy integration for user projects.
- Interactive commands (that wait for keyboard input) don't work.
