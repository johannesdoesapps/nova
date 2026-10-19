# NOVA: API costs, usage limits and plan prices

Calculated on **2026-10-19**. The calculations are in code, not just in this document:

- request costs: `src/lib/ai/cost.ts`;
- scenarios and capacity: `src/lib/billing/scenarios.ts`;
- plan economics: `src/lib/plans.ts`.

The tests in `tests/plans-billing.test.ts` reproduce these numbers.

Admins can change every assumption in **Admin → Plans & pricing**, where a usage calculator shows the results live. **Admin → Finance** shows real costs, revenue and averages once people use NOVA.

## 1. Configured models and verified prices

These are the models in `src/lib/ai/registry.ts` that are live on this site (Anthropic and OpenAI keys are set). Prices were read on 2026-10-19 from the official pages:

- Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
- OpenAI: https://developers.openai.com/api/docs/pricing (standard tier)

| Model (API id) | Tier | Input | Cached input | Cache write | Output | Long prompts |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Haiku 5.5 (`claude-haiku-5-5`) | Standard | $0.10 | $0.01 | $0.125 | $0.50 | over 100k tokens: $0.50 / $2.50 |
| GPT-5.6 Luna (`gpt-5.6-luna`) | Standard | $0.20 | $0.02 | $0.25 | $1.20 | over 272k tokens: $0.40 / $1.80 |
| Claude Sonnet 5.5 (`claude-sonnet-5-5`) | Advanced | $2.00 | $0.10 | $2.50 | $10.00 | — |
| GPT-5.6 Terra (`gpt-5.6-terra`) | Advanced | $2.00 | $0.20 | $2.50 | $12.00 | over 272k tokens: $4 / $18 |
| Claude Opus 5.5 (`claude-opus-5-5`) | Premium | $4.00 | $0.20 | $5.00 | $20.00 | — |
| GPT-5.6 Sol (`gpt-5.6-sol`) | Premium | $4.00 | $0.40 | $5.00 | $20.00 | over 272k tokens: $8 / $30 |

All prices are USD per 1 million tokens. Cache-write prices are for 5-minute caching. Web search on either provider costs $10 per 1,000 searches. NOVA's own web search is configured at $0.01 per search.

The registry also lists Gemini, Grok and DeepSeek models. They aren't configured on this site, so they aren't offered or priced here.

## 2. How a request is costed

```
cost = (uncached input × input price + cache-write tokens × write price
        + cached input × cached price + output × output price) / 1,000,000
```

- **Token counts:** each call is costed from the token counts the provider reports.
- **Long prompts:** long-context prices apply when a prompt is above the provider's threshold.
- **OpenAI cache writes:** OpenAI doesn't report cache writes separately, so uncached OpenAI input is counted at the cache-write price. This is an upper bound, about 25% more than the input price.
- **Several calls per message:** every model call is recorded separately and shares the user message's request id.
  - Agents, Council, Arena and fallbacks can make several calls for one message.
  - Retries that produced output are charged; a call that failed before any output is recorded at no charge.
- **Web search:** each search adds $0.01 to its call.
- **Missing price:** a call without a verified price counts at the most expensive verified price.

Every call's cost is stored in USD in `model_runs.estimated_cost`. The record also includes:

- the provider and the model tier;
- input, output, cached and cache-write tokens;
- the plan, the request id and the tools used.

## 3. Cost per message and per volume

**Planning assumptions** (configurable):

| Setting | Value |
| --- | --- |
| Input tokens per call | 2,000 (conversation history included) |
| Output tokens per call | 800 |
| Model calls per user message | 1.05 (allows for agent steps, retries and fallbacks) |
| Cached input | 0% (conservative; real caching lowers costs) |
| Days per month | 30 |

**Messages and calls are counted separately.** A *message* is what the user sends. A *call* is one model request. Finance shows both.

| Model | Per message | Per 100 | Per 1,000 | Per 3,000 | 10/day: month | 50/day: month | 100/day: month | 300/day: month |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude Haiku 5.5 | $0.00063 | $0.06 | $0.63 | $1.89 | $0.19 | $0.94 | $1.89 | $5.67 |
| GPT-5.6 Luna | $0.00153 | $0.15 | $1.53 | $4.60 | $0.46 | $2.30 | $4.60 | $13.80 |
| Claude Sonnet 5.5 | $0.0126 | $1.26 | $12.60 | $37.80 | $3.78 | $18.90 | $37.80 | $113.40 |
| GPT-5.6 Terra | $0.0153 | $1.53 | $15.33 | $45.99 | $4.60 | $23.00 | $45.99 | $137.97 |
| Claude Opus 5.5 | $0.0252 | $2.52 | $25.20 | $75.60 | $7.56 | $37.80 | $75.60 | $226.80 |
| GPT-5.6 Sol | $0.0273 | $2.73 | $27.30 | $81.90 | $8.19 | $40.95 | $81.90 | $245.70 |

Daily cost is the monthly cost ÷ 30. For example, Opus at 100 messages a day costs $2.52 a day.

**Economical vs premium:**
- A premium model (Opus or Sol) costs about **40× a Claude Haiku message** and about **17× a GPT Luna message**.
- An advanced model (Sonnet or Terra) costs about 20× a Haiku message.
- Someone sending 300 premium messages a day would cost $227–$246 a month. That's more than any plan's price, which is why the limits below exist.

## 4. Prices and the 60% contribution margin

```
contribution margin = (revenue − variable costs) / revenue
revenue          = price, excluding tax collected for authorities, less expected refunds (2%)
allowed costs    = revenue × 40%
variable costs   = payment fees (3.6% + $0.30 per charge) + hosting ($0.50) + Free users' share ($1.00) + AI usage
AI budget        = (allowed costs − fees − hosting − Free share) × (1 − 15% safety buffer)
```

Fixed overhead isn't a variable cost, so it isn't in this formula. It's shown separately in Finance, as "operating result = contribution − fixed overhead". The contribution margin is not net profit.

| | Pro monthly | Pro yearly | Max monthly | Max yearly |
| --- | --- | --- | --- | --- |
| Price | **$20 / month** | $216 / year (10% off) | **$100 / month** | $1,080 / year (10% off) |
| Revenue / month (excl. tax, after refunds) | $19.60 | $17.64 | $98.00 | $88.20 |
| Allowed costs (40%) | $7.84 | $7.06 | $39.20 | $35.28 |
| Payment fees | $1.02 | $0.67 | $3.90 | $3.27 |
| Hosting + Free users' share | $1.50 | $1.50 | $1.50 | $1.50 |
| Safety buffer | $0.80 | $0.73 | $5.07 | $4.58 |
| **AI budget / month** | **$4.52** | **$4.15** | **$28.73** | **$25.94** |
| … of which advanced/premium models | $2.71 (60%) | $2.49 | $24.42 (85%) | $22.05 |
| Required profit (60%) | $11.76 | $10.58 | $58.80 | $52.92 |
| Contribution if the whole budget is used | $12.56 (64.1%) | $11.32 (64.2%) | $63.87 (65.2%) | $57.50 (65.2%) |

**Verdict: Pro $20 and Max $100 both sustain at least 60% contribution margin.** (On 2026-10-19 the owner changed Pro from $15 to $20 and Max from $110 to $100. Each plan's AI budget is derived from its price, so Pro's rose from $3.01 to $4.52 and Max's fell from $31.76 to $28.73.)

The margin holds because the server stops usage at the AI budget. Without that guard, no flat price would be safe: a Max user on Opus at 300 messages a day would cost $227 a month.

### Every scenario

These run 10, 50, 100 and 300 messages a day on each model the plan includes, with the guard applied:

| Plan | Model | 10/day | 50/day | 100/day | 300/day |
| --- | --- | --- | --- | --- | --- |
| Pro | Claude Haiku | 86.2% | 82.3% | 77.5% | 72.0% (capped) |
| Pro | GPT Luna | 84.8% | 75.4% | 64.1% (capped) | 64.1% (capped) |
| Pro | Claude Sonnet | 73.3% (capped at the advanced part) | 73.3% | 73.3% | 73.3% |
| Pro | GPT Terra | 73.4% (capped) | 73.4% | 73.4% | 73.4% |
| Max | Claude Haiku | 94.3% | 93.5% | 92.6% | 88.7% |
| Max | Claude Sonnet | 90.6% | 75.2% | 69.6% (capped) | 69.6% (capped) |
| Max | Claude Opus (premium only) | 86.8% | 69.6% (capped) | 69.6% | 69.6% |
| Max | GPT Sol (premium only) | 86.1% | 69.6% (capped) | 69.6% | 69.6% |

- Yearly plans give at least 64% in every scenario.
- The lowest result anywhere is **64.1%**: a Pro user sending 100 or more GPT Luna messages a day.
- All of these are checked in a test.

**Average cost per subscriber** depends on the mix of light, normal and heavy users. As an illustration only (not data): with 50% light (15/day), 35% normal (45/day) and 15% heavy (200/day) users, all on Auto (Haiku), it's about **$0.89 a month on Pro** and **$1.01 on Max**.

Use the real "AI cost per paying subscriber" in Finance after launch.

## 5. Recommended allowances

| | Free | Pro ($20) | Max ($100) |
| --- | --- | --- | --- |
| Models | Standard: Haiku, Luna | + Advanced: Sonnet, Terra | + Premium: Opus, Sol |
| Monthly AI budget | $0.10 | $4.52 | $28.73 |
| Advanced-model part | — | $2.71 | $24.42 |
| Messages / month, Auto (Haiku) | about 128 (weekly cap) | about 4,714 (157/day) | about 20,400 (680/day; token cap) |
| Messages / month, GPT Luna | about 65 | about 2,949 | about 18,700 |
| Messages / month, advanced models | — | about 176 (Terra) – 215 (Sonnet) | about 1,592 (Terra) – 1,938 (Sonnet) |
| Messages / month, premium models | — | — | about 894 (Sol) – 969 (Opus) |
| Mix: 80% Auto, 20% top model | — | about 884 | about 4,472 |
| Messages / day | 10 | no daily cap | no daily cap |
| Tokens / month | 400,000 | 15,000,000 | 60,000,000 |
| 5-hour / weekly units | 10 / 30 | 200 / 1,100 | 2,000 / 10,000 |
| Longest reply | 1,200 tokens | 2,400 tokens | 4,800 tokens |
| History sent per message | 12,000 characters | 24,000 characters | 80,000 characters |
| Web searches / month | 0 | 50 | 500 |
| Resets | calendar month | billing date, monthly | billing date, monthly (also on yearly plans) |

Message counts assume the planning message above and apply every cap (budget, advanced-model part, daily, token and weekly units), whichever comes first. Longer conversations use more of the allowance.

The pricing page shows these as "about" figures. Nothing is advertised as unlimited.

## 6. How the limits are enforced

All of this runs on the server, in `usage_reserve_v4`, under a per-user database lock. Nothing in the browser can change a limit. If the check itself fails (database error), paid and Free requests are refused rather than let through.

1. **Plan access:** a model outside the plan is refused with the plan that includes it and same-provider alternatives.
2. **Pre-request estimate:** the request's input plus the longest reply the plan allows, for every model call it makes.
3. **Holds:** that estimate is held against the budget while the request runs, so concurrent requests can't overspend.
4. **Monthly AI budget:** refuses a request when the budget is used up, or when its estimate exceeds what's left.
5. **Advanced-model part:** when it's used up, those models are refused. The user gets three options: wait for the reset date, upgrade, or switch to a fast model of the same provider. Their choice is never switched silently, and Auto keeps working.
6. **Per-request cap:** a single request whose estimate is above `maxRequestCostUsd` (default $1) is refused before any model runs.
7. **Daily spending cap:** a user can spend at most `dailyBudgetPct` of the monthly AI budget in one UTC day (Pro and Max: 34%, so a burst can't use the whole month in a day; Free: none, it has 10 messages a day).
8. **Site-wide emergency limit:** Admin → Plans & pricing → Spending protection. `siteMonthlyCapUsd` (0 = off) refuses everyone's AI requests once the site's recorded spend this month plus requests in flight would pass it. `NOVA_MONTHLY_AI_BUDGET_USD` does the same from the environment, but only once the Supabase service role key is set (it is not set today; use the admin setting). The **emergency stop** (`aiPaused`) pauses AI for everyone except administrators at once.
9. **Daily messages and monthly tokens** (where set), then the 5-hour and weekly units.
10. **Settlement:** the real cost is recorded from the provider's token counts and the hold is settled. A failed call with no output is released at no charge.

The pre-request estimate is stored next to the actual cost (`reserved_cost_usd`), so Admin → Finance → Health can compare them per provider.

### Auto routing

Auto picks the lowest-cost model the plan allows. It moves to the lowest-cost model with reasoning ability (Sonnet today) only when the request looks like hard coding or reasoning work, and never for summaries or long documents. It stays on the lowest-cost model once a user has used 80% of their budget or of its advanced part. A model the user picks themselves is always respected (or refused with an explanation); it is never swapped silently. Each run records the routing reason, the estimate and the actual cost.

**Alerts** appear in Admin → Finance. They cover:
- users at 80% or more of their budget;
- daily AI spend above twice the 7-day average;
- failed payments and past-due subscriptions;
- refunds above the assumed rate;
- plans below the target margin;
- Free users costing more than assumed.

## 7. Assumptions to check

1. **Stripe fees, 3.6% + $0.30 per charge:** card pricing plus Stripe Billing. International cards cost more. Check your Stripe account and adjust.
2. **Hosting, $0.50 per subscriber per month:** an estimate. Set it to (Vercel + Supabase bill) ÷ subscribers.
3. **Free users' cost, $1 per paying subscriber:** covers about 10 Free users at their full $0.10 each. Finance warns if Free costs more.
4. **Refunds, 2% of revenue.** Taxes: prices exclude tax (0%). With Stripe Tax, tax is added at checkout and recorded separately; it is never counted as revenue.
5. **Message size, 2,000 in / 800 out tokens and 1.05 calls per message:** illustrative.
   - Observed so far (test traffic only, not representative): a median of 557 input and 34 output tokens.
   - Replace with Finance's "avg tokens in/out" and "calls per message" once there's real usage.
6. **Fixed overhead** (salaries, tools, base plans) is $0 until you enter it. It's shown separately.
7. **Prices change.** Re-check both pricing pages before changing plan prices. The admin editor uses the prices in the registry.
