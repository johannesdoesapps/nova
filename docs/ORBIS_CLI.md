# Orbis in your terminal (`orbis`)

`orbis` is the Orbis Code agent running on your own computer, in the folder you start it in. It reads and edits
your files and runs commands there; only the model calls go to your Orbis site, which chooses the model and meters
it against your plan exactly like an Orbis Code step in the browser.

It's one file with no dependencies: [`public/downloads/orbis-cli.mjs`](../public/downloads/orbis-cli.mjs)
(Node.js 20 or newer). Related: the [GitHub Action](../integrations/github-action/README.md) and the
[VS Code extension](../integrations/vscode/README.md).

## Install and sign in

```sh
curl -fsSL https://your-orbis-site/downloads/orbis-cli.mjs -o orbis && node orbis login --url https://your-orbis-site
```

Optionally make it a command: `chmod +x orbis && mv orbis ~/.local/bin/` (the file starts with
`#!/usr/bin/env node`). The file is an ES module: Node 20.19+ and 22.7+ detect that from its contents; on an older
Node 20, save it as `orbis.mjs` instead. There's no built-in default site: give `--url` (or set `ORBIS_URL`) once; it's
remembered with your sign-in.

`orbis login` opens your browser at `<site>/cli/login`. After you allow it, the page hands a session to the app
on `127.0.0.1` and you're signed in (details under [Security](#security)).

## Commands

| | |
| --- | --- |
| `orbis` | Interactive session in the current folder. |
| `orbis "<first message>"` | Interactive, starting with that message. |
| `orbis -p "<prompt>"` | One task without questions; prints the answer ([headless](#headless-and-ci)). |
| `orbis login [--url <site>]` | Sign in through the browser. |
| `orbis logout` | Sign out on this computer (the session is also revoked at Supabase). |
| `orbis token [--url <site>]` | Sign in again (a new, separate session) and print its refresh token for CI. Treat it like a password. |

### Options

| Option | |
| --- | --- |
| `--url <site>` | Your Orbis site (else `ORBIS_URL`, else the one you signed in to). `https://` required (`http://` only for localhost). |
| `--model <id>` | A model id from the site (`/model` lists them); default Auto (Orbis picks a coding model). Only models with native tool calling are offered. |
| `--permission-mode <mode>` | `default`, `acceptEdits`, `plan` or `bypass` ([modes](#permission-modes)). |
| `--allowedTools <rules>` | Extra allow rules for this run, comma- or space-separated: `"bash(npm test*),edit(src/**)"`. |
| `--disallowedTools <rules>` | Extra deny rules. A bare tool name (`web_fetch`, `bash`) also hides the tool from the model. |
| `-c`, `--continue` | Continue the latest conversation in this folder. |
| `-r`, `--resume <id>` | Continue a saved conversation. |
| `-p`, `--print` | Headless. Piped stdin is appended to the prompt. |
| `--output-format text\|json\|stream-json` | With `-p`. |
| `--max-turns <n>` | With `-p`: stop after n model turns (exit code 1). |
| `--trust-project` | Use this folder's hooks, MCP servers and allow rules without the trust prompt (for code you trust; see below). |
| `--verbose`, `-h/--help`, `-v/--version` | |

### Environment

| Variable | |
| --- | --- |
| `ORBIS_URL` | The site. |
| `ORBIS_REFRESH_TOKEN` | Sign in from a refresh token instead of `~/.orbis/credentials.json` (CI). Nothing is saved. |
| `ORBIS_REFRESH_TOKEN_OUT` | A file to write the rotated refresh token to (mode 0600), so CI can store it again. |
| `ORBIS_HOME` | Where Orbis keeps its files (default `~/.orbis`). |
| `ORBIS_INITIAL_PROMPT` | First message of an interactive session (used by the VS Code extension). |
| `NO_COLOR` | No colours. |

None of the `ORBIS_*` sign-in variables are passed to the commands, hooks or MCP servers the agent starts.

## The interactive session

Type a request and press Enter. Orbis shows each tool it uses (`● read_file src/app.ts`), asks before anything
that needs approval, and answers when it's done.

**Keys:** `Shift+Tab` cycles default → acceptEdits → plan. `Esc` (or `Ctrl+C`) interrupts the current turn: a
running command is stopped and Orbis waits for you. `Ctrl+C` twice quits. Anything you type while Orbis works is
queued and handed to it with the results of its current step (or as the next message if it has just finished).

**Approval prompt:** `1` yes · `2` yes, and always allow (writes a rule such as `bash(npm install*)` or
`edit(src/lib/**)` to `.orbis/settings.local.json`, and it applies for the rest of the session) · `3` no, and
optionally tell Orbis what to do instead (it gets your words).

| Command | |
| --- | --- |
| `/help` | Commands and keys, including your custom commands. |
| `/mode [mode]` | Show the next mode or switch to one (`bypass` asks you to confirm). |
| `/model [id\|auto]` | Show the models or choose one. |
| `/compact [focus]` | Have the model summarise the conversation and replace it with the summary (frees context). |
| `/context` | Estimated tokens for instructions, tools and conversation, against the model's context window. |
| `/clear` | Start a new conversation (the old one stays saved). |
| `/resume [id]` | Pick a saved conversation from this folder. |
| `/rewind [n]` | Go back to just before one of your messages: the conversation is cut back and **every file Orbis changed since is restored** from the session's snapshots (files it created are removed). The message is put back in the input line to edit. Changes made by commands (`bash`) aren't tracked. |
| `/cost` | Tokens used, and an estimate at the model's list price (your plan's allowance is what's charged). |
| `/init` | Have Orbis write (or improve) an `ORBIS.md` for this repository. |
| `/mcp` | MCP servers, their tools, and any that failed or weren't started. |
| `/todos` | The agent's to-do list. |
| `/exit` | Quit (the conversation is saved). |
| `/<name> [args]` | A [custom command](#custom-commands). |

**Auto-compaction:** when the conversation passes about 85% of the model's context window (or nears the
server's 1.5 MB request limit), Orbis compacts it before the next model call, keeping your latest message.

## Tools

All run on your computer, inside the project folder.

| Tool | |
| --- | --- |
| `read_file` | Text with line numbers; `offset`/`limit` (up to 2,000 lines per call). Binary files aren't shown. |
| `write_file` | Create a file, or replace one the agent has read in this session. |
| `edit_file` | One exact search/replace; the text must be unique unless `replace_all`. |
| `multi_edit` | Several edits to one file, in order, all or nothing. |
| `glob` | `**`, `*`, `?`, `{a,b}`, `[abc]`; newest first. |
| `grep` | JavaScript regular expressions; `glob`, `ignore_case`, `context`, `output_mode` (content, files, count). Skips `node_modules`, `.git`, binary files, files over 1 MB and secret files. |
| `list_dir` | A folder's entries. |
| `bash` | A shell command in the project folder (no input, its own process group). Default limit 2 minutes, at most 10; the end of the output comes back. `background: true` returns an id for `bash_output` and `kill_shell` (dev servers, watchers). |
| `todo_write` | The agent's to-do list, shown to you. |
| `web_fetch` | A public web page as text, read **by the Orbis server** with its guarded reader (public addresses only), so the agent can't be pointed at your private network. |
| `ask_user` | A question to you (in `-p` mode it's told to assume and carry on). |
| `use_skill`, `task`, `exit_plan` | [Skills](#skills), [subagents](#subagents) and plan approval. |
| `mcp__<server>__<tool>` | Tools from your [MCP servers](#mcp-servers). |

**Never read:** files that look like secrets (`.env`, `.env.*` except `.env.example`/`.sample`/`.template`,
`*.pem`, `*.key`, `id_rsa`…, `credentials.json`, `.npmrc`, `.netrc`, anything under `.ssh`, `.aws`…). They can't
be read, edited or searched, and a "safe" command naming one (`cat .env`) still needs approval.

**Inside the project only:** every path is resolved against the folder you started in, then symlinks are
followed and the real path checked, so a link pointing elsewhere is refused. Searches don't follow links into
other folders.

## Permission modes

| Mode | Reads | File edits | Commands |
| --- | --- | --- | --- |
| `default` | yes | ask | safe list runs; others ask |
| `acceptEdits` | yes | yes | safe list runs; others ask |
| `plan` | yes | refused | read-only commands only. The agent investigates and proposes a plan with `exit_plan`; when you approve it (choosing "accept edits" or "ask before edits") it can start. |
| `bypass` | yes | yes | yes, except the hard-blocked list |

**Safe list** (no prompt): read-only commands (`ls`, `cat`, `head`, `git status/diff/log/show`, `grep`, `rg`,
`find` without `-exec`/`-delete`, `--version`…) and tests/builds/linters (`npm test`, `npm run
build|lint|typecheck|test…`, `npx vitest|jest|tsc|eslint`, `pytest`, `cargo test|build|check|clippy`, `go
test|build|vet`, `make test|check|build|lint`…). A command chained with `&&`, `;`, `|` is safe only if every part
is; command substitution (`` ` ``, `$( )`) or redirection into a file always needs a look.

**Hard-blocked in every mode, whatever the rules say:** `rm -rf /` (or `~`, `$HOME`, `..`), `--no-preserve-root`,
`sudo`/`su`/`doas`, fork bombs, force-pushing to `main`/`master`, piping a download into a shell or interpreter
(`curl … | sh`), `mkfs`, `dd of=/dev/…`, `chmod -R 777 /`, `shutdown`/`reboot`.

## Settings and permission rules

Files, all optional:

- `~/.orbis/settings.json`: yours, everywhere.
- `.orbis/settings.json`: the project's (commit it).
- `.orbis/settings.local.json`: yours for this project; "always allow" writes here. **Add it to `.gitignore`.**

```json
{
  "model": "claude-sonnet-5-5",
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": ["bash(npm test*)", "bash(npm run lint*)", "edit(src/**)", "fetch(domain:docs.example.com)", "mcp(github/list_*)"],
    "deny": ["bash(git push*)", "read(secrets/**)", "edit(migrations/**)", "web_fetch"]
  },
  "hooks": {
    "PreToolUse": [{ "matcher": "bash", "command": "./scripts/check-command.sh" }],
    "PostToolUse": [{ "matcher": "edit_file|write_file|multi_edit", "command": "npx prettier --write \"$ORBIS_FILE\"" }]
  }
}
```

**Rule forms:** a tool or group name (`bash`, `edit`, `read`, `fetch`, `mcp`, or an exact tool name such as
`edit_file` or `mcp__github__create_issue`) optionally followed by a pattern in brackets:

| Rule | Matches |
| --- | --- |
| `bash(npm test*)` | Commands starting with `npm test` (`*` matches anything; `npm test:*` means the same). Each part of a chained command is checked on its own. |
| `edit(src/**)`, `read(secrets/**)` | `edit` = write_file, edit_file, multi_edit; `read` = read_file, glob, grep, list_dir. Globs over project-relative paths; a glob without `/` matches the file name anywhere. Denied reads are also left out of searches and listings. |
| `fetch(domain:example.com)`, `fetch(https://x.dev/*)` | web_fetch by host (subdomains included) or URL. |
| `mcp(server)`, `mcp(server/tool)`, `mcp(server/list_*)` | MCP tools. |

**Deny always wins**, from any file and in any mode. Order: hard blocks → deny rules → plan mode → allow rules
and the safe list → the mode → ask. In `-p` mode, "ask" means **denied**, with a message telling the model (and the
JSON output's `permission_denials`) which rule would allow it.

## Hooks

`hooks.PreToolUse` / `hooks.PostToolUse`: lists of `{ "matcher": "<regex over tool names>", "command": "…",
"timeout": <seconds, default 60> }` (the nested form `{ "matcher", "hooks": [{ "command" }] }` works too).
`matcher` is anchored (`edit_file|write_file`); `*` or empty matches every tool. Commands run in the project
folder with:

| Variable | |
| --- | --- |
| `ORBIS_TOOL` | The tool's name. |
| `ORBIS_FILE` | The absolute path for file tools (else empty). |
| `ORBIS_INPUT` | The tool's arguments as JSON. |
| `ORBIS_EVENT`, `ORBIS_PROJECT_DIR` | |

A **PreToolUse** hook that exits with **2** blocks the tool; its stderr is what the model is told. Other exit
codes don't block. **PostToolUse** output (and non-zero exit codes) is appended to the tool's result.

## Folder trust

A repository's own `.orbis/settings.json`, `.orbis/settings.local.json` and `.orbis/mcp.json` can run commands
(hooks, MCP servers) and loosen permissions (allow rules, `defaultMode`). Orbis applies those only after you
trust the folder: the first time it sees them it asks, and stores the folder with a hash of those files in
`~/.orbis/trust.json`. When any of them changes, it asks again. Until then (and in `-p` runs without
`--trust-project`) they're off, except **deny rules, which always apply**. Your own `~/.orbis` settings,
hooks and servers always apply. `ORBIS.md`, custom commands, skills and agents from the repository only add text
for the model, so they load without trust.

## Project instructions

The system prompt includes `ORBIS.md` from the project root (or, if there's none, `AGENTS.md`, else `CLAUDE.md`)
and `~/.orbis/ORBIS.md`, each up to 40,000 characters. `/init` writes an `ORBIS.md` for you.

## Custom commands

`.orbis/commands/<name>.md` (project) and `~/.orbis/commands/<name>.md` (yours; the project's wins on a clash):

```markdown
---
description: Fix a GitHub issue
---
Read issue #$ARGUMENTS with `gh issue view $ARGUMENTS`, fix it, add a test, and run the tests.
```

`/fix-issue 42` sends the body with `$ARGUMENTS` replaced (without `$ARGUMENTS`, the arguments are added at the
end).

## Skills

`.orbis/skills/<folder>/SKILL.md` and `~/.orbis/skills/<folder>/SKILL.md`, with `name` and `description` in the
frontmatter. The model sees the list of names and descriptions and calls `use_skill` to load one's instructions
(and is told the skill's folder, so it can read files kept next to it).

## Subagents

`.orbis/agents/<name>.md` and `~/.orbis/agents/<name>.md`:

```markdown
---
name: auditor
description: Looks for security problems in a change
tools: read_file, grep, glob
---
You review code for injection, auth and secrets mistakes. Report file:line and why.
```

The `task` tool runs a helper with its own short conversation (up to 12 model turns), that prompt, and only
read-only tools (`read_file`, `glob`, `grep`, `list_dir`; anything else in `tools` is ignored). Its final answer
is the tool's result. Without an agent name, a general read-only helper is used. Helpers can't start helpers.

## MCP servers

`~/.orbis/mcp.json` and `.orbis/mcp.json` (the project's only in a trusted folder):

```json
{
  "servers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "…" } },
    "docs": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer …" } }
  }
}
```

`command` servers are started as local programs speaking JSON-RPC over stdio; `url` servers use streamable HTTP
(JSON or event-stream answers; the `Mcp-Session-Id` is kept). Orbis runs `initialize`, `tools/list` and
`tools/call`, and offers each tool as `mcp__<server>__<tool>`. Every call goes through the permission check (rule
form `mcp(server/tool)`); in `default` and `acceptEdits` mode that means a prompt unless a rule allows it. A
server that fails to start is reported and skipped. At most 64 tools in total are offered to the model.

## Sessions

Each conversation is saved to `~/.orbis/sessions/<id>.json` (mode 0600): the folder, the messages, the to-do
list, token usage, and for each of your messages the content of every file the agent changed in that turn,
before and after (files over 1 MB aren't kept). That's what `/rewind` restores from and what the VS Code
extension's "Review last changes" shows. `orbis --continue` resumes the latest for the current folder;
`orbis --resume <id>` (or `/resume`) a specific one. Delete the folder to remove them.

## Headless and CI

```sh
orbis -p "Why does the build fail?" < build.log
orbis -p "Fix the lint errors" --permission-mode acceptEdits --allowedTools "bash(npm run lint*)" --output-format json
```

- Nothing is asked: what would need approval is denied (see the rules above). `ask_user` gets "assume and carry
  on"; `exit_plan` can't be approved, so in `plan` mode the plan is the answer.
- `--output-format text` prints the answer (errors to stderr). `json` prints one object:
  `{ "type": "result", "subtype": "success" | "error" | "error_max_turns" | "error_refusal" | "error_interrupted",
  "is_error", "result", "error"?, "session_id", "num_turns", "duration_ms", "model", "usage",
  "permission_denials": [{ "tool", "subject", "reason" }] }`. `stream-json` prints one JSON object per line: `system`
  (init), `assistant`, `tool_use`, `tool_result`, `todos`, then the `result`.
- Exit codes: 0 success; 1 an error, a refusal, an interrupt or `--max-turns` reached; 2 bad usage.
- Sign-in: `ORBIS_URL` and `ORBIS_REFRESH_TOKEN` (from `orbis token`).

**Refresh tokens rotate.** Orbis signs in with Supabase Auth, which gives out a new refresh token every time one
is used and retires the old one. A token stored as a CI secret therefore works for one run. Set
`ORBIS_REFRESH_TOKEN_OUT=<file>` and store the file's content back into the secret after each run (the GitHub
Action does this when given `secret-update-token`), and never run two jobs with the same token at once. If a run
says "Your sign-in has expired or was revoked", make a new one with `orbis token`.

## GitHub Action and VS Code

- [`integrations/github-action`](../integrations/github-action/README.md): a composite action that downloads the
  app from your site, runs `orbis -p` on the checked-out repository and comments the answer; plus an example
  workflow for `@orbis …` comments from people with write access.
- [`integrations/vscode`](../integrations/vscode/README.md): "Orbis: Open in terminal", "Orbis: Ask about
  selection" and "Orbis: Review last changes" (diffs from the session snapshots). Package with
  `npx @vscode/vsce package`.

## Security

**What runs where.** The agent loop, every tool, hooks and MCP servers run on your computer with your user's
permissions. The Orbis server only receives the model request (system prompt, conversation including file
contents and command output the agent read, tool definitions) and `web_fetch` addresses, and returns the model's
reply. Turns are metered and recorded like Orbis Code's, with your account's row-level security; Orbis Bastion's
suspension of the coding agent applies here too.

**Prompt injection.** Files, command output and web pages can contain instructions aimed at the agent. It's told
to treat them as data, but the real protection is the permission system: keep `default` or `acceptEdits` for
code you didn't write, keep deny rules for what must never happen, and use `bypass` only in a throwaway
environment.

**Sign-in.** `orbis login` starts a one-shot server on `127.0.0.1` on a random port and opens
`<site>/cli/login?port=…&state=…` (a fresh 32-character random `state`). The page requires you to be signed in to
the site, only accepts a port from 1024 to 65535 and a URL-safe state, and asks before doing anything. On
**Allow** it asks the site for a new session just for the terminal app (so the app refreshing its own tokens
never uses up your browser's; sites without a service role key hand over the browser's current session instead)
and redirects to `http://127.0.0.1:<port>/callback#access_token=…&refresh_token=…&state=…`. The tokens are in the
fragment, which browsers never send to a server, so they don't appear in any log. A small page served by the app
reads the fragment and posts it back to the app, which accepts it only with the same `state` (compared in constant
time), the right `Host` and `Origin`, then closes. Tokens are saved in `~/.orbis/credentials.json` with mode 0600;
the app refreshes them itself through Supabase (`/auth/v1/token?grant_type=refresh_token` with the site's
publishable key from `/api/cli/config`). `orbis logout` revokes the session and deletes the file.

**Server endpoints** (all under `/api/cli`): `GET config` (public: the Supabase URL and publishable key that are
already in every page, the tool-calling models, the app's version); `POST turn` (bearer access token, validated
with Supabase; 1.5 MB body limit, at most 64 tools; rate limited per user; metered); `POST fetch` (bearer token;
the guarded link reader; rate limited); `POST session` (the `/cli/login` page only, with the browser's cookies;
the proxy refuses cross-site posts).
