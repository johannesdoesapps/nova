# Orbis AI

**Discover Knowledge. Access AI. Turn Ideas into Action.**

Orbis AI is an AI research and model-intelligence platform: cited web search, chat, model comparison and blind trials, claim-level fact-checking, an AI Lab for approval-gated workflows, a Signal Radar that reports what changed, and shared project workspaces with integrations.

It is two services:

| Service | Language | Role |
|---|---|---|
| **Web app** (`/`) | TypeScript · Next.js 16 · React 19 · Tailwind | UI, Supabase auth, search, chat, Claim DNA, Model Intelligence, and the signed proxy to the engine |
| **Orbis engine** (`/engine`) | **Python 3.11+** · FastAPI · SQLAlchemy | AI Lab workflow execution, Signal Radar monitoring, workspaces, community and connectors, plus a background worker |

Everything runs without API keys in a clearly-labelled demo mode, and switches to real integrations as keys are added. The architecture and launch roadmap are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). To put Orbis online, follow [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## What's implemented

| Area | Status | Notes |
|---|---|---|
| Dashboard, sidebar, responsive layout | ✅ | Collapsible sidebar, mobile drawer, recent chats/projects, favourites, usage |
| Supabase auth | ✅ | Email + password, email confirmation callback, protected pages via `src/proxy.ts`, server-side `getUser()` checks in every private API route |
| AI Search | ✅ | Tavily or Brave → normalised sources → grounded, streamed answer with `[n]` citations that only reference real sources; follow-ups, copy, regenerate, save to project |
| AI Chat | ✅ | Streaming, history, rename/delete, retry, copy, save answer to project, Research/Analyst/Critic/Coding modes, optional web grounding, text-file attachments |
| Model Registry + Router | ✅ | Normalised registry (DB → env → defaults), availability by configured credentials, transparent rule-based recommendations |
| Model Battle | ✅ | 2–N models in parallel (cap configurable), per-model latency/usage/cost, independent failures, preferred pick, save |
| Hugging Face Discovery | ✅ | Models + datasets, task/library/tag filters, sort, cursor pagination, details drawer with model-card excerpt, favourites, shortlist |
| Research Projects | ✅ | CRUD, notes, saved searches/answers/comparisons, in-project search |
| Security & cost controls | ✅ | Zod validation, body-size limits, rate limits, daily quotas, timeouts, RLS, prompt-injection hardening, secrets server-only |
| **Claim DNA** (Part 4) | ✅ | Claims → evidence links (supports / conflicts / insufficient) with verified quotes, source provenance and reliability indicators, limitations on every claim, heuristic "evidence match" that is never shown as truth. Workflows: fact-check queue, unsupported, conflicts, missing evidence, direct vs inference, mis-citations. Optional model judgements count only when their quotes are found in the source. **Check claims** button on AI Search. See [`docs/CLAIM_DNA.md`](docs/CLAIM_DNA.md) |
| **Hypothesis Arena** | ✅ | Competing explanations with testable predictions, discriminating-prediction detection, standings, provisional verdicts only after enough discriminating tests |
| **Research Replay** | ✅ | Every analysis step recorded with input/output hashes; exact replay, what-if (drop sources), live re-run for model judgements, step diffs |
| **Model Intelligence** (Part 5) | ✅ | Blind A/B trials (redacted, CSPRNG order, sealed AES-GCM identity tokens), reproducible benchmarks with deterministic checkers, per-category Model Fingerprint keeping personal preference and measured performance separate, sample-size gating with Wilson intervals and exact paired tests, served-version tracking and drift detection, constraint-based routing with cross-provider fallbacks and circuit breaker, model directory with price provenance/validation and privacy profiles, usage tracking. See [`docs/MODEL_INTELLIGENCE.md`](docs/MODEL_INTELLIGENCE.md) |
| **AI Agents** | ✅ | `/agents` workspace in the chat studio: six built-in agents with their own instructions, tools and temperature; create, edit, duplicate and delete custom agents (icon, accent, model, capabilities, starters); separate per-agent conversation history; one shared execution service with backend permission checks; real server-side data analysis for CSV/TSV; capabilities that aren't set up are shown as such. See [`docs/AGENTS.md`](docs/AGENTS.md) |
| **AI Lab** (Part 7, Python engine) | ✅ | Intent-to-Outcome planner (goal → editable plan → workflow), visual **Intelligence Composer** (React Flow), 8 step types including branches, approvals and retries, budgets, cancellation, checkpoint/resume, idempotent actions, versioning with diffs, test cases that gate publishing, templates, tool permissions, payload-bound approvals for consequential/irreversible/sensitive actions, taint tracking against prompt injection, SSRF guard. See [`docs/AI_LAB.md`](docs/AI_LAB.md) |
| **Signal & Opportunity Radar** (Part 8) | ✅ | Watches on topics, questions, projects, sources, industries, technologies and competitors; RSS/Atom, GitHub releases, arXiv, Hacker News and web-search sources; baseline + change detection; URL/SimHash/title de-duplication; transparent 0–100 ranking; confirmed/reported/speculative labels; alert rules (sensitivity, quiet hours, daily cap); cited digests; emerging patterns; opportunity matching; freshness on every watch; honest scheduler status. See [`docs/SIGNAL_RADAR.md`](docs/SIGNAL_RADAR.md) |
| **Workspaces, Community, Integrations** (Part 9) | ✅ | Shared workspaces (owner/admin/editor/commenter/viewer), 10 item types, version history and restore, optimistic concurrency, threaded comments, knowledge collections, hashed share links, export/import bundles; community publish (sensitive-data scan) / fork / report; connector framework with OAuth PKCE, encrypted tokens, minimal scopes, sync status, conflict resolution, revocation, data deletion and consent log. RSS and GitHub (public mirror) are live; others are listed with an honest status. See [`docs/WORKSPACES_INTEGRATIONS.md`](docs/WORKSPACES_INTEGRATIONS.md) |
| What-If Simulator, Knowledge Graph | 🕒 | Honest "Coming soon" pages (Knowledge Graph is Phase 5 in the roadmap). |

**Demo mode** (no keys): two simulated models make Chat, Search and Battle usable. Every simulated output starts with *"Demo mode — simulated response"* and carries a **Simulated** badge. Search never fabricates sources — without a search key it says that reliable web evidence could not be retrieved.

---

## Quick start

Requirements: Node.js ≥ 20.9 (tested with Node 22) and Python ≥ 3.11 (tested with 3.13).

```bash
# 1. Web app
npm install
cp .env.example .env.local          # set NOVA_ENGINE_SECRET to any long random string

# 2. Python engine (AI Lab, Radar, Workspaces, Integrations)
npm run engine:setup                # creates engine/.venv and installs requirements
export NOVA_ENGINE_SECRET=<same value as in .env.local>
npm run engine                      # http://127.0.0.1:8787  (API docs at /docs)
npm run engine:worker               # optional: scheduled Radar checks, digests, scheduled workflows

# 3. Start the web app
npm run dev                         # http://localhost:3000
```

Without the engine, everything from Parts 1–5 works and the Lab, Radar, Workspaces, Community and Integrations pages explain how to start it.

The app starts with zero configuration. Add keys incrementally:

| Variable | Needed for | Where to get it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`) | Accounts, history, projects, quotas | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SITE_URL` | Email confirmation redirect | Your deployed URL |
| `OPENAI_API_KEY` (optional `OPENAI_BASE_URL`) | OpenAI models | platform.openai.com |
| `HUGGINGFACE_API_KEY` | Open models via HF Inference Providers; higher Hub limits | Fine-grained token with "Make calls to Inference Providers" |
| `SEARCH_PROVIDER` (`tavily` \| `brave`), `SEARCH_API_KEY` | Live sources for AI Search / Research mode | tavily.com or brave.com/search/api |
| `NOVA_MODELS` | Override the model list / set verified prices | See below |
| `NOVA_MAX_COMPARE_MODELS`, `NOVA_DAILY_REQUEST_LIMIT`, `NOVA_RATE_LIMIT_PER_MINUTE` | Cost controls | Defaults: 3 / 200 / 20 |
| `SENTRY_DSN` | Optional error monitoring | See *Observability* |
| `NOVA_TRIAL_SECRET` | Keeps blind-trial tokens valid across restarts / instances | Any long random string |
| `NOVA_ENGINE_URL`, `NOVA_ENGINE_SECRET` | Web ↔ engine connection; the secret signs short-lived user identities and **must match on both services** | `openssl rand -base64 32` |
| `NOVA_TOKEN_KEYS` (engine) | Encrypts OAuth tokens at rest (`kid:base64key`, newest first for rotation) | `kid1:$(openssl rand -base64 32)` |
| `NOVA_ENGINE_DATABASE_URL` (engine) | Engine database; SQLite by default, Postgres (Supabase pooler) in production | `postgresql+psycopg://…` |
| `NOVA_MODEL_PRICES` (engine) | Verified prices for workflow cost limits | `{"openai:gpt-5.6-luna":[0.2,1.2]}` (example only) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (engine) | GitHub OAuth for issue creation (public mirroring works without) | GitHub → Developer settings → OAuth Apps |
| `NOVA_PRIVACY_PROFILES` | Verified provider data-handling facts used by the Model Directory and privacy-constrained routing | JSON keyed by provider, see `.env.example` |

No service-role key is used anywhere: all database access runs as the signed-in user, so Row Level Security always applies. Settings → Integrations shows which variables are set (booleans only — values never reach the browser).

### Database

Apply the migration in `supabase/migrations/` — either:

```bash
supabase link --project-ref <ref>
supabase db push
```

or paste the files in `supabase/migrations/` (in order) into the Supabase SQL editor.

It creates `profiles` (auto-created on sign-up), `projects`, `conversations`, `messages`, `search_sessions`, `sources`, `model_registry`, `model_runs`, `model_comparisons`, `favorite_models`, `project_notes` and `radar_tasks`, with indexes, `updated_at` triggers and RLS policies on every table. Policies also stop users from attaching rows to someone else's project.

In Supabase → Authentication → URL Configuration, add `<your-site>/auth/callback` to the redirect URLs.

### Models and prices

Default models are defined in `src/lib/ai/registry.ts` (Claude, GPT-5.6, Gemini, Grok, DeepSeek and Hugging Face models — see `docs/MODELS.md`). Prices are filled in only where they were verified on the provider's page; the rest ship as `null` and Orbis shows "n/a" rather than inventing numbers. To set or correct prices (USD per 1M tokens) either by inserting rows into `model_registry` (which takes priority) or with:

```bash
NOVA_MODELS='[{"id":"openai:gpt-5.6-luna","provider":"openai","providerModelId":"gpt-5.6-luna","displayName":"GPT-5.6 Luna","capabilities":["chat","fast","low-cost"],"contextWindow":1050000,"inputPrice":0.2,"outputPrice":1.2,"lastVerifiedAt":"2026-10-19"}]'
```

(Example values only — copy real figures from the provider's pricing page.) Any OpenAI-compatible endpoint works through `OPENAI_BASE_URL`.

---

## Scripts

```bash
npm run dev         # development server
npm run build       # production build
npm start           # serve the production build
npm run lint        # ESLint (next/core-web-vitals + TypeScript)
npm run typecheck   # tsc --noEmit
npm test            # Vitest: unit, route-handler and RLS tests
npm run engine:test # pytest: engine security, AI Lab, Radar, workspaces, connectors, API
```

The test suite includes `tests/rls.test.ts`, which applies the real migration to an in-process Postgres (PGlite) with a minimal Supabase auth shim and verifies, as two different users, that private data can't be read, modified or forged.

---

## Architecture

Full design, alternatives and roadmap: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). The web app is a modular monolith on Next.js 16 (App Router, route handlers, `proxy.ts`), React 19, TypeScript, Tailwind CSS v4, Zod and Supabase.

```
src/
  app/
    (app)/            pages inside the app shell: dashboard, search, chat, battle,
                      models, discover, projects, settings, coming-soon sections
    api/              route handlers (search, chat, models, compare, comparisons,
                      discover, projects, notes, conversations, favorites, profile, status)
    auth/             email callback, sign-out
    login/
  components/         ui primitives (shadcn-style), layout, feature components
  hooks/              NDJSON streaming client, SSR-safe localStorage
  lib/
    ai/               provider interface, OpenAI-compatible + demo providers,
                      registry, router, chat modes, cost estimates
    search/           Tavily/Brave clients, normalisation, grounding + citations
    discovery/        Hugging Face Hub client with caching
    db/               data-access layer (always scoped to the current user)
    supabase/         server and browser clients
    auth.ts, usage.ts, rate-limit.ts, validation.ts, http.ts, env.ts
  proxy.ts            session refresh + protected-page redirects
supabase/migrations/  SQL schema and RLS
tests/                Vitest suites
engine/               Python Orbis engine
  nova_engine/
    api/              FastAPI app (all engine endpoints)
    lab/              planner, validator, executor, templates, tests, versions (Part 7)
    radar/            sources, analysis, alerts, digests (Part 8)
    workspace/        workspaces, permissions, community, import/export (Part 9)
    connectors/       catalog, OAuth, token vault, sync, conflicts (Part 9)
    security/         untrusted content, sensitive data, tool policy, SSRF guard, crypto
    worker.py         background passes (schedules, recovery, digests, retention)
  tests/              pytest suites
docs/                 Part 4, 5, 7, 8, 9 specs and Part 10 architecture
```

Key decisions:

- **One provider interface** (`AIProvider` in `lib/ai/types.ts`). OpenAI and Hugging Face Inference Providers both use the OpenAI-compatible Chat Completions API, so they share one implementation; adding Anthropic, Mistral, etc. means one new class.
- **Streaming as NDJSON** events (`meta`, `sources`, `notice`, `delta`, `done`, `error`) so the UI can show sources before the answer and surface warnings honestly.
- **Retrieved content is untrusted.** Sources and uploaded files are wrapped in delimiters with injected delimiter tags neutralised; system prompts tell the model to ignore instructions inside them; Markdown is rendered to React elements (no raw HTML) and only `http(s)` links are clickable.
- **Cache Components is off.** Nearly every page reads the session; plain dynamic rendering is the simpler reliable choice for now.
- **shadcn/ui style, hand-written.** `components/ui/primitives.tsx` follows shadcn conventions (owned source, Tailwind, `cn()`); the CLI can add more components later.

### Known limitations

- The rate limiter and discovery cache are in-memory, per server instance. On Vercel, replace them with a shared store (e.g. Upstash Redis) behind the same interface before relying on them.
- Chat attachments support text formats (`.txt .md .csv .json .tsv .log`, ≤ 500 KB, truncated to 60k chars). PDF/DOCX parsing is not implemented yet.
- Token counts are provider-reported when available; otherwise estimated (~4 chars/token) and labelled "(est.)".
- Model availability reflects configured credentials, not live provider status.
- Telegram/Discord/Slack bots, external connectors and payments are future work.

---

## Deploying to Vercel

1. Push this repository to GitHub and import it in Vercel (framework: Next.js; defaults are fine).
2. Add the environment variables from `.env.example` in Vercel → Settings → Environment Variables. Set `NEXT_PUBLIC_SITE_URL` to the production URL.
3. Apply the Supabase migration and add `https://<your-domain>/auth/callback` to Supabase's redirect URLs.
4. Set spending limits in the OpenAI / Hugging Face / Tavily dashboards in addition to Orbis's own quotas.
5. Deploy. Streaming routes declare `maxDuration = 60`; adjust to your Vercel plan.

### Observability

`src/lib/observability.ts` is the single error-reporting seam (logs server-side today). To enable Sentry: `npx @sentry/wizard@latest -i nextjs`, then forward `reportError` to `Sentry.captureException`.

---

## Next steps

1. Replace in-memory rate limiting and caching with a shared store; add per-user monthly budgets.
2. Verify model IDs and prices; add more providers (Anthropic, Mistral) behind `AIProvider`.
3. PDF/DOCX attachment parsing via Supabase Storage.
4. Claim DNA: fetch full pages (not just snippets) for checked sources; collect labelled data to measure evidence-linking precision (see docs).
5. Radar: scheduled checks (Vercel Cron or Supabase scheduled functions) on the existing `radar_tasks` table.
6. Playwright end-to-end tests against a Supabase test project.
