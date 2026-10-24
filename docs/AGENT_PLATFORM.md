# Orbis agent platform

How Orbis's agents fit together, what each one does, how to test it, what it needs, and what isn't built. Written 24 October 2026 against the code in this repository; "live" means checked on tryorbis.app, "local" means checked against a local build with a stand-in database.

## 1. What already existed, and what was added

Orbis was not rebuilt. The agent platform is a thin layer over runtimes that already worked:

| Brief asks for | Already in Orbis (reused) | Added in this round |
| --- | --- | --- |
| Central AI agent | Chat with model routing, memory, web search, connectors with confirm-before-write cards | **Orbis Agent** in chat: proposes tasks for specialist agents as cards you start (§3) |
| Coding agent, workspace, terminal, preview, diff, undo, Git | Orbis Code: projects, editor, isolated computer (Vercel Sandbox), tool-calling agent, checkpoints, revert, push to a new GitHub branch | ZIP upload as a project |
| Debugger agent | Coding agent | **Bug Fixing** profile: reproduce first, root cause, before/after test results (§4) |
| Testing agent | Coding agent's test runner and parser | **QA Testing** profile: may only change test files, enforced by the server (§4) |
| Code review / security agent | Security Team (Sentinel, Threat Hunter, Code Guardian); Code Review | Code Review can review exactly what agent tasks changed |
| Research agent | Deep Research (cited reports) | — |
| Website / app builder | Code's website builder with browser checks | — |
| Agent registry, marketplace | Chat assistants at /agents | **Registry** of task agents with capabilities, permissions, approvals, limits, plan access; marketplace section on /agents (§2) |
| Task dashboard, history | History of coding tasks | **Activity**: every agent task in one list (§5) |
| Multi-agent workflows | — | **Fix and verify** workflow (built and tested; waiting for its database table, §6) |
| Memory, custom agents, connectors, usage, billing | Project memory, memory across chats, custom chat assistants, connectors (OAuth, encrypted tokens), usage ledger, Stripe billing code | — |

## 2. The registry and availability

- `src/lib/agent-platform/registry.ts` lists every task agent: name, category, icon, capabilities, limitations, tool permissions, what needs approval, server requirements, plans, how it's charged, and its workspace.
- An agent is listed only when its runtime exists. Sales, Support, Cloud Cost, DevOps, SEO and the other agents in the brief are **not listed**, because they aren't built. A test checks this.
- `availability.ts` works out, for this user on this deployment: ready, not set up here (missing AI key or sandbox), sign in, or upgrade (plan doesn't include it).
- `server.ts` → `assertAgentAccess` applies the same rule whenever a task starts, so the page can't offer what the server would refuse.
- Adding an agent: a registry entry, a runtime (or a profile of an existing one), and a workspace page.

## 3. Orbis Agent (chat)

- When a message asks for work a specialist does (fix, test, review, research, build, refactor, explain a codebase…), the chat model is also given:
  - the agents this user can start;
  - their projects, fenced as data.
- The reply may end with one `orbis-task` block. The server turns it into a card when:
  - the agent is available;
  - the input is valid;
  - the project is one of the user's.

  Otherwise it removes the block and says why.
- The card shows the agent, the project and the details. You can edit them, then press **Start**. Nothing starts from the model's words alone.
- `POST /api/agent-platform/delegate` checks access, input and project ownership again, starts the task, and records the outcome on the saved reply.
- Questions about tasks ("what's still running?") are answered from the user's task records (`<user_tasks>`), not from memory.
- Ordinary chat messages get none of this, so they cost no more.
- Not built: the Orbis Agent can't yet chain several specialists on its own. Each proposal is one task. The chained version is the workflow in §6.

## 4. Coding-engine agents

All run on the Orbis Code engine. They share its isolated computer, limits (steps, tokens, time, failed test runs), approvals, checkpoints, revert and records.

| Agent | Workspace | What's different | How it's enforced |
| --- | --- | --- | --- |
| Software Engineer | /code | — | — |
| Bug Fixing | /agents/bug-fixer | Bug form (summary, details, logs, how to reproduce, expected). Logs are fenced as data and long ones clipped (first 2,000 + last 3,000 characters). Instructions: reproduce first, root cause, regression test. | The report's "Before the fix" section is built from what ran before the first edit, not from the agent's words. |
| QA Testing | /agents/qa-tester | Scope and test kinds; it reports bugs it finds instead of fixing them. | Edits outside test files, helpers and test config are refused by the tool runner. Files a command changes outside tests are put back. |
| Website Builder | /code | Website guidance, browser checks | — |

- Each agent's usage is recorded under its own purpose (`code_agent`, `bug_fix`, `qa_testing`), so the cost of each can be measured.
- Approvals:
  - plan approval is on by default;
  - commands outside the safe list ask first;
  - edit review is optional;
  - pushing to GitHub always asks and always goes to a new branch.

## 5. Activity

- `/activity` (sidebar → Activity) shows coding tasks, Bug Fixing, QA Testing, code reviews and research in one list.
- Statuses: planning, running, waiting for you, completed, failed, cancelled. Each comes from the task's own record.
- You can filter by status and agent, and search.
- Each row opens the task's own page, where its progress, approvals, changes and retry are.
- `GET /api/activity` reads only the signed-in user's rows (row-level security). A source that can't be read is reported as "possibly incomplete", not shown as empty.

## 6. Fix and verify workflow (branch `agent-workflows`, not deployed)

- **Steps:**
  1. Bug Fixing.
  2. QA Testing writes regression tests for the files the fix changed.
  3. Code Review reviews those changes (rules, OSV dependency checks and AI).
  4. Your decision.
- **Fixed order:** the order is set by the template. Agents can't start other agents. A fix that changed nothing skips tests and review.
- **Failure recovery:**
  - a failed step can be retried, up to 3 attempts;
  - only the test and review steps can be skipped;
  - a workflow stops after 24 hours.
- **Your decision:**
  - approve records the decision; pushing stays a separate, confirmed action in Code;
  - reject undoes every change the workflow made. If files changed since, it says which and undoes nothing more.
- **Tests:** transitions, recovery, approval and child-task reading (20 tests), plus owner-only database isolation (3 tests).
- **Blocked on:** the `agent_workflows` table (`supabase/migrations/20261105000000_agent_workflows.sql`). Applying it needs the owner's confirmation in Supabase. Then merge the branch.

## 7. Security model

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

## 8. Environment variables

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

## 9. Migrations and deployment

- Migrations are in `supabase/migrations`, applied in name order. They are additive. Account and project cascades are added with dynamic SQL (see each file).
- New this round:
  - `20261104000000_code_reviews.sql` (applied);
  - `20261104010000_research_runs.sql` (applied);
  - `20261105000000_agent_workflows.sql` (**not applied yet**).
- Deploy: push to `main`; Vercel builds and deploys. Check with `npx vitest run`, `npx tsc --noEmit` and `npx next build` first.

## 10. How to test each agent

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

## 11. Verified so far

| What | How | Result |
| --- | --- | --- |
| Automated tests | `npx vitest run` | 1,227 tests in 92 files pass on `main`. The `agent-workflows` branch has 1,230 in 91 files (it has the workflow tests but not this round's Orbis Agent tests). |
| Code Review | Live, production | Found all 6 planted bugs at the right lines, no false positives, $0.017 |
| Deep Research | Live, production | Planning step ran; the first search step hit Pro's 5-hour limit (searches since moved to Haiku); re-run scheduled |
| Marketplace, Bug Fixing and QA forms, Activity, task card | Local build, browser | No accessibility violations at desktop and phone widths, no sideways scrolling. Starting a proposed task created the task; a second task on a busy project was refused with the reason. |
| Bug Fixing, QA Testing, the Orbis Agent's proposals | Live, with a real model | **Not yet run**: needs a signed-in test account, which needs your permission |

## 12. Not built yet

- **Orbis Agent:** automatic chaining across specialists, and tool calls in chat beyond proposals and task status.
- **Specialist agents:** Database, Documentation, Deployment and UI/UX Designer don't exist as separate agents. The Software Engineer can do much of this in a project, but no dedicated agents are listed.
- **Automations:** a scheduler and worker exist only for admin cron jobs. There is no user automation centre.
- **Other capabilities:** voice conversations, browser automation for users, the plugin marketplace, team-shared agents and workflows.
- **Background runs:** coding tasks advance only while their page is open. A background worker needs `SUPABASE_SERVICE_ROLE_KEY` and a design that keeps per-user authorisation.
- **Payments:** Stripe isn't configured in production.
- **Pricing:** the $20–$40, $60–$100 and $199–$499 hypotheses are not applied. They need willingness-to-pay data first.

## 13. Next steps, in order

1. Apply the `agent_workflows` table, merge `agent-workflows`, and run the workflow live.
2. With your permission, run Bug Fixing, QA Testing and an Orbis Agent proposal live on the test account, and record the real costs per agent.
3. Add per-agent cost to the admin Finance panel (the purposes are already recorded separately).
4. Set up Stripe so paid plans can be bought.
5. Add a background worker so tasks continue with the page closed. This needs the service-role key and a design review.
