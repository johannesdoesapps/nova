# Usage, limits and entitlements

All accounting happens on the server and in the database; nothing the browser sends can change what a user is allowed or charged.

## Who gets what (`src/lib/entitlements.ts`)

| Account | Allowance |
| --- | --- |
| Guest (not signed in) | Per-IP daily cap (`NOVA_DAILY_REQUEST_LIMIT`) |
| Free | 10 units per 5-hour window, 30 per week, $0.10 AI budget a month, standard models (`src/lib/plans.ts`) |
| Pro (active or trialing subscription) | 200 per 5 hours, 1,100 per week, $4.66 AI budget a month, standard and advanced models |
| Max (active or trialing subscription) | 600 per 5 hours, 3,200 per week, $29.41 AI budget a month, all models |
| Administrator (row in `public.admins`) | No allowance while `NOVA_ADMINS_UNLIMITED` isn't `false`. Runs are still recorded with `entitlement = admin_unlimited`, and duplicate submissions are still refused. |

Admin rights come only from the `admins` table, which has no insert policy: rows are added with SQL by an operator. Sign-up (email or Google) never creates one. Test accounts follow the same rules; give one Pro with a `subscriptions` row or admin rights with an `admins` row if a test needs more.

Every signed-in user also has the per-minute rate limit (`NOVA_RATE_LIMIT_PER_MINUTE`).

## What a request costs

- **Units by model tier:** standard 1, advanced 20, premium 40 (Admin → Plans & pricing; per-model overrides in Admin → Models). The monthly AI budget is checked as well; see docs/BILLING.md and docs/PRICING.md. Estimated cost in USD is recorded separately for each run (`estimated_cost`, from provider-reported tokens where available).
- **Tokens:** input and output tokens are provider-reported where available (`estimated = false`), otherwise estimated locally. Prompt-cache hits are recorded separately as `cached_input_tokens`. They're included in the input count, so the estimated cost is a slight over-estimate when the cache is used.
- **The model that actually answered is charged.** If Sonnet fails and a backup model answers, the backup's units are charged.
- **Refunds:** a call that failed before producing any output is charged 0 units. A reply cut off part-way is charged, because the provider bills it.
- **Not charged:** requests refused before a model ran (validation, limits, duplicates).

## How it's enforced (`src/lib/usage.ts`, migration `20261019130000_usage_ledger.sql`)

1. **Reserve.** Before calling a model, `usage_reserve_v2()` takes a per-user lock, checks the monthly AI budget (spend plus in-flight estimates), counts charged runs plus requests still in flight, and refuses if the request would exceed the 5-hour or weekly limit. Otherwise it places a hold for the request's units. Concurrent requests can't both slip under the limit.
2. **Idempotency.** Each submission carries a `requestId` (generated in the browser). A request id can be reserved only once, so a resent or double-submitted message returns 409 and is never run or charged twice.
3. **Charge.** `recordRun()` writes the run with its units, the requested model, the routing reason, tools used and the entitlement, then settles the hold.
4. **Release.** If the request fails before any model runs, the hold is released. Holds also expire on their own (3 minutes; 45 s for short checks), so a crashed request can't block a user.

**Tamper resistance:** users can insert their own `model_runs` rows (RLS), but negative units are rejected and `created_at` is always set by the server, so a backdated row can't move a window. Holds can only change through the functions. Runs can't be updated or deleted by users.

## Saving the allowance

Auto, and agents with no model chosen, keep to low-cost models:
- once 80% of the allowance is used; or
- when fewer units are left than two larger-model messages need.

On Free that second condition always holds, so one Free message can never use the whole 5-hour allowance by accident. A user who explicitly picks a larger model gets it. If they don't have enough units left, the error says how many that model needs and how many are left.

## Diagnostics

Admin → **Request log** (`/api/admin/diagnostics`, SQL `admin_request_log_v2`, admins only) shows, for each request:
- time, user, feature, and status;
- the model requested, the model that answered, and why (routing reason);
- tools used, fallbacks, latency, tokens, units, estimated cost and the redacted error.

It never shows prompts or replies.

The Supabase security advisor lists `usage_reserve`, `usage_finish`, `usage_status` and `admin_request_log_v2` as SECURITY DEFINER functions signed-in users can call. That is intentional:
- the usage functions only act on the caller's own rows (`auth.uid()`);
- `admin_request_log_v2` refuses anyone who isn't in `admins`.

`tests/usage-ledger.test.ts` covers both.
