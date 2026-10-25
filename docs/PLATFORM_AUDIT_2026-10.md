# Orbis platform audit and plan (25 October 2026)

Brief: make Orbis an all-in-one AI workspace (research, reasoning, coding, browser, agents) on a $25–35/month
operating target with a hard $100/month ceiling. This is the Phase 0 audit, the changes made with it, and the plan.
Everything below was checked in the repository, the production database (read-only queries) and the Vercel
project. Estimates are labelled as estimates.

## 1. What Orbis is today

| Area | What exists | Where |
| --- | --- | --- |
| Stack | Next.js 16 (App Router) + React 19 + Tailwind v4 on Vercel; Supabase Postgres with row-level security; Stripe; Resend | `src/`, `supabase/migrations/` |
| Auth | Supabase Auth (email, Google), server-side checks on every route, admins table | `src/lib/auth.ts` |
| Models | One server-side layer: Anthropic (official SDK), OpenAI, Gemini, xAI, DeepSeek, Hugging Face (OpenAI-compatible); registry with verified prices; Auto mode picks the lowest-cost model with the needed capabilities; Smart Router modes; opt-in fallback; timeouts, one bounded retry, cancellation | `src/lib/ai/`, `docs/MODELS.md` |
| Configured in production | Anthropic and OpenAI keys only. Gemini, xAI and DeepSeek need keys. | Vercel env (names only) |
| Usage and cost | Every model call recorded with tokens and estimated cost (`model_runs`); per-plan 5-hour/weekly/monthly limits; per-account monthly AI budgets; per-request cost cap; daily cron with spend alerts and reconciliation; "Pause all AI" switch | `src/lib/usage.ts`, `src/lib/budget.ts`, `docs/USAGE.md` |
| Research | Deep Research (Quick/Standard/Deep): plan → Claude web search per question → report with citations checked against retrieved passages; history, Markdown/PDF export; AI Search page; Verify (claim checking); link reading in chat | `src/lib/research/`, `docs/DEEP_RESEARCH.md`, `src/lib/links/` |
| Coding | Orbis Code: per-project workspace (files, diffs, checkpoints), coding agent with native tool calling, commands/tests/previews in Vercel Sandbox, step/token/test-attempt budgets, repetition detection, approvals, honest final report; pair coding; code review; GitHub push | `src/lib/code/`, `docs/CODE_AGENT.md` |
| Browser | Headless Chromium inside a project's sandbox checks the project's own preview (desktop/tablet/phone, console errors, broken links, overflow) with screenshots. No general web browsing. | `src/lib/code/preview-check.ts` |
| Agents | Agent registry; capability router; dependency-aware workflows (fix → test → review → approval) with persisted state, cancellation and approval checkpoints; Orbis Agent delegation from chat; security team (Sentinel, Threat Hunter, Code Guardian, Aegis, Bastion) | `src/lib/agent-platform/`, `docs/AGENT_PLATFORM.md` |
| Safety | Bastion enforcement at every execution point (commands, file writes, pushes, connector actions, code runs); SSRF-guarded fetching; untrusted content fenced in prompts; secrets server-side only; tenant-isolation and bypass tests | `src/lib/bastion/`, `docs/SECURITY_AGENTS.md` |
| Tests | 112 Vitest files, 1,572 tests (unit, route, tenancy, adversarial) | `tests/` |

Production usage (from `model_runs`, last 30 days): 6 accounts, 351 model calls, **$1.28 recorded AI cost**.

## 2. Capability status

| # | Capability | Status | Notes |
| --- | --- | --- | --- |
| 1 | Deep web research | Working | Claude web search; cost measured at ~$0.10 per Quick run |
| 2 | Real-time web search | **Was off, fixed today** | Needed a Tavily/Brave key that was never set; now falls back to Claude web search (see §3) |
| 3 | Source-grounded answers and citations | Working | Citations validated against retrieved passages; doesn't prove entailment (documented) |
| 4 | Advanced reasoning | Working | Claude Sonnet/Opus and GPT Terra available by plan |
| 5 | Multiple providers | Partial | Code supports 6; only Anthropic and OpenAI have keys |
| 6 | AI-powered coding | Working | |
| 7 | Autonomous software development | Partial | Runs continue only while the page is open (no background worker); no deploy integration for user projects |
| 8 | Browser automation | Partial | Own-preview checks only; no general browsing tool |
| 9 | Terminal and code execution | Working | Vercel Sandbox, isolated per project, time limits, Bastion-checked |
| 10 | Automated testing and debugging | Working | Test runs parsed; bounded repair attempts |
| 11 | Multi-agent orchestration | Working | Deterministic workflows with dependencies, approvals, budgets |
| 12 | Document and data analysis | Partial | Pasted/attached text and CSV; PDF/Word upload not built |
| 13 | Research reports | Working | Markdown and print-to-PDF export |
| 14 | Cost monitoring and optimisation | Working, **ceiling added today** | Per-user budgets existed; there was no hard ceiling covering administrators and guests |
| 15 | Permission-controlled tools | Working | Bastion Core + customer policies |

## 3. Changes made with this audit

1. **Live web search everywhere, with no new account.** `src/lib/search/live.ts` is now the one search entry point
   for chat (Research mode), AI Search, agents, Council, Verify, templates and the coding agent's docs lookup. It
   uses a Tavily/Brave key when set (cheapest), otherwise Claude's web search on the cheapest Claude model with
   one search per call. Each search is counted once against the plan's monthly searches, as before; the search
   model's tokens are recorded as an auxiliary run (counted in spending and budgets, no allowance units).
   Tests: `tests/live-search.test.ts`.
2. **Hard monthly AI ceiling.** `ORBIS_MONTHLY_AI_BUDGET_USD` now refuses new AI requests from everyone,
   administrators and guests included, once the month's recorded AI cost reaches it, and emails the owner. It
   counts every recorded call (failed calls and helper steps too). Administrators see how to raise it.
   Set to **$75** in production (the $100 ceiling minus room for hosting). The daily check emails at 80% ($60).
   Tests: `tests/spend-ceiling.test.ts`.

## 4. Cost plan

Prices checked 25 October 2026 via search of the providers' own pages; confirm before relying on them.

| Item | Price | Source |
| --- | --- | --- |
| Claude web search | $10 per 1,000 searches + tokens | Anthropic pricing docs |
| Tavily | 1,000 free credits/month (basic search = 1 credit), then $0.008/credit | docs.tavily.com/documentation/api-credits |
| Exa | $7 per 1,000 searches; free monthly credit (amount varies by source) | exa.ai/docs/reference/pricing |
| Vercel Sandbox (Hobby) | 5 active CPU-hours, 420 GB-hours memory, 5,000 creations/month included; creation pauses beyond that | vercel.com/docs/vercel-sandbox/pricing |
| Model tokens | See `docs/MODELS.md` (verified 19 Oct 2026), e.g. Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10 per 1M | provider pages |
| Supabase | Free plan (confirmed via API) | Supabase |
| Vercel hosting | Plan not visible through the API. Hobby is $0 but is for non-commercial use; a paid product needs Pro | vercel.com/pricing |
| Resend | Free tier for low volume | resend.com/pricing |

**Monthly estimate for light personal use (estimate, not a measurement):** 300 chat messages on low-cost models
(~$1), 100 web searches via Claude (~$1.20; $0 with a free Tavily key), 10 Quick research runs (~$1, measured at
$0.10 each), 20 coding tasks (~$4–20 depending on model and size) → **about $7–23 of AI**, plus hosting.
Measured so far: $1.28 in 30 days.

**Cheapest next step:** add a free Tavily key (`SEARCH_PROVIDER=tavily`, `SEARCH_API_KEY`) — the first 1,000
searches a month cost nothing, and Orbis switches to it automatically.

## 5. Roadmap (by value, cost and risk)

| Phase | Work | Reuses | Cost to run | Risk / rollback |
| --- | --- | --- | --- | --- |
| 1 — done | Search fallback, hard ceiling | search, usage, budget, alerts | per use | revert commit; unset env var |
| 2 | Search-result cache (per user, short TTL), query dedup across research steps | `search/live.ts` | saves money | low |
| 3 | PDF/Word upload for chat and research (text extraction server-side) | attachments | ~$0 | file-parsing security; size limits |
| 4 | Background worker for long coding runs (Vercel Cron/Queue + service role scoped per run) | code engine, Bastion | low | authorization design needed first (ORBIS_CODE_ARCHITECTURE.md §8) |
| 5 | Browser tool for research and testing deployed sites: Chromium in Vercel Sandbox, public pages only, read-only by default, confirmation for any form submission | preview-check, Bastion, SSRF guard | Sandbox CPU (Hobby allowance) | consequential actions need approval; no logins/CAPTCHA bypass |
| 6 | More providers (Gemini, DeepSeek keys) for cheaper routing | registry | per use | none (keys only) |

## 6. Access and setup still needed

- Pending database updates (team roles, workflows, admin audit): run `orbis-database-updates.sql` in Supabase.
- Optional: Tavily key (free tier) to make search cheaper.
- Confirm the Vercel plan (Hobby vs Pro) so the $100 ceiling can account for hosting exactly.
- Guest requests aren't recorded in `model_runs`, so their AI cost isn't counted toward the ceiling (they are
  limited per IP per day and are refused once the ceiling is reached).
