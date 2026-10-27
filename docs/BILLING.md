# Billing, pricing and the AI budget guard

## Plans

Free ($0), **Pro ($28/month)** and **Max ($153/month)**, in USD, plus tax where it applies. Yearly billing is 10% off ($302 and $1,652).

The numbers behind these prices, the 65% margin and the allowances are in **docs/PRICING.md**. Admins change prices, allowances, model tiers, costs and the margin in **Admin → Plans & pricing**, without code.

## The budget guard

Each paid plan's monthly AI budget is derived from its price, so 65% stays as profit after (and never falls below the plan's minimum AI budget: $5 Pro, $35 Max):
- AI usage,
- payment fees,
- hosting,
- Free users' cost,
- a 15% safety buffer.

Free has a fixed $0.10.

Enforcement happens on the server, atomically, before every AI request (`usage_reserve_v4`, under a per-user lock). It covers chat, agents, Council, Arena, Mission Control, search and Truth Layer:

1. **Plan access:** a model outside the plan is refused with an explanation. It is never switched silently.
2. **Budget:** the request's worst-case cost is checked against the budget. That cost is its input plus the longest reply the plan allows. Requests in flight count toward the budget too.
   - Advanced and premium models have their own part of the budget (Pro 60%, Max 85%). When it's used, those models are refused with the choice to wait, upgrade or switch to a fast model; Auto keeps working.
   - At **100%**, AI requests stop until the billing month renews.
3. **Caps:** at most $1 per request, at most 34% of the monthly budget per day (Pro, Max), messages per day (Free: 10), tokens per month, and 5-hour and weekly units.

The budget resets monthly on the billing date. Yearly plans also reset monthly. Free resets on the calendar month.

A run without a verified price is counted at the most expensive verified price. Web searches are added at $0.01 each.

`ORBIS_MONTHLY_AI_BUDGET_USD` (optional) or Admin → Plans & pricing → Spending protection caps the whole site's monthly spend; the emergency stop there pauses AI for everyone but administrators.

Stripe webhooks are processed once per event id (`stripe_events`); paid invoices and refunds are written to `billing_ledger`, which Finance uses for collected revenue.

## Stripe setup (one time)

1. Create a Stripe account at https://dashboard.stripe.com and finish activation. Start in **Test mode** to try it.
2. **Developers → API keys:** copy the **Secret key** (`sk_test_…`, later `sk_live_…`).
3. **Developers → Webhooks → Add endpoint:**
   - URL: `https://tryorbis.app/api/stripe/webhook`;
   - events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`, `invoice.payment_failed` and `refund.created`;
   - copy the **Signing secret** (`whsec_…`).
4. **Settings → Billing → Customer portal:** turn it on (lets subscribers cancel, change card and see invoices). Plan changes happen on Orbis's pricing page.
5. **Supabase → Project Settings → API Keys:** copy the **secret / service_role** key. It lets the webhook update a user's plan; never share it.
6. **In Vercel → Settings → Environment Variables (Production, Sensitive)**, add:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`
   - `SUPABASE_SERVICE_ROLE_KEY`

   Then **redeploy**.

The four prices (Pro and Max, monthly and yearly, products "Orbis Pro" and "Orbis Max") are created in Stripe automatically on first use. They are found by lookup key, for example `orbis_pro_month_usd_2000`. Changing a price in the admin creates a new Stripe price for new checkouts and plan changes; existing subscribers keep their price until they change plan.

Until all three keys are set, the pricing page says "Coming soon" and checkout is off.

## How it works

- **Subscribe:** `POST /api/billing/checkout` with `{plan: "pro" | "max", interval: "month" | "year"}` opens Stripe Checkout. The user ID goes into the subscription's metadata.
- **Change plan:** `POST /api/billing/change` with `{plan, interval}`.
  - **Upgrades** apply now, and the difference is charged pro-rata.
  - **Downgrades** apply now, and the unused part is credited to the next invoice.
  - **Free** cancels at the end of the paid period.
- **Manage subscription:** `POST /api/billing/portal` opens Stripe's billing portal (card, invoices, cancel).
- **The webhook keeps Orbis in sync.** Paid access is never granted from the checkout success page. `POST /api/stripe/webhook`:
  - handles each event once (`stripe_events`);
  - records paid invoices (excluding tax), refunds and failed payments in `billing_ledger`, which Finance uses for collected revenue;
  - checks Stripe's signature;
  - re-reads the subscription from Stripe, so retries and out-of-order events are harmless;
  - writes `public.subscriptions` (plan, interval, price, status, period) with the service role.
  - Renewals move the budget period; cancellations take effect at the period end.
- **A plan is active while its status is `active` or `trialing`.** A failed payment (`past_due`) falls back to Free limits until it's paid.
- Card details are handled entirely by Stripe.
