# Orbis agent platform

How Orbis's agents fit together, what each one does, how work is routed between them, how to test them, and what isn't built. Written 24 October 2026 against the code in this repository; "live" means checked on tryorbis.app, "local" means checked against a local build with a stand-in database.

## 1. Inventory: every agent in Orbis

There are 40 agent entries in 11 systems. All of them existed before this round; none was added just to fill out the hierarchy. The catalogue (`src/lib/agent-platform/catalogue.ts`) is built from the lists each runtime already uses (the task registry, the Security Team, the Workforce and the built-in assistants), so no definition is written twice. You can browse it at **/agents/directory**.

| Level | Entries | Runs under | Defined in |
| --- | --- | --- | --- |
| Orchestrator | Orbis Agent (chat), v2.0 | The user, in Chat | `orbis-agent.ts` |
| Planner | Task router and planner, v1.0 (deterministic, no model call) | The Orbis Agent | `routing.ts` |
| Specialists | Software Engineer 3.2, Code Review 1.1, Bug Fixing 1.0, QA Testing 1.0, Security Team 1.0, Deep Research 1.1, Website Builder 1.2, Data Analyst 1.0 | The user, or a proposal the user starts | `registry.ts` |
| Sub-agents | Security: Sentinel, Threat Hunter, Code Guardian (active); Incident Responder, Threat Intelligence (planned). Pair coding: Architect, Reviewer | Their parent agent | `security/agents.ts`, `code/pair/` |
| Multi-model tools | Verify, Council, Arena, Mission planner, Connectors, Images | The user, from their own pages | each feature's lib |
| Chat assistants | Research, Coding, Writing, Data, Creative, General | The user | `agents/builtins.ts` |
| Internal | Workforce: Commander + 8 active agents (administrators only); Optimizer and Visual planned | Administrators | `workforce/agents.ts` |

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

| Agent | Declared | Enforced by |
| --- | --- | --- |
| QA Testing | `edit_tests_only` | The tool runner refuses edits outside test files, helpers and test configuration (`qaMayEdit`); files a command changes outside tests are put back |
| Code Review, Deep Research, Security Team, Data Analyst | Read only | They have no edit or command tools |
| Every coding agent | Commands | The command policy (safe list, ask, never) |
| Every agent | Plan and configuration | `assertAgentAccess` on every start, whoever starts it |

Delegation never widens permissions:
- a proposal from the Orbis Agent is started by the user, through the same access check;
- a workflow step starts through the same `startProfileTask` path as the agent's own page;
- agents can't start other agents (a test checks that no runtime does).

## 3. Routing and planning

`routing.ts` reads the request with fixed patterns, with no model call, so it's free and predictable. It returns one of four modes:

| Mode | When | What the Orbis Agent does |
| --- | --- | --- |
| `direct` | A question, an explanation, writing | Answers itself. No agent and no extra cost. |
| `delegate` | One specialist's work | Proposes that agent as a card the user starts |
| `plan` | Several kinds of work ("fix it, add tests and review it") | Gives the steps in order: who does each, what it waits for, what runs alongside. Matches the Fix and verify workflow when the steps fit. |
| `gap` | Nothing in Orbis can do it (deploying, managing infrastructure, purchases, scheduled automations) | Says so plainly, and still offers any part that can be done |

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

| Agent | Workspace | What's different | How it's enforced |
| --- | --- | --- | --- |
| Software Engineer | /code | — | — |
| Bug Fixing | /agents/bug-fixer | Bug form (summary, details, logs, how to reproduce, expected). Logs are fenced as data and long ones clipped (first 2,000 + last 3,000 characters). Instructions: reproduce first, root cause, regression test. | The report's "Before the fix" section is built from what ran before the first edit, not from the agent's words. |
| QA Testing | /agents/qa-tester | Scope and test kinds; it reports bugs it finds instead of fixing them. | Edits outside test files, helpers and test configuration (including `package.json`, to add a test script) are refused by the tool runner. |
| Website Builder | /code | Website guidance, templates, browser checks | — |

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
  - a step is *ready* only when everything it depends on is done;
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

| Variable | For | Production now |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Accounts and data | Set |
| `ANTHROPIC_API_KEY` | Claude; required for Deep Research | Set |
| `OPENAI_API_KEY` | GPT models | Set |
| `GEMINI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `HUGGINGFACE_API_KEY` | Other providers | Not set |
| (Vercel OIDC, automatic) or `ORBIS_SANDBOX_TOKEN` (local) | Isolated computers for coding agents | Automatic on Vercel |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` | Import and push repositories (see GITHUB.md) | See GITHUB.md |
| `ORBIS_CONNECTOR_KEY` + each connector's OAuth client id/secret | Connectors | See CONNECTORS.md |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY` | Payments | **Not set: paid plans can't be bought** |
| `SEARCH_PROVIDER`, `SEARCH_API_KEY` | Web search for non-Claude models | Not set (Deep Research uses Claude's own search) |
| `RESEND_API_KEY`, `ALERT_EMAIL`, `EMAIL_FROM` | Emails and alerts | See DEPLOY.md |
| `SENTRY_DSN` | Error reporting | Not set |

## 10. Migrations and deployment

- Migrations are in `supabase/migrations`, applied in name order. They are additive. Account and project cascades are added with dynamic SQL (see each file).
- New this round:
  - `20261104000000_code_reviews.sql` (applied);
  - `20261104010000_research_runs.sql` (applied);
  - `20261105000000_agent_workflows.sql` (**not applied yet**).
- Deploy: push to `main`; Vercel builds and deploys. Check with `npx vitest run`, `npx tsc --noEmit` and `npx next build` first.

## 11. How to test each agent

| Agent | Steps | Expect |
| --- | --- | --- |
| Software Engineer | Code → a project → ask for a change | A plan to approve, edits, tests run, a report built from what ran |
| Bug Fixing | /agents/bug-fixer → project → describe the bug, paste the error → Start | A plan first; the report's "Before the fix" says whether a failing check ran before the first change |
| QA Testing | /agents/qa-tester → project → what to test → Start | Only test files change; an edit to app code is refused in the activity log |
| Code Review | /review → paste code or a GitHub link | Findings quoting the exact line; rule matches marked separately from AI findings |
| Deep Research | /research (Pro/Max) | A cited report; uncited paragraphs counted |
| Security Team | /agents/security | Scanner findings; a website scan needs proof of ownership |
| Orbis Agent | Chat: "Fix the bug where … in my <project>" | A Bug Fixing card; Start creates the task and links to it; "What tasks are still running?" lists them |
| Activity | /activity | All of the above with their statuses |
| Agent directory | /agents/directory | Every agent by level; filters by category and status; details with boundaries, tools and dependencies; administrators also see Pause and measured cost |
| Routing | Chat: "What is a closure?" / "Fix the login bug, add tests and review it" / "Deploy it to AWS" | Answered directly / a plan with tests and review side by side after the fix / told plainly that Orbis can't deploy |
## 12. Verified so far

| What | How | Result |
| --- | --- | --- |
| Automated tests | `npx vitest run` | 1,306 tests in 96 files pass. `tests/agent-architecture.test.ts` covers the brief's scenarios: a simple question answered directly; research; coding; multi-step with dependencies; parallel steps; a failed step; insufficient permissions; no suitable agent; cancellation and timeout; two agents and the same project. It also checks the catalogue's validity and the permission enforcement. `tests/agent-workflow.test.ts` covers the dependency graph, locks, retries, skips, cancellation and timeout. |
| Agent directory | Local build, browser, administrator account, stand-in database | 40 entries in 7 levels. The category and status filters work. Details show every section, the user's last failed task and its error, and measured calls/cost per purpose. **Pause** made `/api/agent-platform` report "paused", and starting a Bug Fixing task was then refused (503, with the reason). **Resume** restored it. An unknown agent id is refused (400). No accessibility violations; no sideways scrolling at 1280 and 390 px. |
| Code Review | Live, production | Found all 6 planted bugs at the right lines, no false positives, $0.017 |
| Deep Research | Live, production | Quick research with Haiku searches: completed in 56 s, 14 sources all cited, 68 units, $0.10 (DEEP_RESEARCH.md) |
| Marketplace, Bug Fixing and QA forms, Activity, task card | Local build, browser | No accessibility violations at desktop and phone widths, no sideways scrolling. Starting a proposed task created the task; a second task on a busy project was refused with the reason. |
| Bug Fixing, QA Testing, the Orbis Agent's proposals | Live, with a real model | **Not yet run**: needs a signed-in test account, which needs your permission |

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
