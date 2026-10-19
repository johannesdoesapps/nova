# Billing, pricing and the AI budget guard

## Plans

| Plan | Price | Allowance |
| --- | --- | --- |
| Free | $0 | 15 units per 5 hours, 100 per week; AI budget $0.25/month (`NOVA_FREE_AI_BUDGET_USD`) |
| Pro | **$12 / month (USD)** | 150 units per 5 hours, 1,000 per week; AI budget $4.15/month |

Prices and limits live in `src/lib/plans.ts`.

## The 60% margin

At least 60% of each Pro payment must remain as profit after AI usage, payment fees and other per-subscriber costs (`TARGET_MARGIN`). The rest is the subscriber's monthly AI budget:

```
AI budget = price × (1 − 60%) − payment fee − other costs per subscriber
          = 12 × 0.4 − (12 × 2.9% + $0.30) − $0
          = 4.80 − 0.648 = $4.152
```

The fee and overhead figures can be changed without code:
- `NOVA_PAYMENT_FEE_PERCENT` (default 2.9) and `NOVA_PAYMENT_FEE_FIXED_USD` (default 0.30): **check them against your Stripe account's actual pricing**;
- `NOVA_OVERHEAD_PER_SUBSCRIBER_USD` (default 0): for example a share of hosting, divided by the number of subscribers.

Raising any of them lowers the AI budget, so the margin holds.

**Expected usage, from real production runs.** A Pro subscriber who uses the whole weekly allowance sends about 4,300 units a month.

| Usage | AI cost / month | Profit on $12 |
| --- | --- | --- |
| Auto: the lowest-cost model, Claude Haiku ($0.000156 per message) | about $0.67 | 89% |
| Always Claude Sonnet ($0.0129 per 15-unit message) | about $3.69 | 64% |
| Heavier than that | capped at $4.15 by the guard | ≥ 60% |

## The budget guard (`src/lib/budget.ts`)

Checked on the server before every AI request (chat, agents, Council, Arena, Mission Control, search, Truth Layer):

1. **Below 80%** of the month's AI budget, any model can be used.
2. **From 80%**, only the lowest-cost available model (what Auto picks). Other models are refused with a clear message.
3. **At 100%**, AI requests stop until the period renews.

The period is the Pro billing month, or the calendar month on Free. The app shows the share used under Settings → "Monthly AI budget", and a notice under the message box.

Spend is the recorded cost of each request. A run without a verified model price is counted at the most expensive verified price, so an unpriced model can't slip through.

Administrators have no budget. Optionally, `NOVA_MONTHLY_AI_BUDGET_USD` caps the whole site's AI spend per calendar month. It needs `SUPABASE_SERVICE_ROLE_KEY`; administrators are exempt.

The cheapest model is also the default for everyone (Auto = lowest-cost available model, see `docs/MODELS.md`). A model a user picks is kept until they change it.

## Stripe setup (one time)

1. Create a Stripe account at https://dashboard.stripe.com and finish activation. Start in **Test mode** to try it.
2. **Developers → API keys:** copy the **Secret key** (`sk_test_…`, later `sk_live_…`).
3. **Developers → Webhooks → Add endpoint:**
   - URL: `https://nova-supabase.vercel.app/api/stripe/webhook`;
   - events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused` and `customer.subscription.resumed`;
   - copy the **Signing secret** (`whsec_…`).
4. **Settings → Billing → Customer portal:** turn it on (lets subscribers cancel and change card).
5. **Supabase → Project Settings → API Keys:** copy the **secret / service_role** key. It lets the webhook mark a user as Pro; never share it.
6. **In Vercel → Settings → Environment Variables (Production, Sensitive)**, add:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `SUPABASE_SERVICE_ROLE_KEY`

   Then **redeploy**.

The Pro price ($12/month, "NOVA Pro") is created in Stripe automatically on the first checkout. To use a price you made yourself, set `STRIPE_PRICE_ID`.

Until all three keys are set, the pricing page says "Coming soon" and checkout is off.

## How it works

- **Upgrade:** `POST /api/billing/checkout` opens Stripe Checkout. The user ID goes into the subscription's metadata.
- **Manage subscription:** `POST /api/billing/portal` opens Stripe's billing portal.
- **The webhook is the only thing that changes a plan.** `POST /api/stripe/webhook` checks Stripe's signature, re-reads the subscription from Stripe (so retries and out-of-order events are harmless), and writes `public.subscriptions` with the service role.
- **Pro is active while the status is `active` or `trialing`.** A failed payment (`past_due`) falls back to Free until it's paid.
- Card details are handled entirely by Stripe.
