# NOVA plans: costs, prices and margins

Last calculated **2026-10-19**, from the official API prices in `src/lib/ai/registry.ts` and the defaults in `src/lib/plans.ts`.

Admins can change every number below without code: **Admin → Plans & pricing**. The editor recalculates the budgets live. The finance dashboard (**Admin → Finance**) shows what actually happens.

## Recommendation

| Plan | Price (USD) | Yearly | Models | 5-hour / weekly units | AI budget / month | Margin |
| --- | --- | --- | --- | --- | --- | --- |
| **Free** | $0 | — | Standard: Claude Haiku 5.5, GPT-5.6 Luna | 10 / 30 | $0.10 (fixed) | paid for by subscribers ($1 each assumed) |
| **Pro** | **$20 / month** | $216 / year (10% off) | Standard and Advanced: adds Claude Sonnet 5.5, GPT-5.6 Terra | 200 / 1,100 | $4.66 (yearly: $4.27) | ≥ 60% |
| **Max** | **$100 / month** | $1,080 / year (10% off) | All: adds Claude Opus 5.5, GPT-5.6 Sol | 600 / 3,200 | $29.41 (yearly: $26.55) | ≥ 60% |

**Both proposed prices work at a 60% margin. Keep them.**

- No plan is unlimited. Each plan has a 5-hour allowance, a weekly allowance and a monthly AI budget.
- **Recommended yearly discount: 10%.** At 20%, Pro's AI budget falls to $3.65 a month, too small for Sonnet-heavy use. Every yearly discount is configurable.
- Premium models (Opus, Sol) are on Max only. On Pro they'd allow only about 119 typical requests a month, which would feel stingy.
- If you want Opus on Pro, Pro would have to cost about $36 for 200 Opus requests a month (the admin editor shows this calculation).

## Official model prices (USD per 1M tokens)

| Model | Tier | Input | Output | Source (checked 2026-10-19) |
| --- | --- | --- | --- | --- |
| Claude Haiku 5.5 | Standard | $0.10 | $0.50 | platform.claude.com/docs/en/about-claude/pricing |
| GPT-5.6 Luna | Standard | $0.20 | $1.20 | developers.openai.com/api/docs/models/gpt-5.6-luna |
| Claude Sonnet 5.5 | Advanced | $2 | $10 | platform.claude.com/docs/en/about-claude/pricing |
| GPT-5.6 Terra | Advanced | $2 | $12 | developers.openai.com/api/docs/models/gpt-5.6-terra |
| Claude Opus 5.5 | Premium | $4 | $20 | platform.claude.com/docs/en/about-claude/pricing |
| GPT-5.6 Sol | Premium | $4 | $20 | developers.openai.com/api/docs/models/gpt-5.6-sol |

Only models with a configured API key are offered. Today that means Anthropic and OpenAI.

## Cost per request

A request is one message with its conversation history, plus the reply. The cost estimate uses a conservative mix. Real traffic so far is far lighter: the median is 557 input and 34 output tokens.

- **Free / Pro:**
  - 60% short (1,500 in / 400 out)
  - 30% medium (6,000 / 1,200)
  - 10% long (12,000–20,000 / 1,200–2,400)
- **Max:**
  - 50% short
  - 30% medium (8,000 / 1,500)
  - 20% very long (40,000 / 4,800)
- Plus 10% for retries.

The average Pro request is about 5,000 input and 960 output tokens (`TYPICAL_REQUEST`).

| Model | Pro mix: per request | per 1,000 | Max mix: per request |
| --- | --- | --- | --- |
| Claude Haiku 5.5 | $0.00098 | $0.98 | $0.00211 |
| GPT-5.6 Luna | $0.00214 | $2.14 | $0.00458 |
| Claude Sonnet 5.5 | $0.0196 | $19.58 | $0.0422 |
| GPT-5.6 Terra | $0.0214 | $21.43 | $0.0458 |
| Claude Opus 5.5 / GPT-5.6 Sol | $0.0392 | $39.16 | $0.0845 |

## How the AI budget is calculated

```
revenue per month    = price (yearly: yearly price ÷ 12)
allowed costs        = revenue × (1 − 60%)
payment fees         = price × 3.6% + $0.30 per charge (yearly: ÷ 12)
other costs          = $0.50 hosting + $1.00 Free users' AI, per subscriber
AI budget            = (allowed costs − fees − other costs) × (1 − 15% safety buffer)
```

| | Pro monthly | Pro yearly | Max monthly | Max yearly |
| --- | --- | --- | --- | --- |
| Revenue / month | $20.00 | $18.00 | $100.00 | $90.00 |
| Allowed costs (40%) | $8.00 | $7.20 | $40.00 | $36.00 |
| Payment fees | $1.02 | $0.67 | $3.90 | $3.27 |
| Hosting + Free users | $1.50 | $1.50 | $1.50 | $1.50 |
| Safety buffer (15%) | $0.82 | $0.75 | $5.19 | $4.69 |
| **AI budget** | **$4.66** | **$4.27** | **$29.41** | **$26.55** |
| Profit if the whole budget is used | $12.00 (60%) | $10.80 (60%) | $60.00 (60%) | $54.00 (60%) |

The safety buffer is extra profit unless estimates turn out low. With typical use, most subscribers use far less than their budget, so the real margin is higher.

**What the budget buys per month (typical requests):**

| | Haiku | Luna | Sonnet | Terra | Opus / Sol |
| --- | --- | --- | --- | --- | --- |
| Free ($0.10) | 121 | 55 | — | — | — |
| Pro ($4.66) | 4,758 | 2,174 | 238 | 217 | (Max only) |
| Max ($29.41) | 13,925 | 6,424 | 696 | 642 | 348 |

The usage units are set so the weekly allowance matches the budget:

- Standard = 1 unit, Advanced = 20, Premium = 40 (roughly the cost ratio).
- Pro's 1,100 units a week ≈ 4,700 a month. That's about 4,700 Haiku requests or about 235 Sonnet requests, each roughly $4.6.
- Max's 3,200 units a week ≈ 13,700 a month. That's about 340 Opus requests, roughly $29.

## Assumptions to check

1. **Stripe fees, 3.6% + $0.30:** 2.9% + $0.30 for cards plus 0.7% for Stripe Billing, Stripe's standard US pricing. International cards cost more; the buffer covers some of that. Check your Stripe account's pricing.
2. **Hosting, $0.50 per subscriber per month:** an estimate. Set the real figure as (Vercel + Supabase bill) ÷ subscribers.
3. **Free users' cost, $1 per subscriber:** at $0.10 maximum per Free user, this covers 10 Free users per subscriber. The finance dashboard warns when Free costs more.
4. **Web search:** $0.01 per search (Pro: 100 a month, Max: 500), counted against the budget.
5. **Taxes:** prices exclude sales tax / VAT. Turn on Stripe Tax if you need it.

## What happens at the limits

| Situation | What happens |
| --- | --- |
| 80% of the monthly AI budget used | Economy mode: only the lowest-cost model on the plan. Users see why, and are offered Auto and the upgrade. |
| 100% of the budget | AI requests stop until the billing month renews. The reset date is shown. |
| 5-hour or weekly units used | Requests stop until the window resets. The time and an upgrade link are shown. |
| A model outside the plan | Refused (403 `plan_required`) with the plan that includes it and same-provider alternatives. Never silently switched. |

Administrators are exempt from all of these (`NOVA_ADMINS_UNLIMITED=false` turns the exemption off).
