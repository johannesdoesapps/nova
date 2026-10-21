# Orbis Code — building websites from a prompt

A user describes a website in plain English; Orbis's coding agent builds it in a project, runs it on the project's private computer, checks it in a real browser at desktop and phone sizes, fixes what it finds, and shows the live result. Follow-up requests change the same site.

Related: [ORBIS_CODE_ARCHITECTURE.md](ORBIS_CODE_ARCHITECTURE.md) (the agent runtime), [ORBIS_CODE_SECURITY.md](ORBIS_CODE_SECURITY.md), [CODE_WORKSPACE.md](CODE_WORKSPACE.md) (projects and computers), [ORBIS_CODE_QA_REPORT.md](ORBIS_CODE_QA_REPORT.md) (results).

## 1. Why website requests failed before (root cause)

Traced live on 21 October 2026 with the Nova landing-page prompt on a new website project (run `c9f84e29…`):

1. **Every step could only write as much as a chat reply.** The agent's per-step output limit was the plan's chat reply limit (1,200 / 2,400 / 4,800 tokens). The first attempt to write the page was cut off ("reply was cut off at the output limit"), so the agent had to build the page in fragments with `edit_file`.
2. **Large edits broke the run for good.** The repeat detector stored each step's actions — including whole file contents — in `code_agent_runs.recent`, which the database limits to 4,000 bytes. As soon as the agent wrote a real-sized file, saving the step violated that check (Postgres 23514), surfaced as "That file name or size isn't allowed", and every retry failed the same way: the run was stuck after 4 steps with a half-written page.
3. **The agent couldn't start or see a website.** `run_command` waits for a command to finish (2 minutes, then kills it), so a server could not be started; the prompt told the agent to ask the user to press Run. There was no way to load the result, so nothing could be verified and the report could only say "Not verified: no tests ran".

## 2. What was changed

| Area | Change | Files |
|---|---|---|
| Output room | Agent steps get 16,000 output tokens (or the plan's reply limit when higher). Spending still goes through the plan's allowance and the per-request cost cap like any model call. Model call timeout 170 s. | `src/lib/code/agent/engine.ts` |
| Stuck runs | The repeat detector stores a 22-character hash per step. Regression test against the real migration. | `engine.ts`, `tests/code-agent-db.test.ts` |
| Memory | File contents the agent already wrote are left out of later turns (the files are saved; it can read them). | `src/lib/code/agent/protocol.ts` (`compactCalls`) |
| Preview server | New tool **`start_preview`**: starts the site's server as the project's preview job on port 3000 (replacing a running one), waits until the port answers, the process exits, or 90 s pass; reports the real state and the server's output; notices a server on the wrong port. A new server command becomes the project's Run command. | `src/lib/code/preview.ts`, `src/lib/code/agent/tools.ts`, `tool-specs.ts` |
| Browser check | New tool **`check_preview`**: loads the running site in headless Chromium inside the project's computer at 1280×800 and 390×844 and reports HTTP status, JavaScript and console errors, failed loads, sideways scrolling (and the elements causing it), in-page links without a target, links to missing pages, placeholder links, images without alt text or that don't load, forms, and whether the phone menu opens; plus screenshots. The model sees the screenshots with the results on its next turn (Claude: inside the tool result; GPT: as a following image message). | `src/lib/code/preview-check.ts`, `preview.ts`, `tools.ts`, `protocol.ts`, AI providers |
| Guidance | Website tasks (by request wording, or a project with `index.html` / a front-end framework / the website template) get website guidance: pick the stack from the project, never replace an existing project or switch its stack without asking, complete files per step, a coherent design system, accessibility, no fake functionality, honest forms, labelled sample content, no external image hosts, verify with the preview tools, run the build. | `protocol.ts` (`isWebTask`, `webGuidance`), the agent route |
| Policy | `run_command` refuses server commands (use `start_preview`). `start_preview` runs recognised server commands (static servers, `npm run dev/start/preview`, `npx vite`, `node server.js`, uvicorn/flask…) after installs/builds without asking; anything else needs the user's approval; the never-run list still applies. | `src/lib/code/agent/policy.ts` |
| Records | The server, the latest browser check and the latest production build are recorded separately on the run (new `checks` column) and reported with freshness (current, or stale when files changed after). | migration `20261022040000_code_agent_checks.sql`, `report.ts`, `types.ts`, `runs.ts` |
| Follow-ups | A new session in a project starts with the last three finished sessions' requests, summaries and changed files, so "make it blue" doesn't need the site explained again. | `engine.ts`, `protocol.ts` (`initialMessage`) |
| Start screen | "Build a website": a prompt box ("Describe the website you want to build…"), five example prompts, a project choice (new website project or an existing project), and Build website. | `src/components/code/projects-view.tsx` |
| Workspace | Build website starts the agent at once (working on its own) and starts the computer when it asks. The preview opens beside the agent when the agent starts it and reloads as the site changes; Run uses the same preview job; the preview shows whether the site actually answers. After a session, "Ask for changes to the site" (with website examples) starts the next one in the same mode and model. | `workspace.tsx`, `agent-panel.tsx`, `api.ts` |
| Report | Separate lines: development server, checked in a browser, production build, tests — each as it really ended; screenshots and the full check report under Details; Open preview. | `agent-panel.tsx` |
| APIs | `POST /api/code/projects/[id]/exec` takes `preview: true` (the project's server job); `GET /api/code/projects/[id]/preview` asks the computer whether the site answers. | `src/app/api/code/projects/[id]/…` |

## 3. The workflow

1. **Start**: Code → Build a website → describe it → Build website. A new project is created from the website template (named from the request, e.g. "Website: Nova"), or the chosen existing project is used. The request is handed to the project page (session storage, not the URL).
2. **Understand and inspect**: the run starts with the request, the file list, key files and earlier sessions; the agent reads the project.
3. **Decide**: in an empty or template project it builds a static site (HTML, CSS, JavaScript) served by `python3 -m http.server 3000`; in a project with a framework it works inside it. It asks before replacing a project or switching its stack.
4. **Build**: complete files, one per write; design system, sections, interactions, forms with validation and an honest note when there's no backend; sample content labelled.
5. **Run**: `start_preview` — the server starts in the background; Orbis waits until port 3000 answers (or reports that it exited, with its output, or that something listens on another port).
6. **Look**: `check_preview` — a real browser at desktop and phone sizes; problems and screenshots go back to the agent and into the activity log.
7. **Fix and re-check** until the check passes or the agent explains what it couldn't fix; it runs `npm run build` when the project has one.
8. **Report**: what the agent says it built (labelled as its words), files changed, and each check as it ended: server running, browser check (current or stale), production build (passed, failed, or not run), tests.
9. **Change it**: ask for changes; the agent edits the existing files, the preview reloads, and the checks run again. Every session's changes can be reviewed as diffs and undone.

## 4. Preview and execution architecture

- **Where code runs**: one Vercel Sandbox microVM per project session (1 vCPU, 2 GB), created by the Orbis server with the user's session — never on Orbis's own servers. Nothing from Orbis's environment (keys, database credentials) is passed in. Network: npm and PyPI only. It stops when its time block ends; workspace minutes come from the user's plan.
- **The preview server** is a background job with a fixed id (`orbispreview`) in its own process group, so starting it again (from the agent or the Run button) stops the old one and anything else holding port 3000 first. Its output is the job log (readable in the terminal).
- **Readiness** is measured, not assumed: `curl` from inside the computer to `127.0.0.1:3000`, the job's exit file, and the listening ports (`ss`, falling back to `lsof`).
- **The browser** is headless Chromium from npm (`@sparticuz/chromium` 131.0.1, a Chromium build that carries its own system libraries, and `puppeteer-core` 23.11.1), installed on first use into `/tmp/orbis-tools` — outside the project, so it's never copied back or shown as a change — in about 8–15 seconds, then reused for the session. Requests to other sites (web fonts, CDNs) fail inside the computer by design; the check lists them as "not checked" instead of failing the site.
- **What the user sees**: the preview panel loads the sandbox's public address for port 3000 in an iframe (scripts allowed, isolated from Orbis by being on a different origin), with reload and open-in-new-tab. It is not proxied through tryorbis.app on purpose: a proxied preview would run the generated site's scripts on Orbis's own origin, next to the user's session.
- **Exposure**: only port 3000 is exposed, at an unguessable address that exists while the computer is on; the address is shown only to the project's owner (the session API checks ownership). The workspace warns not to put secrets in a project.

## 5. Safety

Unchanged from the agent (see ORBIS_CODE_SECURITY.md) and applied to the new tools: project-relative paths only; `.env`-style files never sent to the model; commands checked against the never-run list (deleting the project or system, sudo, publishing, deploying, `git push`, piping downloads into a shell…); `start_preview` asks before any server command it doesn't recognise; read-only sessions can't start or check previews; Stop is re-checked before any action that runs something; per-run step, token, time and failed-test limits; every change recorded and revertible.

## 6. Configuration

No new environment variables or secrets. It uses what Code already needs: Vercel Sandbox access (OIDC on Vercel, or `ORBIS_SANDBOX_*` locally) and an Anthropic or OpenAI key for native tool calling. The database migration `20261022040000_code_agent_checks.sql` (one additive column) is applied to production.

## 7. Limitations

- **Runs need an open page.** The agent advances while the project page asks for steps (no background worker).
- **External resources aren't checked** (web fonts, CDNs, external images): the computer can only reach npm and PyPI.
- **No reference images yet**: the Build box takes text only.
- **Forms don't send anywhere** unless the user connects a backend; the agent says so on the page and in its summary.
- **Static sites have no production build step**; the report says "Production build: Not run". Projects with a build script are built and the result is reported.
- **Model quality varies**: Auto uses Claude Haiku 5.5 for coding on most plans; larger models (Pro and Max) produce more polished designs. The checks report problems; they don't judge taste.
- **Plan allowances apply**: a full site takes roughly 10–20 agent steps (each counts like one message) plus workspace minutes. The Free plan's allowance may run out before a large site is finished.
- **Preview address is public while the computer is on** (unguessable, owner-only in the UI).

## 8. How to verify it in the running app

1. Sign in on https://tryorbis.app → Code.
2. In **Build a website**, paste the Nova prompt (or pick an example) → **Build website**.
3. Watch the stages: Exploring → Editing files → Checking the site in a browser. Open **Details** on the browser-check stage to see the problems found and the screenshots.
4. The **Preview** panel opens beside the agent with the running site; resize it or use open-in-new-tab to try it on a phone.
5. When it's done, read the report's **Website checks**; then type a change in **Ask for changes to the site** (e.g. "Make the navigation sticky") and watch the preview update.
6. **Review changes** shows every file's diff; **Undo all changes** puts the files back.
