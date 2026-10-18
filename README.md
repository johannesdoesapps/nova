# NOVARA AI

**Discover Knowledge. Access AI. Turn Ideas into Action.**

NOVARA is an AI research and model-discovery platform: cited web search, a multi-mode chat assistant, side-by-side model comparisons, Hugging Face discovery and research projects — in one dark-first Next.js app backed by Supabase.

This repository is the **first milestone** (roadmap stages 1–2, plus the core of stage 3). Everything runs without any API keys in a clearly-labelled demo mode, and switches to real integrations as soon as the keys are set.

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
| Radar, What-If Simulator, AI Lab, Knowledge Graph, Community | 🕒 | Honest "Coming soon" pages. `radar_tasks` table exists. |

**Demo mode** (no keys): two simulated models make Chat, Search and Battle usable. Every simulated output starts with *"Demo mode — simulated response"* and carries a **Simulated** badge. Search never fabricates sources — without a search key it says that reliable web evidence could not be retrieved.

---

## Quick start

Requirements: Node.js ≥ 20.9 (tested with Node 22).

```bash
npm install
cp .env.example .env.local     # fill in whatever keys you have
npm run dev                    # http://localhost:3000
```

The app starts with zero configuration. Add keys incrementally:

| Variable | Needed for | Where to get it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`) | Accounts, history, projects, quotas | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SITE_URL` | Email confirmation redirect | Your deployed URL |
| `OPENAI_API_KEY` (optional `OPENAI_BASE_URL`) | OpenAI models | platform.openai.com |
| `HUGGINGFACE_API_KEY` | Open models via HF Inference Providers; higher Hub limits | Fine-grained token with "Make calls to Inference Providers" |
| `SEARCH_PROVIDER` (`tavily` \| `brave`), `SEARCH_API_KEY` | Live sources for AI Search / Research mode | tavily.com or brave.com/search/api |
| `NOVARA_MODELS` | Override the model list / set verified prices | See below |
| `NOVARA_MAX_COMPARE_MODELS`, `NOVARA_DAILY_REQUEST_LIMIT`, `NOVARA_RATE_LIMIT_PER_MINUTE` | Cost controls | Defaults: 3 / 200 / 20 |
| `SENTRY_DSN` | Optional error monitoring | See *Observability* |
| `NOVARA_TRIAL_SECRET` | Keeps blind-trial tokens valid across restarts / instances | Any long random string |
| `NOVARA_PRIVACY_PROFILES` | Verified provider data-handling facts used by the Model Directory and privacy-constrained routing | JSON keyed by provider, see `.env.example` |

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

Default models are defined in `src/lib/ai/registry.ts`: GPT-5 mini and GPT-5 (OpenAI) and gpt-oss-120b and Llama 3.3 70B Instruct (via Hugging Face Inference Providers). **Prices ship as `null`** — NOVARA shows "n/a" rather than inventing numbers. Check the model IDs against your provider accounts, then set verified prices (USD per 1M tokens) either by inserting rows into `model_registry` (which takes priority) or with:

```bash
NOVARA_MODELS='[{"id":"openai:gpt-5-mini","provider":"openai","providerModelId":"gpt-5-mini","displayName":"GPT-5 mini","capabilities":["chat","fast","low-cost"],"contextWindow":400000,"inputPrice":0.25,"outputPrice":2,"lastVerifiedAt":"2026-10-18"}]'
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
```

The test suite includes `tests/rls.test.ts`, which applies the real migration to an in-process Postgres (PGlite) with a minimal Supabase auth shim and verifies, as two different users, that private data can't be read, modified or forged.

---

## Architecture

A modular monolith on Next.js 16 (App Router, route handlers, `proxy.ts`), React 19, TypeScript, Tailwind CSS v4, Zod and Supabase.

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
4. Set spending limits in the OpenAI / Hugging Face / Tavily dashboards in addition to NOVARA's own quotas.
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
