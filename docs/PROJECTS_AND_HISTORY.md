# Projects, task history and continuing work

What Orbis keeps, where it's kept, who can see it, and how earlier work is picked up again.

## What is persisted (and was before this change)

| Kind | Tables | What's kept |
|---|---|---|
| Code projects | `code_projects`, `code_files` | Name, **description** (new), template, Run command, source repository, and the project's files themselves. The files are the source of truth: a project computer (Vercel Sandbox) gets a copy while it runs and changed files are copied back. The computer itself is temporary. |
| Coding tasks (agent runs) | `code_agent_runs` | The request, status, plan, the agent's summary, error, steps, usage and cost, the final report (checks and outcome), and the agent's trimmed working memory (transcript). |
| Task activity | `code_agent_events` | The append-only activity log (each step, command, check). |
| File changes | `code_agent_changes`, `code_agent_checkpoints` | Each file's content before and after a task, and checkpoints — so every task's changes can be reviewed as diffs and undone (with conflict detection when a file changed since). |
| Conversations | `conversations`, `messages`, `projects` | Chats and their messages; chat projects/missions with descriptions, goals and tasks. |

Ownership: every table above has row-level security limiting rows to `user_id = auth.uid()`, and inserts must reference the user's own project. The API also filters by the signed-in user. Deleting a code project deletes its files, tasks, activity, changes, checkpoints and attachments (cascade). Usage and billing records (`model_runs`, ledgers) are kept for accounting and don't contain task text.

## What this change adds

- **Migration `20261101000000_project_descriptions_task_history.sql`** (additive): `code_projects.description` (≤ 500 characters, owner-editable), and an index `code_agent_runs (user_id, updated_at desc)` for listing a user's tasks.
- **History → Coding tasks** (`/history?tab=tasks`, optionally `&project=<id>`): every coding task across the user's projects with its project, outcome in words (Done and verified, Done – checked in a browser, With warnings, Not verified, Failed, Stopped, Working, Waiting for you), last activity, model, files changed and cost. Search (request and the agent's summary), filter by outcome and project, sort by last activity / newest / oldest, "Show more" paging. API: `GET /api/code/tasks`.
- **Resume / Continue**:
  - An **open** task (working or waiting) is **resumed**: `/code/<project>?run=<id>` opens it where it stopped. If a step was interrupted, the agent is told which actions may or may not have run and checks before doing anything again — nothing is replayed.
  - A **finished** task can't be reopened (its working memory is closed). **Continue** opens a new task in the same project (`/code/<project>?continue=<id>`); the server checks the earlier task is the user's, in that project and finished, and gives the agent its request, summary, changed files and check results. Its tool calls are not carried over or repeated. If it was deleted meanwhile, the agent is told and works from the files as they are.
  - One open task per project still applies (a second start, from another tab or a double click, is refused).
- **Deleting a task's record** (History → ⋯ → Delete task record): only finished tasks not held by a step or re-check. Removes the activity log, change records, checkpoints and attachments; the project's files stay as they are, so that task's changes can no longer be undone afterwards (the confirmation says so). API: `DELETE /api/code/agent/<id>`.
- **Projects page**: code projects show their description, their latest task and its outcome, and an "Unfinished" marker when that task is still open; a link to Task history. The project menu in Code has "Add/Edit description" and "Task history".

## Not supported (on purpose)

- Reopening a finished task's own conversation with the agent: its working memory is trimmed and closed; Continue starts a new task with its record instead.
- Replaying earlier commands or edits.
- History of conversations' individual model runs (chats are listed under Conversations as before).
- A persistent computer: projects keep files, not running processes or installed packages; the computer is set up again when needed.
- Automatic retention limits: tasks are kept until the user deletes them or their project.
