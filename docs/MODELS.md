# Models, Auto mode and providers

NOVA talks to several AI providers through one server-side layer. Browsers never see API keys.

| Piece | Where | What it does |
| --- | --- | --- |
| Provider registry | `src/lib/ai/index.ts`, `providers/*` | Anthropic (official SDK); OpenAI, Google Gemini, xAI Grok, DeepSeek and Hugging Face (OpenAI-compatible); demo |
| Model registry | `src/lib/ai/registry.ts` + Admin | Default models, plus admin-added models stored in `app_settings`; `model_registry` table or `NOVA_MODELS` env override the defaults |
| Platform settings | `src/lib/ai/platform.ts`, `app_settings` table | Enabled models, default model, Auto on/off, fallback on/off, usage units per model |
| Model router | `src/lib/ai/router.ts` | Auto mode: classifies the message (everyday, summary, writing, analysis, coding, long document) with published rules and picks an available model with the needed capabilities |
| Agent service | `src/lib/agents/*` | Agent instructions, tools, response style and memory; agents keep a capability preference, not a model name |
| Tool registry | `src/lib/agents/capabilities.ts`, `execute.ts` | Web search, file analysis, data analysis; code execution is listed but needs a sandbox |
| Conversations | `src/lib/db` | Saved per user and per agent, protected by row-level security |
| Usage and cost | `src/lib/usage.ts`, `src/lib/plans.ts` | Token usage and cost per run (when the provider reports it), 5-hour and weekly allowances (administrators have none) |

## Auto mode

Auto is a rule-based router, not a quality judge. It:

- never chooses a model whose provider isn't configured or that lacks a required capability;
- prefers low-cost models for everyday questions and summaries, reasoning models for analysis, and coding or writing models for those tasks;
- keeps to low-cost models once 80% of the allowance is used, or when fewer units are left than two larger-model messages need — always the case on Free, so one message can't use the whole 5-hour allowance (agents without a chosen model follow the same rule);
- tells the model the current date and time, in the user's browser time zone;
- tells the user which model answered and why (the "Auto" badge on the reply).

## Fallback

Off by default. A backup model answers only when **both** the administrator (Admin → Backup models) and the user (Settings → Backup model) allow it. It only applies when the chosen model fails before sending any text, and only with a model that has the same key capabilities. The user is always told.

## Reliability

- Provider requests have timeouts (50 s per reply).
- One automatic retry for rate limits and server errors (Anthropic through the SDK; others in `openai-compatible.ts`).
- Errors are shown in plain language, and unavailable models explain what needs to be configured.

## Default models and verified prices

Prices are USD per 1M tokens (input / output), checked on 2026-10-19 against each provider's own page (`priceSourceUrl` in the registry).

| Model | ID | Price | Notes |
| --- | --- | --- | --- |
| Claude Haiku 5.5 | `anthropic:claude-haiku-5-5` | 0.10 / 0.50 | |
| Claude Sonnet 5.5 | `anthropic:claude-sonnet-5-5` | 2 / 10 | |
| GPT-5.6 Luna | `openai:gpt-5.6-luna` | 0.20 / 1.20 | replaces GPT-5 mini |
| GPT-5.6 Terra | `openai:gpt-5.6-terra` | 2 / 12 | replaces GPT-5 |
| Gemini 3.8 Flash | `google:gemini-3.8-flash` | 0.75 / 3.75 | **Google raises this price on 1 Jan 2027** — update the registry then |
| Gemini 4 Argon | `google:gemini-4-argon` | 2 / 10 | **price rises on 1 Dec 2026**; not on Google's free tier |
| Grok 4.3 | `xai:grok-4.3` | 1.25 / 2.50 | needs `XAI_API_KEY` |
| Grok 4.7 | `xai:grok-4.7` | 2 / 6 | needs `XAI_API_KEY` |

### Retired models

OpenAI shuts down `gpt-5` and `gpt-5-mini` on 11 Dec 2026. `RETIRED_MODELS` in `registry.ts` maps their old IDs to the replacements above, so saved choices, agent defaults and old conversations keep working (old conversations still show the original model name). To retire another model, remove it from `DEFAULT_MODELS` and add it to `RETIRED_MODELS`.

## xAI (Grok)

- Set `XAI_API_KEY` (and optionally `XAI_BASE_URL`, default `https://api.x.ai/v1`); requests use the OpenAI-compatible `/chat/completions` endpoint with streaming and usage reporting.
- Check it in Admin → providers → Test connection.

## DeepSeek

- Set `DEEPSEEK_API_KEY` (and optionally `DEEPSEEK_BASE_URL`) in the hosting environment; requests go server-side to `/chat/completions` with streaming and usage reporting.
- Default registry entries: `deepseek-flash` (fast, low-cost) and `deepseek-v4-pro` (reasoning). DeepSeek renames models between releases, so check Admin → DeepSeek → Test connection and add, disable or set the default model there; no code change is needed.
- Prices are left unset until verified on DeepSeek's pricing page (it varies by time of day).
- Every assistant replies in the language the user writes in, e.g. Chinese or English.
