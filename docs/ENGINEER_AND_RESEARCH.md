# Code Review and Deep Research: inspection and plan (24 Oct 2026)

Two briefs asked for an "AI Software Engineer" (code review, bug fixing, tests, GitHub, SaaS plans) and an "all-in-one agent workspace" (eight agents, starting with Deep Research). This maps what Orbis already has and what was built for each.

## What already exists (and is reused, not rebuilt)

| Brief asks for | Already in Orbis | Where |
| --- | --- | --- |
| Isolated code execution with limits, timeouts, cleanup | Vercel Sandbox microVM per project: CPU/time limits, no secrets inside, output caps, audit trail | `src/lib/code/workspace.ts`, docs/CODE_WORKSPACE.md, ORBIS_CODE_SECURITY.md |
| Bug-fixing agent: plan → smallest change → run tests → bounded repair → diff → approval | Coding agent: plan approval, edit review, test runs, repetition/attempt limits, checkpoints, undo, verified final report | `src/lib/code/agent/*`, docs/CODE_AGENT.md |
| Two-model review with evidence | Pair Coding (Architect + Reviewer, findings need evidence, fixes verified) | `src/lib/code/pair/*`, docs/PAIR_CODING.md |
| Security code audit | Code Guardian: secret/insecure-code rules, OSV dependency CVEs, AI findings kept only if the quoted line exists | `src/lib/security/*`, docs/SECURITY_AGENTS.md |
| GitHub | Sign-in, read-only GitHub App (Contents), import a repo into a project, Update from / Push to GitHub with approval | `src/lib/github/*`, docs/GITHUB.md |
| Multi-provider models, routing, retries, cost tracking | Anthropic + OpenAI live; Gemini, xAI, DeepSeek adapters ready (no keys set); Auto routing; usage ledger with per-run cost | `src/lib/ai/*`, `src/lib/usage.ts` |
| Model Arena, Council | Live | `/arena`, `/council` |
| Plans, quotas, webhooks | Free/Pro/Max + Team seats, server-side entitlements, atomic reservations, idempotent Stripe webhook, extra usage | docs/BILLING.md, USAGE.md |
| Task history | Coding and pair tasks in History; usage history | `/history`, `/usage` |

## What was missing

1. **A general code reviewer.** Code Guardian only looks for security problems. Nothing reviewed submitted code or a pull request for bugs, logic errors, edge cases, missing tests or performance, with file:line findings, confidence, evidence and an inspectable suggested fix.
2. **Deep Research.** Chat's Research mode answers in one turn. There was no multi-step research with a plan, progress, persistent history, a source list and an exportable report.
3. **Web search in production.** No `SEARCH_API_KEY` (Tavily/Brave) is set. Claude's built-in web search tool works with the existing Anthropic key and returns citations (URL plus the quoted text), so Deep Research uses that.

## Built in this increment

- **Code Review** (`/review`): see docs/CODE_REVIEW.md.
- **Deep Research** (`/research`): see docs/DEEP_RESEARCH.md.

## Needs external setup (not simulated)

| Feature | Needs |
| --- | --- |
| Payments (any paid plan) | Stripe keys and webhook secret in Vercel. Payments are currently **off** in production (`/api/status`: billing not configured). |
| Private pull requests via the Orbis GitHub App | The App's **Pull requests: read** permission. Without it, PR review works for public repositories and pasted diffs. |
| Posting review comments, opening draft PRs | The App's **Pull requests: write** permission, plus an approval flow (planned). |
| GitHub webhooks (review on every PR) | A webhook secret and a background worker (planned). |
| Gemini / other providers | Their API keys. |
| Tavily/Brave search (non-Claude research) | `SEARCH_API_KEY`. |

## Not built (planned, by priority)

1. Review → "Fix with the coding agent" for GitHub sources is built. Automatic draft PRs from a fix need the PR write permission above.
2. Browser Operator, Workflow Automation, Data Analyst, Marketing and Sales agents, the multi-agent Project Manager and the Agent Marketplace: none are started.
3. The pricing hypotheses in the brief ($29 Developer / $79 Pro / $199 Team) are **not** applied. Current prices (Pro $20, Max $100, Team per seat) stay until there's usage and payment data; see docs/UNIT_ECONOMICS.md.
