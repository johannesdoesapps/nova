# Models, Auto mode and providers

NOVA talks to several AI providers through one server-side layer. Browsers never see API keys.

| Piece | Where | What it does |
| --- | --- | --- |
| Provider registry | `src/lib/ai/index.ts`, `providers/*` | Anthropic (official SDK); OpenAI, Google Gemini, DeepSeek and Hugging Face (OpenAI-compatible); demo |
| Model registry | `src/lib/ai/registry.ts` + Admin | Default models, plus admin-added models stored in `app_settings`; `model_registry` table or `NOVA_MODELS` env override the defaults |
| Platform settings | `src/lib/ai/platform.ts`, `app_settings` table | Enabled models, default model, Auto on/off, fallback on/off, usage units per model |
| Model router | `src/lib/ai/router.ts` | Auto mode: classifies the message (everyday, summary, writing, analysis, coding, long document) with published rules and picks an available model with the needed capabilities |
| Agent service | `src/lib/agents/*` | Agent instructions, tools, response style and memory; agents keep a capability preference, not a model name |
| Tool registry | `src/lib/agents/capabilities.ts`, `execute.ts` | Web search, file analysis, data analysis; code execution is listed but needs a sandbox |
| Conversations | `src/lib/db` | Saved per user and per agent, protected by row-level security |
| Usage and cost | `src/lib/usage.ts`, `src/lib/plans.ts` | Token usage and cost per run (when the provider reports it), 5-hour and weekly allowances |

## Auto mode

Auto is a rule-based router, not a quality judge. It:

- never chooses a model whose provider isn't configured or that lacks a required capability;
- prefers low-cost models for everyday questions and summaries, reasoning models for analysis, and coding or writing models for those tasks;
- switches to low-cost models when the user has used 80% of their allowance;
- tells the user which model answered and why (the "Auto" badge on the reply).

## Fallback

Off by default. A backup model answers only when **both** the administrator (Admin → Backup models) and the user (Settings → Backup model) allow it. It only applies when the chosen model fails before sending any text, and only with a model that has the same key capabilities. The user is always told.

## Reliability

- Provider requests have timeouts (50 s per reply).
- One automatic retry for rate limits and server errors (Anthropic through the SDK; others in `openai-compatible.ts`).
- Errors are shown in plain language, and unavailable models explain what needs to be configured.

## DeepSeek

- Set `DEEPSEEK_API_KEY` (and optionally `DEEPSEEK_BASE_URL`) in the hosting environment; requests go server-side to `/chat/completions` with streaming and usage reporting.
- Default registry entries: `deepseek-flash` (fast, low-cost) and `deepseek-v4-pro` (reasoning). DeepSeek renames models between releases, so check Admin → DeepSeek → Test connection and add, disable or set the default model there; no code change is needed.
- Prices are left unset until verified on DeepSeek's pricing page (it varies by time of day).
- Every assistant replies in the language the user writes in, e.g. Chinese or English.
