# Code workspace

The **Code** page (`/code`) is where people build whole projects in the browser:

- a file list and an editor with syntax highlighting (CodeMirror 6);
- a terminal that runs commands on a real Linux computer;
- a live preview of web apps;
- an AI editor that proposes file changes, shown as a diff to accept or reject;
- starting from a template or from one of their GitHub repositories.

## How it works

| Part | Where |
| --- | --- |
| Projects and files, saved in the database | `supabase/migrations/20261020020000_code_workspace.sql`, `src/lib/code/server.ts` |
| Limits, path rules and starter templates | `src/lib/code/projects.ts` |
| Workspace computer (Vercel Sandbox), commands, copying files back | `src/lib/code/workspace.ts` |
| AI editor: prompt, edit format, all-or-nothing edits | `src/lib/code/ai-edits.ts` |
| Line diff for the review screen | `src/lib/code/diff.ts` |
| APIs | `src/app/api/code/projects/**`, `src/app/api/code/import` |
| Pages | `src/app/(studio)/code`, `src/components/code/*` |

### Files

Files live in `code_files`, one row per file. Only the owner can see or change them (row-level security). The database enforces the limits, so no client can get around them:

- 300 files and 3 MB per project, 200 KB per file;
- plain relative paths only (no leading `/`, no `.` or `..` parts, no backslashes or control characters).

Users may change a project's name and Run command, never its id or owner (column grants). The editor saves each file 0.8 s after the last keystroke.

### The workspace computer

Pressing **Start**, **Run** or typing a command turns on a computer for the project. It's a Vercel Sandbox microVM: 1 vCPU, 2 GB of memory, the `vercel/sandbox/universal` image with Node.js 24 and Python 3.14.

- **Files:** the project's files are copied in when it starts. Saves from the editor are copied in as you make them.
- **Commands:** each command runs in the background with its output in a log, which the page reads as it grows. **Stop** ends the command and everything it started.
- **Copying back:** when a command ends, files it created or changed are copied back to the project. Files it deleted are removed from the project. Installed packages and build output are never copied back (`node_modules`, `.venv`, `dist`, `.next` and so on). Binary files and files over 200 KB are skipped, and the terminal says which.
  - Only files that were in the computer when the command started can be deleted from the project. A file saved from the editor in the meantime is never lost.
- **Network:** only npm and PyPI are reachable (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`), so code can install packages but can't reach anything else.
- **No secrets inside:** nothing from Orbis's environment is passed in.
- **Not persistent:** stopping the computer discards it, so there's no snapshot storage to pay for. Packages are reinstalled next time; the Node.js template's Run command does `npm install && npm start` for that reason.
- **Preview:** an app listening on port 3000 shows in the Preview panel. The address is the sandbox's public URL while the computer is on, so the page tells people not to put secrets in projects.
- **One computer at a time:** starting a computer for one project stops the user's other ones.

### Time and allowances

Computer time is counted in **blocks** (10 minutes by default). **Start** reserves one block. **+10 min** adds another block to the running computer, which stops when its blocks run out.

Blocks are written only by the database function `code_workspace_reserve`. Users can read their own blocks but can't insert, change or delete them, so what someone has used can't be lowered from the browser. The function checks, one request at a time:

- the user's minutes this billing period;
- the site's minutes this calendar month;
- how many computers are running at once, site-wide.

The API starts the computer first and then reserves its block. If the reserve is refused (for example, a second tab started a computer at the same moment), the new computer is stopped at once. The computer's name comes from its first block's id, which only the API knows. The API never uses a computer in its last 10 seconds, and never resumes a stopped one, so no time runs that wasn't reserved.

Each block is also recorded in `model_runs` (`tools = {code_workspace}`, `units = 0`, its worst-case cost) so the Finance pages show workspace costs. Admin → Plans changes everything below.

| | Free | Pro ($20) | Max ($100) |
| --- | --- | --- | --- |
| Projects | 3 | 25 | 100 |
| Computer minutes / month | 20 | 200 | 1,000 |

Site-wide settings:

- **Block:** 10 minutes.
- **Monthly minutes, whole site:** 3,000.
- **Computers running at once:** 6. Vercel Hobby allows 10 sandboxes at a time, shared with code runs and Workforce.

### Cost and margin

Prices are from https://vercel.com/docs/sandbox/pricing, checked 2026-10-20:

- $0.128 per active CPU hour;
- $0.0212 per GB-hour of memory;
- $0.15 per GB of data transfer;
- $0.60 per million sandbox creations;
- snapshot storage is $0.08 per GB-month, but workspaces aren't persistent, so they don't use it.

A minute is costed as if the CPU were busy the whole time, plus 2 MB of preview traffic. That comes to at most **$0.00314 a minute** (`workspaceMinuteCostUsd`).

Each plan's minutes are set aside at that worst case before its AI budget is worked out (`planEconomics` → `workspaceUsd`), as with code runs. The contribution margin therefore stays at or above 60% even if every minute is used:

| | Workspace, worst case / month | AI budget / month, before → after |
| --- | --- | --- |
| Pro | $0.63 | $4.12 → **$3.59** |
| Max | $3.14 | $26.74 → **$24.07** |

**This lowers each paid plan's AI budget**, so Pro users get about 13% fewer messages on budget-limited models and Max users about 10% fewer. The owner needs to approve this. The alternatives are:

- fewer workspace minutes (Admin → Plans);
- a higher price.

In practice a workspace's CPU is idle most of the time, so the real cost is far below the worst case.

### Coding agent

The **Agent** panel plans, edits, runs tests and fixes failures, with approvals along the way. See docs/CODE_AGENT.md.

The **Changes** panel lists every agent run with per-file diffs. A whole run or a single file can be reverted from there, and the project can be pushed to a new GitHub branch.

### Layout

- **Start screen** (`/code`): what Code does, the three steps (choose a project, describe the task, review the result), recent projects to continue, and three ways to start: **Try an example** (an ordinary Node.js project with a calculator whose tests fail, with the task filled in), **Import from GitHub**, or **New project** from a template. `/code?new=1` opens the template form.
- **Workspace** (`/code/[id]`): the coding agent is the main view. On the left, **Files** (with search) and **Sessions** (each task given to the agent; open one to see its progress and report, or start a new one). On the right, an optional panel opens on demand: **Editor**, **Changes** (diffs, checkpoints, undo, push to GitHub), **Preview**, **Terminal** and **Quick edit** (advanced). Panels resize by dragging or with the arrow keys on the handles; sizes are remembered in the browser.
- **Phones** show one pane at a time with tabs, starting on the agent, which stays mounted so a session keeps going while you look at files.
- The app sidebar shows the user's projects instead of chats while in Code.

### Quick edit (AI editor)

`POST /api/code/projects/[id]/ai` sends the request and as many of the project's files as fit to the model. The files sent are chosen in this order:

1. the open file;
2. files named in the request;
3. smaller files first.

The budget is the plan's history size. The model is Auto (Coding) or the one picked, limited to the plan's model tiers. The model answers in JSON with `replace`, `write` and `delete` edits.

The edits are applied to a copy, all or nothing. A `replace` must match exactly once, and paths must be plain, outside `node_modules` and `.git`. The proposed changes come back with before and after text. Nothing is saved until the user accepts, and they can accept only some files. If a file changed after they asked, the diff says so.

Each request is reserved, charged and recorded like a chat message (purpose `code_ai`).

### GitHub import

`POST /api/code/import` creates a project from one of the user's repositories, through the GitHub App connection in docs/GITHUB.md:

- it uses the default branch;
- it imports text files up to 100 KB;
- it stays within the project limits.

## Not yet

- **Save back to GitHub:** *Push to GitHub* (a new branch per push) exists, but it needs the GitHub App configured with *Contents: Read and write* permission.
- **Interactive programs:** commands get no keyboard input, so programs that ask questions won't work.
- **Persistent computers that keep installed packages:** this needs snapshot storage, at $0.08 per GB-month.
- **Several people editing one project at once.**
