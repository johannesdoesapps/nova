# Orbis agent platform

How Orbis's agents fit together, what each one does, how work is routed between them, how to test them, and what isn't built. Written 24 October 2026 against the code in this repository; "live" means checked on tryorbis.app, "local" means checked against a local build with a stand-in database.

## 1. Inventory: every agent in Orbis

There are 40 agent entries in 11 systems. All of them existed before this round; none was added just to fill out the hierarchy. The catalogue (`src/lib/agent-platform/catalogue.ts`) is built from the lists each runtime already uses (the task registry, the Security Team, the Workforce and the built-in assistants), so no definition is written twice. You can browse it at **/agents/directory**.

| Level             | Entries                                                                                                                                             | Runs under                              | Defined in                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------- |
| Orchestrator      | Orbis Agent (chat), v2.0                                                                                                                            | The user, in Chat                       | `orbis-agent.ts`                   |
| Planner           | Task router and planner, v1.0 (deterministic, no model call)                                                                                        | The Orbis Agent                         | `routing.ts`                       |
| Specialists       | Software Engineer 3.2, Code Review 1.1, Bug Fixing 1.0, QA Testing 1.0, Security Team 1.0, Deep Research 1.1, Website Builder 1.2, Data Analyst 1.0 | The user, or a proposal the user starts | `registry.ts`                      |
| Sub-agents        | Security: Sentinel, Threat Hunter, Code Guardian (active); Incident Responder, Threat Intelligence (planned). Pair coding: Architect, Reviewer      | Their parent agent                      | `security/agents.ts`, `code/pair/` |
| Multi-model tools | Verify, Council, Arena, Mission planner, Connectors, Images                                                                                         | The user, from their own pages          | each feature's lib                 |
| Chat assistants   | Research, Coding, Writing, Data, Creative, General                                                                                                  | The user                                | `agents/builtins.ts`               |
| Internal          | Workforce: Commander + 8 active agents (administrators only); Optimizer and Visual planned                                                          | Administrators                          | `workforce/agents.ts`              |

Each entry records:

- its role and responsibilities, and the task types it handles;
- what's out of scope, and what to use instead;
- its tools, its input and output;
- when it stops and comes back to the user (escalation), and when it's done;
- what it depends on, its status, its version and the usage purpose its model calls are recorded under.

**Overlaps found, and how they're resolved:**

- The **Data Analyst** chat assistant and the Data Analyst task agent are the same runtime. They're one entry that points at the other, not two agents.
- The **Coding** chat assistant and the Software Engineer overlap. The assistant only explains and suggests in chat. It can't run code, and its out-of-scope list sends real changes to the Software Engineer.
- **Code Review** and the **Security Team** both do security work. Code Review checks code (rules, dependency advisories, AI). The Security Team scans websites and logs it can prove you own. The router sends "security" to Code Review for code and to the Security Team for a website, URL or logs.
- **Workforce Sentinel** and **Security Team Sentinel** share a name but are separate. The Workforce is administrators-only and reviews Orbis's own changes.

**Fixed during the audit:**

- Direct API routes (Code Review, Deep Research, the four Security Team routes, and starting a Software Engineer task) didn't apply the plan and configuration check that the agent pages use. They now call `assertAgentAccess`, so a page, a proposal or a direct request all get the same answer.
- Pair coding recorded its usage as `code_agent`. It now records `pair_coding`, so its cost is measured separately.
- The usage labels showed Workforce purposes as "Security team"; they're now labelled correctly.
- The comment on the chat assistants' `modelPreference` claimed it chose the model. It doesn't, and the comment now says so. The behaviour is unchanged, to avoid quietly raising costs.

## 2. Roles and boundaries

`registry.ts` gives every specialist one job (`ROLES`):

- `taskTypes`: the work it takes.
- `outOfScope`: what it refuses, each with `useInstead`.
- `input` and `output`.
- `escalation`: it stops and asks when information is missing, an approval is needed, a limit is reached, or the work is outside its role.
- `doneWhen`: the completion criteria, checked against records, not the agent's own words.
- `handsOffTo` and a version.

Coding agents share `CODE_ESCALATION`. They stop and ask for plan approval and for commands outside the safe list. They ask when they need information only the user has. They stop at the step, token, time or failed-test limit, and after the same failure three times they explain instead of retrying.

Permissions are declared in the registry and enforced by the runtime, not by the prompt:

| Agent                                                   | Declared               | Enforced by                                                                                                                                        |
| ------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| QA Testing                                              | `edit_tests_only`      | The tool runner refuses edits outside test files, helpers and test configuration (`qaMayEdit`); files a command changes outside tests are put back |
| Code Review, Deep Research, Security Team, Data Analyst | Read only              | They have no edit or command tools                                                                                                                 |
| Every coding agent                                      | Commands               | The command policy (safe list, ask, never)                                                                                                         |
| Every agent                                             | Plan and configuration | `assertAgentAccess` on every start, whoever starts it                                                                                              |

Delegation never widens permissions:

- a proposal from the Orbis Agent is started by the user, through the same access check;
- a workflow step starts through the same `startProfileTask` path as the agent's own page;
- agents can't start other agents (a test checks that no runtime does).

## 3. Routing and planning

`routing.ts` reads the request with fixed patterns, with no model call, so it's free and predictable. It returns one of four modes:

| Mode       | When                                                                                              | What the Orbis Agent does                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `direct`   | A question, an explanation, writing                                                               | Answers itself. No agent and no extra cost.                                                                                              |
| `delegate` | One specialist's work                                                                             | Proposes that agent as a card the user starts                                                                                            |
| `plan`     | Several kinds of work ("fix it, add tests and review it")                                         | Gives the steps in order: who does each, what it waits for, what runs alongside. Matches the Fix and verify workflow when the steps fit. |
| `gap`      | Nothing in Orbis can do it (deploying, managing infrastructure, purchases, scheduled automations) | Says so plainly, and still offers any part that can be done                                                                              |

Planning rules:

- one step per agent;
- tests and review wait for the step that builds or fixes;
- research comes before building;
- two steps that change the same project never run at the same time;
- steps that only read can run alongside each other.

An agent that isn't available to this user (plan, setup or pause) is never proposed; the reason is given instead.

## 4. The task protocol

`protocol.ts` describes every task the same way, whichever runtime does it:

- **`TaskAssignment`** contains:
  - the agent and its version;
  - the objective (the user's words, clipped);
  - its scope (the agent's role) and project;
  - the inputs, which are data, not instructions;
  - the constraints (approvals and out of scope);
  - dependencies, expected output, done-when and the runtime's limits.

  A delegated task's assignment is stored on its proposal. Only what the task needs is passed on, never the whole conversation.

- **`TaskResult`** contains a summary, artifacts, evidence, errors, unresolved items and a next step. It's built from the task's own records (`resultFromActivity`), never from what the agent says about itself.
- **States:** pending, ready, running, waiting for an earlier step, waiting for you, completed, failed and cancelled. Workflow steps and Activity entries map onto these.

## 5. Coding-engine agents

All run on the Orbis Code engine. They share its isolated computer, limits (steps, tokens, time, failed test runs), approvals, checkpoints, revert and records.

| Agent             | Workspace         | What's different                                                                                                                                                                                                | How it's enforced                                                                                                                         |
| ----------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Software Engineer | /code             | —                                                                                                                                                                                                               | —                                                                                                                                         |
| Bug Fixing        | /agents/bug-fixer | Bug form (summary, details, logs, how to reproduce, expected). Logs are fenced as data and long ones clipped (first 2,000 + last 3,000 characters). Instructions: reproduce first, root cause, regression test. | The report's "Before the fix" section is built from what ran before the first edit, not from the agent's words.                           |
| QA Testing        | /agents/qa-tester | Scope and test kinds; it reports bugs it finds instead of fixing them.                                                                                                                                          | Edits outside test files, helpers and test configuration (including `package.json`, to add a test script) are refused by the tool runner. |
| Website Builder   | /code             | Website guidance, templates, browser checks                                                                                                                                                                     | —                                                                                                                                         |

- Usage is recorded per purpose (`code_agent`, `bug_fix`, `qa_testing`, `pair_coding`, `code_review`, `deep_research`, `security`).
- Approvals:
  - plan approval is on by default;
  - commands outside the safe list ask first;
  - edit review is optional;
  - pushing to GitHub always asks and always goes to a new branch.
- **One task per project:** a project can have only one open coding task, so two agents never edit the same project's files at once. A second start gets "conflict" with the reason.

## 6. Activity and the agent directory

- **`/activity`:**
  - shows coding tasks, Bug Fixing, QA Testing, code reviews and research in one list;
  - every status comes from the task's own record;
  - a source that can't be read is reported as "possibly incomplete", not shown as empty.
- **`/agents/directory`** (linked from /agents) shows every catalogue entry, grouped by level, with category and status filters and search. Each entry's details show:
  - role, responsibilities, task types, out of scope;
  - tools and permissions;
  - input and output, escalation, done-when;
  - what it works with, access, version and where it's defined.
- **Where each part of the directory comes from:**
  - **Status:** from `/api/agent-platform`, i.e. this deployment's setup, the user's plan and administrator pauses. Planned and administrator-only entries say so.
  - **Your recent activity:** counts, the last task, the last error, from the user's own Activity records, for the agents Activity covers. For the others it says the history is on the agent's own page; it doesn't show zeros.
  - **Administrators only:** model calls and cost for the last 30 days per usage purpose, from `admin_unit_economics`. These are measured, all accounts including administrator testing, and labelled when a purpose is shared by several entries.
  - **Administrators only:** a **Pause / Resume** button for each task agent (`POST /api/admin/agents`). It saves `pausedAgents` in the platform settings. A paused agent can't start new tasks from anywhere: its page, a proposal, a workflow or a direct API call. Running tasks carry on.

## 7. Workflows (dependency-aware)

`workflow.ts` holds the pure state machine; `workflow-server.ts` runs it against the real tasks.

- **Steps form a dependency graph.** Each step has `dependsOn` and `writes`:
  - `writes` names the resource it changes (`"project"`), or is `null` for read-only steps;
  - a step is _ready_ only when everything it depends on is done;
  - two steps that write the same resource never run at the same time (a lock);
  - read-only steps run alongside;
  - at most 2 steps start per advance.
- **Fix and verify:**
  1. Bug Fixing.
  2. QA Testing (writes tests) and Code Review (read-only) run side by side once the fix is done.
  3. Your decision waits for both.

  A fix that changed nothing skips tests and review.

- **States:** pending, ready, running, waiting for you, done, failed, skipped, cancelled.
- **Failures:** once a step fails, no new step starts. You can:
  - retry it (up to 3 attempts);
  - skip it, if it's optional (tests, review);
  - cancel.
- **Timeout:** a workflow stops after 24 hours, and its running tasks are stopped.
- **Cancel:** stops the running tasks and cancels every open step.
- **Your decision:**
  - approve records it; pushing stays a separate, confirmed action;
  - reject undoes every change the workflow made, and says which files changed since if any did.
- **Not set up yet in production:** the `agent_workflows` table (`supabase/migrations/20261105000000_agent_workflows.sql`) needs the owner's confirmation in Supabase. Until then:
  - `/agents/workflows` says workflows aren't set up;
  - the workflow option is hidden on the agent pages;
  - the API answers "not configured".

## 8. Security model

- **Data isolation:**
  - every table has row-level security (`user_id = auth.uid()`) and is queried with the user's own session;
  - workflows can only point at the user's own project;
  - TRUNCATE is revoked on all public tables.
- **Code execution:** code runs only in Vercel Sandbox microVMs, one per project, never on the app server.
  - Command policy: safe list runs; anything else asks; some are never run (sudo, deleting the project, publishing, deploying, `git push`, piping downloads into a shell).
  - Limits: 2 minutes per command, the plan's computer minutes.
- **Untrusted input:** file contents, logs, repository text, web pages and tool output are fenced as data in prompts. Secret files are listed but their contents are withheld from the model.
- **Secrets:** API keys and tokens stay in server environment variables. Connector tokens are encrypted with `ORBIS_CONNECTOR_KEY`.
- **Approvals:**
  - plans, non-safe commands, connector writes, pushing to GitHub and starting a delegated task all need the user's action;
  - rejecting a workflow undoes its changes.

## 9. Environment variables

Names only; set them in Vercel → Project → Settings → Environment Variables.

| Variable                                                                   | For                                          | Production now                                   |
| -------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`         | Accounts and data                            | Set                                              |
| `ANTHROPIC_API_KEY`                                                        | Claude; required for Deep Research           | Set                                              |
| `OPENAI_API_KEY`                                                           | GPT models                                   | Set                                              |
| `GEMINI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `HUGGINGFACE_API_KEY` | Other providers                              | Not set                                          |
| (Vercel OIDC, automatic) or `ORBIS_SANDBOX_TOKEN` (local)                  | Isolated computers for coding agents         | Automatic on Vercel                              |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY`               | Import and push repositories (see GITHUB.md) | See GITHUB.md                                    |
| `ORBIS_CONNECTOR_KEY` + each connector's OAuth client id/secret            | Connectors                                   | See CONNECTORS.md                                |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`  | Payments                                     | **Not set: paid plans can't be bought**          |
| `SEARCH_PROVIDER`, `SEARCH_API_KEY`                                        | Web search for non-Claude models             | Not set (Deep Research uses Claude's own search) |
| `RESEND_API_KEY`, `ALERT_EMAIL`, `EMAIL_FROM`                              | Emails and alerts                            | See DEPLOY.md                                    |
| `SENTRY_DSN`                                                               | Error reporting                              | Not set                                          |

## 10. Migrations and deployment

- Migrations are in `supabase/migrations`, applied in name order. They are additive. Account and project cascades are added with dynamic SQL (see each file).
- New this round:
  - `20261104000000_code_reviews.sql` (applied);
  - `20261104010000_research_runs.sql` (applied);
  - `20261105000000_agent_workflows.sql` (**not applied yet**);
  - `20261106000000_admin_audit.sql` (**not applied yet**). Until it is, admin actions still happen; they just aren't recorded, and the Agent directory says so.
- Deploy: push to `main`; Vercel builds and deploys. Check with `npx vitest run`, `npx tsc --noEmit` and `npx next build` first.

## 11. How to test each agent

| Agent             | Steps                                                                                          | Expect                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Software Engineer | Code → a project → ask for a change                                                            | A plan to approve, edits, tests run, a report built from what ran                                                                                      |
| Bug Fixing        | /agents/bug-fixer → project → describe the bug, paste the error → Start                        | A plan first; the report's "Before the fix" says whether a failing check ran before the first change                                                   |
| QA Testing        | /agents/qa-tester → project → what to test → Start                                             | Only test files change; an edit to app code is refused in the activity log                                                                             |
| Code Review       | /review → paste code or a GitHub link                                                          | Findings quoting the exact line; rule matches marked separately from AI findings                                                                       |
| Deep Research     | /research (Pro/Max)                                                                            | A cited report; uncited paragraphs counted                                                                                                             |
| Security Team     | /agents/security                                                                               | Scanner findings; a website scan needs proof of ownership                                                                                              |
| Orbis Agent       | Chat: "Fix the bug where … in my <project>"                                                    | A Bug Fixing card; Start creates the task and links to it; "What tasks are still running?" lists them                                                  |
| Activity          | /activity                                                                                      | All of the above with their statuses                                                                                                                   |
| Agent directory   | /agents/directory                                                                              | Every agent by level; filters by category and status; details with boundaries, tools and dependencies; administrators also see Pause and measured cost |
| Routing           | Chat: "What is a closure?" / "Fix the login bug, add tests and review it" / "Deploy it to AWS" | Answered directly / a plan with tests and review side by side after the fix / told plainly that Orbis can't deploy                                     |

## 12. Verified so far

| What                                                      | How                                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated tests                                           | `npx vitest run`                                               | 1,306 tests in 96 files pass. `tests/agent-architecture.test.ts` covers the brief's scenarios: a simple question answered directly; research; coding; multi-step with dependencies; parallel steps; a failed step; insufficient permissions; no suitable agent; cancellation and timeout; two agents and the same project. It also checks the catalogue's validity and the permission enforcement. `tests/agent-workflow.test.ts` covers the dependency graph, locks, retries, skips, cancellation and timeout. |
| Agent directory                                           | Local build, browser, administrator account, stand-in database | 40 entries in 7 levels. The category and status filters work. Details show every section, the user's last failed task and its error, and measured calls/cost per purpose. **Pause** made `/api/agent-platform` report "paused", and starting a Bug Fixing task was then refused (503, with the reason). **Resume** restored it. An unknown agent id is refused (400). No accessibility violations; no sideways scrolling at 1280 and 390 px.                                                                    |
| Code Review                                               | Live, production                                               | Found all 6 planted bugs at the right lines, no false positives, $0.017                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Deep Research                                             | Live, production                                               | Quick research with Haiku searches: completed in 56 s, 14 sources all cited, 68 units, $0.10 (DEEP_RESEARCH.md)                                                                                                                                                                                                                                                                                                                                                                                                 |
| Marketplace, Bug Fixing and QA forms, Activity, task card | Local build, browser                                           | No accessibility violations at desktop and phone widths, no sideways scrolling. Starting a proposed task created the task; a second task on a busy project was refused with the reason.                                                                                                                                                                                                                                                                                                                         |
| Bug Fixing, QA Testing, the Orbis Agent's proposals       | Live, with a real model                                        | **Not yet run**: needs a signed-in test account, which needs your permission                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 13. Not built yet (capability gaps)

- **No agent for:** deploying, managing infrastructure, making purchases or scheduling automations. The router reports these as gaps instead of pretending (`CAPABILITY_GAPS`).
- **Database, Documentation and UI/UX Designer agents:** these aren't separate agents. The Software Engineer covers the work inside a project.
- **Orbis Agent:**
  - it proposes one task at a time; a multi-step plan is described, and run as a workflow only when it matches Fix and verify;
  - there's no general workflow builder.
- **Activity gaps:**
  - Activity doesn't include Security Team runs, workflows, chat assistants or multi-model tools, so the directory doesn't count them;
  - per-agent success rates and durations aren't shown, because only a few agents' records hold them consistently.
- **Usage purposes:**
  - Workforce agents all record usage as `workforce`;
  - the Software Engineer and Website Builder share `code_agent`;
  - so their costs can't be split further.
- **Assistants' models:** the chat assistants' `modelPreference` isn't used to pick the model; they use the chat's model choice.
- **Workflows in production:** they wait for the `agent_workflows` table.
- **Background runs:** coding tasks and workflows advance only while their page is open. A background worker needs `SUPABASE_SERVICE_ROLE_KEY` and a design that keeps per-user authorisation.
- **Other capabilities:** voice conversations, browser automation for users, a plugin marketplace, team-shared agents and workflows.
- **Payments:** Stripe isn't configured in production.

## 14. Next steps, in order

1. Apply the `agent_workflows` table (it needs the owner's confirmation in Supabase) and run Fix and verify live.
2. With your permission, run Bug Fixing, QA Testing, a workflow and an Orbis Agent proposal live on the test account, and record the real cost per agent.
3. Add Security Team runs and workflows to Activity, so the directory can count them.
4. Give the Website Builder its own usage purpose, so its cost is separate from the Software Engineer's.
5. Add a background worker so tasks continue with the page closed.

## 15. Memory, verification, recovery and improvement

Built on what already existed. There is no new job queue and no new service; the only new table is the optional audit log. Each part says what was already there, what was added, and what's still missing.

### A. Memory and context

| Kind of context                              | Where it lives                                                                          | Who can see and change it                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Current task context                         | The task's own record: request, transcript, plan, events                                | The task's owner (row-level security)                                            |
| Project knowledge, decisions and constraints | Project memory, with kinds instruction, architecture, decision, preference and workflow | The project's owner, in the Memory panel: add, edit, approve suggestions, delete |
| User-approved preferences                    | Project memory "preference" notes; chat memory ("Remember…")                            | The owner: Memory panel; Settings → Memory                                       |
| Historical task outcomes                     | The project's last 3 finished tasks, and `continueFrom`, given to a new task            | The owner, through History and Activity                                          |
| Temporary execution state                    | The run's pending action, lock and checks                                               | Only the server                                                                  |

**Added:**

- **No secrets in memory.** `src/lib/secrets.ts` recognises API keys, tokens, private keys, connection strings with passwords, and "password = …" values.
  - Project memory refuses them on add and edit, whether the user or the agent writes the note.
  - Chat memory refuses them too, and the reply says why without repeating the secret.
  - Refused rather than redacted: a half-kept key is still a leak.
- **Relevant chat memories only.** While a person's memories are short (up to 1,500 characters), all of them are given. Above that, `selectMemories` gives the ones that share words with the message first, then the newest, within that budget.
- Project memory already did this: approved notes only, "always" and instruction notes first, then by relevance, within 6,000 characters.

**Limits:**

- Relevance is word overlap, not semantic search.
- There's no automatic expiry: notes stay until deleted (project memory is capped at 100 notes).
- Chat memories can be deleted but not edited, because the table has no update policy (adding one needs a migration).
- Users and projects are kept apart by row-level security, as before.

### B. Evidence-based completion

`src/lib/agent-platform/outcomes.ts` gives every task one outcome, worked out from its records:

| Outcome                | Coding task                                                                 | Research                              | Review / scan                                | Workflow                              |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------- | ------------------------------------- |
| Completed and verified | Tests or a build passed after the last change, nothing failed or was missed | Every finding cites a source it found | —                                            | Tests and review ran, you approved    |
| Completed              | Only an inspection ran (page loads and looks right)                         | Some paragraphs uncited               | Finished (AI findings aren't confirmed bugs) | You rejected; changes undone          |
| Partly completed       | Checks failed, went stale or were missed, or problems left open             | —                                     | A scanner didn't run                         | Approved with tests or review skipped |
| Blocked                | A limit was reached                                                         | —                                     | —                                            | —                                     |
| Failed                 | Error                                                                       | Error                                 | Error                                        | Error                                 |
| Unverified             | No checks ran, or no report                                                 | No citation check, or no sources      | —                                            | —                                     |

- **The coding agent's verdict already existed** (`verdict.ts`: checks are planned per task, and Orbis runs tests and a browser check itself after the agent finishes). This round makes the same vocabulary cover every agent.
- **Where it shows:** Activity, and the Orbis Agent's answers about tasks.
- **No outcome from the agent's words:** nothing is "verified" because an agent said so. A completed run without a report is "unverified".

### C. Failure recovery

- **Classification:** `src/lib/agent-platform/failures.ts` sorts failures into transient, permission, setup, invalid input, limit, strategy or unknown. The coding agent's recorded failure kind is used first, then the error text.
- **Retry rule** (`shouldRetry`), all three must hold:
  - the failure class is one retrying can fix (transient, strategy or unknown);
  - attempts are left (3 per workflow step);
  - the last two attempts didn't fail the same way. Errors are compared with numbers, ids and quoted names set aside.
- **Workflow steps** follow this rule on the server, and the page explains why a retry isn't offered.
- **Activity** shows each failed task's class and what to do. That advice becomes the task result's next step for the orchestrator.
- **Already there:** the coding agent's limits, repetition detection (3 identical action sets pause the run), 3 model failures in a row, refusals, and unreadable replies. It also had interrupted-step recovery and partial results kept in the run (changes, checkpoints, report).

**Limits:**

- Switching to another agent or model automatically isn't done; the advice suggests it and the user decides.
- The coding agent doesn't use the chat's provider fallback.

### D. Models and resources

- **Already there:**
  - rule-based Auto routing by task complexity (`ai/router.ts`): cheapest suitable model, a reasoning model when complex;
  - plan model tiers;
  - each agent's model choice: coding uses Auto (coding), reviews prefer reasoning, research is fixed;
  - token, cost, model-call and time totals per task;
  - step, token, time and failed-test limits that pause and ask.
- **Added:**
  - administrators can set the default token budget and time limit for new coding tasks (Admin → Behaviour → "Default limits"). A task that reaches one still pauses and asks;
  - each new coding task records its agent's version (`options.agentVersion`), so outcomes and costs can be compared across versions.

**Limits:**

- There is no per-task dollar cap; the plan budgets and the per-request cost cap apply instead.
- Tool calls aren't counted per task.
- `model_runs` has no task id, so per-task cost comes from each task's own totals.

### E. Observability

**Activity** (`/activity`) now covers:

- coding tasks, reviews, research, **Security Team scans** and **workflows**, each with its outcome and why;
- for failures, the class and advice;
- **measured progress** (steps taken of the step limit) and **recorded cost**;
- a **Stop** button for tasks that can be stopped (it calls that task's own cancel endpoint);
- a **"not moving"** flag for open tasks with nothing recorded for 10 minutes. Tasks advance while their page is open, and the flag says so instead of implying progress.

**Limits:**

- There is no separate "pause" (waiting for the user is the pause).
- There is no admin view of every user's tasks; admins see aggregates only.
- Security scans run within one request, so there's nothing to stop.

### F. Durability

**Already there:**

- task state, events, changes and checkpoints are kept in the database;
- each step takes a lock, steps are idempotent (`expectStep`), and an interrupted tool call is reported as "interrupted, check state" rather than repeated blindly;
- cancelling stops a running command, and the sandbox has a timeout;
- workflows stop after 24 hours, and a Stop sent during an advance wins.

**Not built:** background execution. Tasks advance only while their page is open. Making them advance with the page closed needs a worker with the Supabase service-role key (not set) and a design that keeps per-user authorisation.

### G. Security and approvals

- **Risk table:** `src/lib/agent-platform/risk.ts` lists 14 consequential actions with their risk, whether they can be undone, the approval each needs, and the file and line of code that enforces it.
  - It is shown in the Agent directory.
  - A test checks every cited line exists, and that nothing irreversible runs without approval.
- **Admin audit log:** `admin_audit`, append-only, administrators only.
  - It records saving platform settings (which settings changed; not their values) and pausing or resuming agents, with secrets removed.
  - Administrators see it in the Agent directory once its migration is applied.
- **Already there:**
  - permission checks where each tool runs;
  - untrusted content fenced as data;
  - secret files withheld from the model;
  - per-user row-level security;
  - confirmation cards for connector writes;
  - ownership proof before website scans.

### H. Evaluation and improvement

- **The suite:** `npm run eval:agents` runs `evals/agents/*.json` (77 cases: 30 routing, 27 security, 20 recovery) against `evals/agents/baseline.json`.
  - A score below the baseline fails the normal test run (`npx vitest run`). That run is part of every release check, though Vercel doesn't run it on deploy.
  - A better baseline is recorded on purpose (`UPDATE_AGENT_BASELINE=1`) and reviewed with the change.
- **It already paid off:** writing it found three routing and classification mistakes, all fixed:
  - "add integration tests for the API" was planned as a feature;
  - "…and review it" wasn't seen as a review;
  - "isn't included in your plan" wasn't a permission failure.
- **Versions:**
  - agent definitions carry versions (registry and catalogue), recorded on each coding task;
  - configuration changes are recorded in the audit log;
  - agents can't change permissions, settings or instructions: only administrators can, through the API, and those routes require an admin.

**Limits:**

- No suite runs real agent tasks against real models (they cost money and vary). The real-model check is Admin → Answer check (40 cases).
- Feedback (`response_feedback`) isn't yet analysed into routing or prompt changes automatically; that stays a human review.

### What's outstanding (infrastructure)

1. Apply the two pending migrations: `agent_workflows` and `admin_audit`. Each needs the owner's confirmation in Supabase.
2. Add a background worker so tasks continue with the page closed. This needs `SUPABASE_SERVICE_ROLE_KEY` and a design review.
3. Add a task id on `model_runs`, and per-task tool-call counts.
4. Add an update policy on chat memories so they can be edited.
5. Add real-model agent evaluations with a fixed budget, run before releases.

## 16. Natural Writing (part of the Writing Agent)

**What it is:** Natural Writing rewrites stiff, generic or robotic text so it reads naturally for its audience, without changing what it says.

- It is a **capability of the existing Writing Agent**, not a separate agent: it has no page or conversations of its own.
- The catalogue lists it as `writing:natural-writing-agent` (agent id `natural-writing-agent`), part of `assistant:writing`.

**Where it lives:** all of it is in `src/lib/writing/natural.ts`:

- the styles and intensities;
- request detection;
- the instructions;
- the writing check.

Adding a style or an intensity is one table entry; nothing else in the agent system changes.

### How it's switched on

| Where                                  | How                                                                                                                                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writing Agent page (`/agents/writing`) | The **Natural writing** controls above the message box. Saved in the browser and validated by the server. The settings are: style, rewrite intensity, "Explain changes", and a writing sample for "Match my writing style". |
| Writing Agent, without the controls    | Automatically, when the message asks for natural, conversational, polished or personal writing. The reply shows "(from your request)".                                                                                      |
| Chat (the Orbis Agent)                 | The router classifies the request as `refine_writing` and answers directly in chat with Natural Writing on. It doesn't delegate to another agent.                                                                           |

**Styles:**

- Natural and conversational
- Professional and polished
- Friendly and approachable
- Persuasive and engaging
- Academic and precise
- Match my writing style

**Intensities:**

- **Light edit:** keeps the structure and most wording.
- **Balanced rewrite:** rephrases freely and keeps paragraph order and every point.
- **Full rewrite:** rewrites from the meaning up and keeps every fact and point.

**Not switched on for design requests:** a request about a page, app or design ("make the login page more professional") doesn't turn it on, unless it mentions the text.

### Rules it follows

The rules are in the instructions; the writing check enforces part of them.

- Keep the message, facts, numbers, names, technical terms, quotations, citations, links, formatting and disclosures.
- Never invent experiences, credentials, sources, statistics or evidence.
- No deliberate mistakes or artificial imperfections.
- **AI detectors:** no promises about detector results. When a user asks about detectors, it improves the writing and says plainly that detectors are unreliable, and that the aim isn't to hide authorship.
- **Writing samples:** a sample is fenced as data, so instructions inside it are ignored.
- **No text given:** it asks for the text rather than inventing some.

### Quality assurance: the writing check

When there's an original to compare (the text after the instruction, or an attached file), the reply is checked by `checkRewrite`.

- **Errors:** numbers lost or added, citations lost or added, quotations changed, links lost, disclosures lost.
- **Warnings:** a length far outside the intensity's range, and generic phrasing still present.

**How it's shown:** the result appears as a "Writing check" row under the reply, and is saved with the message in the Writing Agent and in chat.

- The row also holds **the original text, to compare or copy back**.
- The original also stays in the conversation as the user's message.
- The note after `---` ("What changed") isn't checked as part of the text.

**Cost:** turns with Natural Writing are recorded under the purpose `natural_writing`, so their cost is measured separately.

### Connections the brief asked for

| Brief                                           | Here                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writing Agent sends drafts for refinement       | Same agent: the controls or the request switch the capability on                                                                                                                                                                          |
| Research Agent verifies facts                   | The writing check catches changed or invented numbers, citations and quotes. To check whether claims are _true_, the catalogue hands off to Verify (`pipeline:verify`); it isn't run automatically because each check costs a model call. |
| Brand Voice Agent                               | There isn't one. "Match my writing style" with a sample covers the author's voice. A shared brand voice could later come from project memory "preference" notes.                                                                          |
| Quality Assurance Agent                         | The writing check, which is rule-based. Orbis's QA Testing agent tests code, so it isn't used for prose.                                                                                                                                  |
| Orchestrator routes suitable text automatically | `refine_writing` in the router, and detection in chat                                                                                                                                                                                     |

### Tests and evaluation

- `tests/natural-writing.test.ts` covers settings, detection, instructions, the writing check, and a full Writing Agent turn with the instructions in the prompt, the visible row and the check. It also checks the catalogue still has one Writing Agent.
- The evaluation suite has a **natural** suite: 21 cases for detection, style, intensity and detector requests, plus check results. It also has three routing cases.
- Writing the suite found five detection gaps, all fixed: "more professional and polished", "friendlier", "more persuasive and engaging", "passes Turnitin", and "make the login page more professional" (which should not trigger it).

### Limits

- The writing check compares facts and wording mechanically. It can't judge whether the meaning changed the way a reader can, and it says so.
- It isn't run on a live model in this round: quality depends on the chosen model, and no real-model writing evaluation has been run yet.
- There is no side-by-side diff view; the original is shown in the check row.
