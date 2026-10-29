# Orbis Code: sessions, permissions, project config, MCP, parallel copies

What Orbis Code can now do. These are terminal-agent-style features, built for Orbis (original code). The terminal
app, GitHub Action and VS Code extension are covered in [ORBIS_CLI.md](ORBIS_CLI.md).

## Sessions that keep going

A coding session keeps its conversation across messages.

- **Message while it works.** Enter sends your message to the agent. It waits in the session's inbox
  (`code_agent_runs.inbox`) and is given to the agent before its next turn, so you can steer it mid-task. The box
  shows what's waiting. **Esc** stops the agent, unless a menu or dialog is open.
- **Carry on a finished session.** A message after the agent finishes reopens the same session with the
  conversation intact, and adds room for more steps, tokens and time. A new session starts only for `/new`, for
  messages with attachments, and for pair sessions or agents' own tasks.
- **Rewind** (`/rewind`). Before each of your messages Orbis saves a rewind point: the conversation's length, and the
  content of the files the session had changed. Rewinding cuts the conversation there and puts those files back.
  Files someone else changed since come back as a list to confirm. Your message returns to the box so you can edit it.
- **Fork** (`/fork <message>`, or *Fork from here* in Rewind). This starts a new session with a copy of the
  conversation. Files aren't copied: they belong to the project.
- **Context.** The usage line shows how full the agent's context was at its last step, and `/context` explains it.
  At 90% the conversation is summarised automatically. `/compact [what to keep]` summarises it now. This is one
  metered model call, and the first message is kept with the summary added.
- **Mode and model between messages.** Changing the mode while a session runs applies from its next step
  (`POST /api/code/agent/[runId]/mode`).

## Permission modes and rules

| Mode | Plan first | Edits | Commands |
|---|---|---|---|
| Ask first | yes | saved | safe list runs, others ask |
| Review every change | yes | reviewed | every command asks |
| **Accept edits** (new) | no | saved | every command asks |
| Work on its own | no | saved | safe list runs, others ask |
| **Full auto** (new) | no | saved | everything runs except the never-run list |
| Read-only | — | refused | refused |

The never-run list (deleting the project, sudo, publishing, deploying, `git push`, piping downloads into a shell)
and Orbis Bastion apply in every mode.

**Rules** sit in the gear under the box (Agent settings), or come from *Always allow* on an approval card:

- `bash(npm test*)` covers commands. For a chained command, every part must be allowed.
- `edit(src/**)` covers files the agent changes. An allowed path skips review in *Review every change*.
- `read(secrets/**)` keeps those files from the AI.
- `mcp(server/tool)` or `mcp(server/*)` covers MCP tools.
- `web(docs.example.com)` covers sites.
- A bare kind (`bash`) covers everything of that kind. **A matching deny rule always wins.** Rules are stored per
  project in `code_projects.agent_settings`.

## The project's own config

| File | What it does |
|---|---|
| `ORBIS.md` (or `.orbis/ORBIS.md`; falls back to `AGENTS.md` / `CLAUDE.md`) | Given to the agent at the start of every session (first 12,000 characters). `ORBIS.md` files in sub-folders are listed so the agent reads them there. `/init` writes one. |
| `.orbis/commands/<name>.md` | Your own slash command. Frontmatter `description:` and `argument-hint:`. `$ARGUMENTS` (or `$1`…`$9`) is what you type after it. One folder down becomes `/folder:name`. |
| `.orbis/skills/<name>/SKILL.md` | A skill. The agent sees its name and description, and loads it with `use_skill` when a task needs it. Other files in the folder are listed for it. |
| `.orbis/agents/<name>.md` | A helper agent. `delegate` with `agent: "<name>"` answers with its instructions (read-only, like all helpers). |
| `.orbis/settings.json` | `permissions.allow` / `permissions.deny`, `hooks.PreToolUse` / `hooks.PostToolUse`, and `mcpServers`. |

**`.orbis/settings.json` does nothing until you trust it.** A project can come from anyone's repository, and hooks run
commands. Agent settings shows what the file asks for, and *Trust this version* stores its SHA-256. Any change to the
file means trusting it again, whether it comes from the agent, an import or an edit.

Example:

```json
{
  "permissions": { "allow": ["bash(npm run lint*)"], "deny": ["edit(migrations/**)"] },
  "hooks": {
    "PreToolUse": [{ "matcher": "write_file|edit_file|multi_edit", "command": "node scripts/check-path.js" }],
    "PostToolUse": [{ "matcher": "write_file|edit_file|multi_edit", "command": "npx prettier --write \"$ORBIS_FILE\"" }]
  },
  "mcpServers": { "docs": { "url": "https://mcp.example.com/docs" } }
}
```

**Hooks:**

- They run in the project's computer, and only while it's on.
- They get the environment variables `ORBIS_TOOL`, `ORBIS_FILE` and `ORBIS_INPUT` (JSON).
- They apply only to edits and commands, never to reading.
- A PreToolUse hook that exits with code **2** blocks the action, and its output is the reason the agent sees.
- What PostToolUse hooks print is added to the action's result.
- Hook commands still pass the never-run list and Bastion.

## MCP servers

Add remote MCP servers (HTTPS, Streamable HTTP) in Agent settings, with an optional token. The token is sealed with
`ORBIS_CONNECTOR_KEY` and never sent back to the page. Their tools appear to the agent as `mcp__<server>__<tool>`
(models with native tool calling).

- **When it asks.** The agent asks before each call, unless the server marks the tool read-only (`readOnlyHint`), a
  rule allows it, or the mode is Full auto. Read-only tools also work while it plans. Bastion checks every call as a
  connector read or write.
- **How Orbis connects.** Connections go only to public addresses on port 443, checked at connect time, with no
  redirects followed and size and time limits (`safePostJson`).
- **Output.** Whatever a server returns is marked untrusted when it tries to instruct the AI.
- **A broken server** is reported once and left out; it never stops the session.
- **Not supported here:** local (stdio) MCP servers can't run on Orbis's servers. The terminal app runs them on your
  computer.

## New tools

| Tool | What it does |
|---|---|
| `glob` | Finds files by pattern (`**/*.test.ts`; a pattern without a folder matches file names anywhere). |
| `multi_edit` | Several replacements in one file, applied in order. If any doesn't apply, nothing is saved. |
| `web_search` | Web search. It replaces `lookup_docs`, which older sessions can still call. |
| `run_command` with `background: true` | Starts a command and returns at once. Read it with `command_output`, end it with `stop_command`. Up to 3 at a time; all are stopped when the session ends. |
| `github_push` | Pushes the project to a new branch (one commit), optionally with a pull request. **Always waits for your approval**, never the default branch, never files that hold credentials. It goes through the same code as the Push to GitHub dialog (`src/lib/code/github-push.ts`). `/push` and `/pr` ask for it. |
| `use_skill` | Loads one of the project's skills (see above). |

## Parallel copies

`/parallel <task>`, or *Make a copy* in Agent settings, copies the project and starts the task there. Each project
still has one session working at a time, so copies are how several tasks run at once. A copy counts as a project on
the plan.

The copy remembers each file's hash. **Merge back** (the banner on a copy):

- applies what changed in the copy;
- stops at files changed in both since the copy was made, unless you choose the copy's version;
- is refused while a session is working on the original.

A later merge brings only what changed after the previous one.

## Slash commands

These are new; the existing ones are kept.

- `/init` writes `ORBIS.md`.
- `/compact [focus]`, `/context` and `/cost` cover the session's context and usage.
- `/rewind` and `/fork [message]` go back to, or branch from, an earlier message.
- `/mode plan|review|edits|auto|full|read` switches how the agent may work.
- `/permissions`, `/mcp` and `/config` open Agent settings.
- `/parallel <task>` starts a task in a parallel copy.
- `/push [branch]` and `/pr [title]` push to GitHub.
- `/clear` starts a new session.
- Your project's `.orbis/commands`.

## API

| Route | Purpose |
|---|---|
| `POST /api/code/agent/[runId]/message` `{text, options?}` | Queue a message, or reopen a finished session |
| `POST /api/code/agent/[runId]/mode` `{options}` | Change mode or model from the next step |
| `GET` / `POST /api/code/agent/[runId]/rewind` `{pointId, force?, filesOnly?}` | Rewind points / rewind |
| `POST /api/code/agent/[runId]/fork` `{text, pointId?, options?}` | Fork |
| `POST /api/code/agent/[runId]/compact` `{focus?}` | Summarise now |
| `POST /api/code/agent/[runId]/respond` | Also takes `remember: "exact" \| "prefix"` (Always allow) |
| `GET` / `PATCH /api/code/projects/[id]/agent-config` | ORBIS.md, commands, skills, helpers, settings-file state; rules, trust, MCP servers |
| `GET` / `POST /api/code/projects/[id]/copies` | List or make parallel copies |
| `POST /api/code/projects/[id]/merge` `{force?}` | Merge a copy back |

## Database

Migration `20261113000000_code_sessions_settings.sql` (additive):

- `code_agent_runs`:
  - new columns `inbox`, `forked_from` and `bg_jobs`;
  - `step_limit` may go up to 2,000;
  - `options` can be updated by the owner.
- Functions `code_agent_push_message` / `code_agent_take_messages`. These are security invoker, so row-level security
  applies. They take messages atomically and accept at most 20 waiting.
- `code_agent_checkpoints`: new columns `kind` (`manual` / `turn`), `transcript_len` and `message`.
- `code_projects`: new columns `agent_settings`, `parent_project_id`, `copy_task` and `copy_base`.

**The migration must be applied before this code is deployed.** The runs and projects queries now select the new
columns.

## Tests

- `tests/code-agent-settings.test.ts`: globs, rules, the settings-file trust gate, hooks, commands, skills, helpers,
  ORBIS.md and slash commands.
- `tests/code-agent-cc-tools.test.ts`: glob, multi_edit, rules, Full auto, background commands, hooks, MCP, github_push,
  skills and helpers, run through the real tool runner.
- `tests/mcp-and-compact.test.ts`: MCP messages and client (with a fake server), and compaction.
- `tests/code-sessions-db.test.ts`: the migration on PGlite, covering the inbox, rewind points, agent settings and
  parallel copies.

## Not done

- **Shift+Tab doesn't cycle modes in the browser.** It's the browser's "previous field" key, so taking it over would
  trap keyboard users. Use `/mode` or the mode menu. The terminal app does use Shift+Tab.
- **Rewind can't undo outside effects.** It restores files the session's tools wrote or that commands changed (those
  are recorded), but not effects outside the project, such as packages installed in the computer or MCP calls.
- **No live run yet.** None of this has been tried with a real model and a real MCP server; everything above was
  checked with tests and a production build.
