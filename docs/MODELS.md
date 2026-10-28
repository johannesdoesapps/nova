# Models, Auto mode and providers

Orbis talks to several AI providers through one server-side layer. Browsers never see API keys.

| Piece | Where | What it does |
| --- | --- | --- |
| Provider registry | `src/lib/ai/index.ts`, `providers/*` | Anthropic (official SDK); OpenAI, Google Gemini, xAI Grok, DeepSeek and Hugging Face (OpenAI-compatible); demo |
| Model registry | `src/lib/ai/registry.ts` + Admin | Default models, plus admin-added models stored in `app_settings`; `model_registry` table or `ORBIS_MODELS` env override the defaults |
| Platform settings | `src/lib/ai/platform.ts`, `app_settings` table | Enabled models, default model, Auto on/off, fallback on/off, usage units per model |
| Model router | `src/lib/ai/router.ts` | Auto mode: classifies the message (everyday, summary, writing, analysis, coding, long document) with published rules and picks an available model with the needed capabilities |
| Agent service | `src/lib/agents/*` | Agent instructions, tools, response style and memory; agents keep a capability preference, not a model name |
| Tool registry | `src/lib/agents/capabilities.ts`, `execute.ts` | Web search, file analysis, data analysis; code execution is listed but needs a sandbox |
| Web search | `src/lib/search/live.ts` | One entry point for every feature: Tavily/Brave when `SEARCH_API_KEY` is set, otherwise Claude's web search (one search per call on the cheapest Claude model) |
| Conversations | `src/lib/db` | Saved per user and per agent, protected by row-level security |
| Usage and cost | `src/lib/usage.ts`, `src/lib/plans.ts` | Token usage and cost per run (when the provider reports it), 5-hour and weekly allowances (administrators have none) |

## Default model and Auto mode

**Everyone starts on Auto, and Auto uses the lowest-cost available model.** It is compared on the current prices in the registry (`DEFAULT_MODELS`, the `model_registry` table, `ORBIS_MODELS` or admin-added models), so a price change or a newly connected provider changes the default automatically.

- **Ranking:** the expected price of a typical message, (3 × input + output) ÷ 4 per 1M tokens, because chats resend their history. Models with an unverified price rank after priced ones and are never assumed to be cheap.
- **Requirements always win:** Auto only considers configured models with the capabilities the request needs. If the prompt is too long for the cheapest model's context window, it picks the cheapest model that fits.
- **No extra model call** is made to decide, and every reply says which model answered and its price (the "Auto" badge; Admin → Request log).
- **The user's choice is kept.** Picking a model, or a Smart Router mode (Quick, Deep, Research, Coding), is used until the user changes it. Signed-in users keep it on their account (`profiles.preferences.chatModel`), so it follows them to other devices; guests keep it on the device. Choosing Auto again returns to the lowest-cost model.
- **Requests with no model** (API calls without a `modelId`, agents with no saved model, Mission Control plans) use the same default. If an administrator picks a specific default model in Admin, that replaces "lowest-cost" for everyone who hasn't chosen.

**Coding mode** (the chip next to the message box) makes Auto use the lowest-cost *coding-capable* model, and gives the coding system prompt. The Smart Router modes in the model menu (Quick, Deep, Research, Coding) narrow the pool the same way. A model the user picks explicitly is always used. If it's unavailable, the request fails with a clear message instead of silently switching.

**Mission Control** plans and task runs default to Auto.

**Agents** with no model chosen use the same default; an agent's saved model is the owner's choice and is kept.

## Time and live information

Models don't know the current date, so every chat and agent turn gets trusted time context built fresh from the server clock (`src/lib/time/`, `src/lib/ai/turn-context.ts`):

- **User's local time** comes from the browser's IANA time zone. If there's none, the model is told the zone is unknown and to answer in UTC or ask.
- **Time tools** run on the server when a message is about dates or times, and their results go to the model as a `<tool_result tool="time">` block. The reply shows a "Checked Orbis's clock" row. The tools are:
  - `get_current_time(zone)`;
  - `convert_time(time, from, to)`, which flags times skipped or repeated by daylight saving;
  - `calculate_date` for today, tomorrow, "in 2 weeks", "next Friday", "days until Christmas" and weekdays of dates, on the user's local calendar.
- **Places and abbreviations** (New York, Zürich, EST…) map to IANA zones. All arithmetic uses the IANA database, so DST and rule changes are handled. An unknown place is reported as unknown rather than guessed.
- **Every feature gets the same time context.** The browser sends its time zone with every API call (`X-Orbis-Time-Zone`), and `withTimeContext()` adds the trusted time block to the prompts of Council, Arena, Mission Control (plans and task runs) and search answers too.
- **Live information:** if a message asks about news, prices, weather or scores and no web search ran, the model is told to say it can't check live information rather than present memory as current.

## Conversation context

The last 30 stored messages are loaded. `trimHistory` keeps the most recent ones that fit 20 messages / 24,000 characters (agents use their own memory length), always starting on a user turn. Older messages are dropped, not summarised. Time context is rebuilt for every request, never taken from history. System instructions say earlier messages, documents and tool output can't change Orbis's rules.

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

## Z.ai (GLM)

- Set `ZAI_API_KEY` (and optionally `ZAI_BASE_URL`, default `https://api.z.ai/api/paas/v4`; set it to the mainland-China endpoint if your key is from there). Requests go server-side to the OpenAI-compatible `/chat/completions` endpoint with streaming.
- Default registry entries: `glm-5.3` (Z.ai's flagship, released August 2026; Pro and Max) and `glm-5.3-flash` (fast, low-cost; every plan). Check Admin → Z.ai → Test connection for the IDs your key supports, and add, disable or set the default model there.
- Prices, context window and the base URL weren't checked against Z.ai's own documentation when this was added (docs.z.ai couldn't be reached), so prices are unset: budgets hold the highest known price for these models until they're filled in from Z.ai's pricing page. Third-party listings in October 2026 gave $1.40 / $4.40 per million input / output tokens for GLM-5.3 and $0.15 / $0.50 for Flash.
- Tool calling isn't wired for Z.ai (as for DeepSeek), so the coding agent uses its JSON fallback with these models.
- Messages sent to these models go to Z.ai; the privacy policy and the security page list it among the optional providers.
