# Coding agent (Code mode)

The agent works on one Code project at a time. The user describes a change. The agent then:

1. inspects the files;
2. plans, and waits for the user to approve the plan (this is on by default);
3. edits files;
4. runs tests, builds and other commands on the project's computer;
5. fixes what fails;
6. finishes with a summary.

Every action runs for real on the server. The results the agent sees, and the page shows, are what actually happened. When something can't run, it says so: for example, when the computer is off, commands are turned off, or web search isn't set up.

Code: `src/lib/code/agent/` (`types.ts`, `policy.ts`, `protocol.ts`, `tools.ts`, `runs.ts`, `engine.ts`).
APIs: `src/app/api/code/projects/[id]/agent`, `src/app/api/code/agent/[runId]/…`.
Screens: `src/components/code/agent-panel.tsx` and `changes-panel.tsx`.

## How a run works

- **Runs** are rows in `code_agent_runs`. Each one stores:
  - the request and the user's options;
  - the plan;
  - what the run is waiting for (`pending`);
  - the agent's working memory (`transcript`, trimmed);
  - a step count and a step limit.
- **The page drives the run.** It calls `POST /api/code/agent/[runId]/step` repeatedly. So the agent works while the page is open; if the page is closed, the run pauses and shows **Continue**.
  - Each step is **one model call**, followed by the actions the model asked for.
  - Each step takes a lock (`locked_until`), so two tabs can't run the same step.
- **The model's reply format.** Every step, the model answers with one JSON object: `{"thought", "actions": [{tool, args}]}`. There are at most 8 actions per step.
- **Tools** (`tools.ts`):
  - `list_files`, `read_files`, `search_code`;
  - `write_file`, `edit_file` (exact search/replace) and `delete_file`;
  - `run_command`;
  - `lookup_docs`, only when web search is configured and the plan has searches left;
  - `github` (read files, search issues, list repos), only when the user's GitHub connection is usable;
  - `propose_plan`, `ask_user` and `finish`.
- **Pauses.** A run stops and waits for the user to approve a plan, approve a command, review edits (when that option is on), answer a question, start the computer, or allow more steps once the step limit is reached (20 by default).
  - The user answers with `POST …/respond`, using `approve`, `reject`, `answer`, `continue` or `stop`. Approving a command runs it right away.
- **Stop.** `POST …/cancel` stops the run. If a command is running, it is killed. A step that's in progress notices within seconds and ends.

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
- **Limits.** One command per step. A command is stopped after 2 minutes. Long-running servers belong to the Run button.
- **Plans first.** Until the plan is approved, edits and commands are refused.
- **Edit review (optional).** Proposed edits are shown as diffs and saved only when approved. If a file changed in the meantime, nothing is saved and the agent is told.
- **Untrusted content.** File contents, command output, web pages and repository text are given to the model as data. The system prompt tells it to ignore instructions inside them.
- **Secrets.** Before the activity log is stored, likely credentials are removed from it (API keys, bearer tokens, GitHub/Slack/AWS tokens and JWTs). The computer never holds Orbis's own secrets.
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

## Not yet

- Runs continue only while the page is open; there is no background worker.
- The agent doesn't deploy. Orbis has no deploy integration for user projects.
- Interactive commands (that wait for keyboard input) don't work.
