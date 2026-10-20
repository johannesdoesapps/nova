# Orbis AI: advanced audit and launch readiness

Date: 2026-10-19. Production: https://tryorbis.app (commit 4ef5114).

Everything marked "passed" below was executed. Anything not executed is marked as not tested, with the reason. No secrets appear in this report.

## 1. Condition at the start

The core product worked: sign-in, chat with 6 models, history, plans and limits. The audit found that the protections were incomplete:

- Free users could run Pro and Max models through side doors: Compare, Search, Verify, Claims and Intel.
- A user could release their own in-flight hold and run requests concurrently past their budget.
- If the usage check itself failed, the request ran anyway, unmetered.
- Web searches weren't counted or charged.
- A plan upgrade took effect before the pro-rated payment succeeded.
- Repeated Stripe webhooks were processed again, and there was no record of revenue.
- There was no per-request, daily or site-wide spending cap, and no emergency stop.
- Auto never chose a stronger model for hard tasks.
- Every Anthropic call paid for a prompt-cache write (1.25× input price) that was never read.
- Users saw raw provider error text and raw login errors.
- There was no password reset and no cross-site request protection.

## 2. Issues found, by severity

### Critical (all fixed)

| # | Issue | Fix |
| --- | --- | --- |
| C1 | Free users could run premium models via Compare, Search, Verify, Claims and Intel routes | Every AI route passes its models to the usage guard. A static test checks every route. |
| C2 | Releasing your own hold let concurrent requests overspend the budget | Holds count until they expire or the run is recorded |

### High

| # | Issue | Status |
| --- | --- | --- |
| H1 | The usage guard failed open on a database error | Fixed: it fails closed (502) |
| H2 | Web search was unmetered | Fixed: per-plan monthly searches, recorded at $0.01 each |
| H3 | An upgrade was granted before payment | Fixed: `pending_if_incomplete`; a failed payment returns 402 and nothing changes |
| H4 | Engine proxy allowed anonymous changes, model calls by anyone and `..` paths | Fixed: changes need sign-in; model calls are admin-only; paths validated |
| H5 | Webhook not idempotent; no revenue ledger | Fixed: `stripe_events` and `billing_ledger` |
| H6 | No per-request, daily or site cap, and no emergency stop | Fixed (section 6) |
| H7 | Agent replies stopped part-way were free | Fixed: the streamed text is charged |
| H8 | **Stripe is not configured in production**, so payments can't be taken or tested | **Open: launch blocker** |
| H9 | **No Terms of Service or Privacy Policy pages** | **Open: launch blocker** (legal text must come from you) |

### Medium

| # | Issue | Status |
| --- | --- | --- |
| M1 | Raw provider and login errors shown to users | Fixed |
| M2 | Wasted prompt-cache writes on every Anthropic call | Fixed: caching only for prompts of 16k+ characters |
| M3 | No CSRF defence | Fixed: cross-site API changes return 403 (live-tested) |
| M4 | No password reset | Fixed: live-tested |
| M5 | Auto listed models outside the plan on Free | Fixed: live-tested |
| M6 | Regenerate duplicated replies; attachments lost on retry | Fixed |
| M7 | Unbounded request body reads; non-UUID ids caused errors | Fixed |
| M8 | Message order could flip for identical timestamps | Fixed: `seq` column |
| M9 | Auto never escalated for hard tasks | Fixed: live-tested (the hard question went to Sonnet) |
| M10 | Supabase leaked-password protection is off | **Open**: a dashboard switch only you can turn on |
| M11 | No Content-Security-Policy header | **Open** |
| M12 | No Supabase service role key | **Open**. Without it: the env-based site cap is inactive (the admin setting works); provider-cost reconciliation is limited; a user who inserts a fake run with the id of a request that is still running can free that request's hold early, a limited burst at most. |
| M13 | Backups and point-in-time recovery depend on the Supabase plan | **Not verified** |
| M14 | Password-reset email uses Supabase's default email sender, which has low hourly limits | **Not verified**. A custom SMTP server is recommended. |

### Low

- Pre-request estimates are about 60× actual cost on average, because they assume the longest allowed reply. This is safe, but up to about 2% of a budget can't be used at the end of a month.
- No idempotency key on checkout creation.
- Site-cap query cost will grow with traffic.
- The emergency stop has no unit test.
- A reloaded chat can't re-send attachments when regenerating.
- /simulator and /graph are "Soon" placeholders.
- There are 44 unused indexes.
- npm audit: 5 high, all in dev-only tooling, and 0 in production dependencies.

## 3. Fixes and files

| Commit | Change | Files |
| --- | --- | --- |
| 207de72 | Plan checks on every AI endpoint | `src/app/api/{compare,search,verify,claims/*,intel/*}/route.ts`, `src/lib/usage.ts` |
| 207de72 | Metered search | `src/app/api/{search,verify,council/sources}/route.ts` |
| 207de72 | Safe provider errors | `src/lib/ai/providers/{errors,anthropic,openai-compatible}.ts` |
| 207de72 | Engine proxy hardening | `src/app/api/engine/[...path]/route.ts` |
| 207de72 | Byte-limited bodies | `src/lib/http.ts` |
| 207de72 | Paid-before-upgrade | `src/app/api/billing/change/route.ts` |
| 207de72 | Webhook idempotency and ledger | `src/app/api/stripe/webhook/route.ts`, `src/lib/billing/stripe.ts` |
| 207de72 | Cache only long prompts | `src/lib/ai/providers/anthropic.ts` |
| 207de72 | Holds count until recorded | `supabase/migrations/20261019210000_holds_count_until_recorded.sql` |
| 9b0e4a6 | Auto escalation | `src/lib/ai/router.ts`, `src/lib/ai/platform.ts` |
| 9b0e4a6 | Cost controls | `supabase/migrations/20261019230000_cost_controls.sql` (`usage_reserve_v4`), `src/lib/usage.ts`, `src/lib/plans.ts` |
| 9b0e4a6 | Health dashboard | `admin_finance_summary_v3`, `src/lib/billing/finance.ts`, `src/components/admin/finance-panel.tsx` |
| 9b0e4a6 | CSRF guard | `src/proxy.ts` |
| 9b0e4a6 | Password reset | `src/app/reset-password/page.tsx`, `src/components/common/{reset-password-form,login-form}.tsx` |
| 9b0e4a6 | Chat fixes | `src/hooks/use-chat.ts`, `src/lib/db/index.ts`, `supabase/migrations/20261019220000_messages_seq.sql` |
| 4ef5114 | Docs | `docs/PRICING.md`, `docs/USAGE.md`, `docs/BILLING.md` |

All migrations were applied to production. None of them deleted data.

## 4. Tests and results

| Suite | Result |
| --- | --- |
| Unit and integration tests (Vitest; real migrations on PGlite) | **419 passed, 0 failed** (27 files) at 9b0e4a6. The later commit changed docs only. |
| Type check, lint, production build | Passed |
| Live: public pages, links, sign-in errors, password reset, pricing | **28 / 28 passed** |
| Live: Free account | **11 / 11 passed**. Covers: locked models; Opus refused with 403 even when the UI is bypassed; daily limit message with upgrade; mobile; 22 app pages. |
| Live: Pro account | **16 / 17 passed**. Covers: Auto, manual Sonnet, stop generation, duplicate-request refusal, rename/search/delete, settings. The failing step (manual Luna) is a test-tool limitation: it can't read streamed replies. The database confirms Luna answered ("Chosen by the user"). |
| Live: administrator | **5 / 5 passed**. Covers: finance API, invalid settings rejected. |
| Live: models and routing | **13 / 13 passed**. Covers: all 6 models answer and stream; Auto easy → Haiku and hard → Sonnet; history kept when switching from Haiku to Luna; CSRF 403; test conversations deleted. |
| Live total | **73 of 74 steps passed.** The remaining step was verified in the database. Live tests cost **$0.012** in AI fees. |

### Not tested, and why

- **Stripe checkout, renewals, refunds and failed payments:** no Stripe keys in production. These are covered by unit tests with mocked Stripe only.
- **Load and concurrency against real Postgres:** load tests on production are prohibited, and there is no staging environment. Concurrency safety relies on a per-user database lock (`pg_advisory_xact_lock`), which was tested only sequentially in PGlite.
- **Password-reset email delivery:** the page and the link were tested; delivery was not.
- **Provider invoice reconciliation:** needs provider admin API keys.

## 5. Remaining risks

- Payment flows are unproven in production (H8).
- There is no staging environment, so tests run against production.
- Margins rest on assumptions until real traffic exists:
  - Stripe fees: 3.6% + $0.30
  - Hosting: $0.50 per subscriber
  - Free users' cost: $1 per subscriber
  - Refunds: 2%
- Provider prices can change. They were verified on 2026-10-19; check them again before changing plan prices.
- M10–M14 are still open.

## 6. Cost calculations (verified provider prices, USD per 1M tokens)

| Model | Input / output | Per message* | 100 messages/day for a month |
| --- | --- | --- | --- |
| Claude Haiku 5.5 | 0.10 / 0.50 | $0.00063 | $1.89 |
| GPT-5.6 Luna | 0.20 / 1.20 | $0.00153 | $4.60 |
| Claude Sonnet 5.5 | 2 / 10 | $0.0126 | $37.80 |
| GPT-5.6 Terra | 2 / 12 | $0.0153 | $45.99 |
| Claude Opus 5.5 | 4 / 20 | $0.0252 | $75.60 |
| GPT-5.6 Sol | 4 / 20 | $0.0273 | $81.90 |

\*Planning message: 2,000 tokens in, 800 out, 1.05 calls.

**Real data (30 days, mostly test traffic, not representative):**
- 79 messages from 4 users, $0.13 in total;
- an average of 842 input and 205 output tokens per call;
- **$1.65 per 1,000 messages**.

The recorded costs were checked by hand against the token counts.

**Plans.** "Worst case" is when a subscriber uses the whole AI budget; the server stops usage there.

| Plan | Monthly AI budget | Worst-case contribution margin |
| --- | --- | --- |
| Pro, $20 (raised from $15 on 2026-10-19) | $4.12 (after $0.47 set aside for code runs) | 63.7% |
| Max, $100 (lowered from $110 on 2026-10-19) | $26.74 (after $2.34 for code runs) | 64.8% |

The 60% margin is a target the limits enforce. It is not a guarantee, and it is not net profit: fixed overhead is $0 until you enter it. Full scenarios are in `docs/PRICING.md`.

**Proposed for your approval (nothing has been changed):**
1. Lower the per-request estimate. For example, use the plan's average reply length for budget checks and the maximum only for the per-request cap. That would free about 2% of each budget at month end.
2. Once 2–4 weeks of real traffic exist, replace the planning message size with the measured average. Then re-run the margin table in Admin → Plans.

## 7. Performance

Measured from Vercel's iad1 region (the same region as production). These are single samples, not a benchmark.

| Page | Time to first byte | Fully loaded |
| --- | --- | --- |
| / | 21 ms | 527 ms |
| /login | 4 ms | 563 ms |
| /chat | 3 ms | 446 ms |
| /pricing | 3 ms | 2,449 ms (content ready at 2,362 ms) |

/pricing is noticeably slower and worth profiling.

**Time to first token**, short prompt:

| Model | Time to first token |
| --- | --- |
| Claude Haiku | 2.66 s (first call, likely a cold start) |
| Claude Sonnet | 1.44 s |
| Claude Opus | 1.22 s |
| GPT Luna | 3.28 s |
| GPT Terra | 1.44 s |
| GPT Sol | 2.01 s |

**Production over 30 days:**
- model latency: median 1.0 s, 95th percentile 7.6 s;
- 6 errors in 79 calls, all from a retired model id that has since been replaced;
- Vercel runtime errors: none in the last 2 hours or the last 7 days.

## 8. Missing infrastructure

- Stripe:
  - secret key and webhook secret in Vercel (Sensitive);
  - the six price ids;
  - a webhook endpoint pointing at `/api/stripe/webhook`.
- Supabase service role key in Vercel (Sensitive).
- Supabase settings:
  - leaked-password protection (Auth → Providers → Email);
  - custom SMTP for auth emails;
  - confirm backups and point-in-time recovery on your plan.
- Terms of Service, Privacy Policy and refund policy pages (text from you or your lawyer).
- A staging environment (a second Supabase project plus a Vercel preview) so payment and load tests don't touch production.
- Error alerting to you, for example Vercel alerts or Sentry. Today errors are only visible in dashboards.
- Provider usage or admin API keys, to reconcile provider invoices against recorded costs.
- A Content-Security-Policy header.

## 9. Launch blockers

1. **Payments:** Stripe isn't configured, so no one can pay and the paid flow has never run in production. Configure Stripe in test mode, run checkout, renewal, failed payment and refund end to end, then switch to live keys.
2. **Legal pages:** Terms, Privacy and refunds must exist before collecting payments or personal data from the public.
3. **Account security basics:** turn on leaked-password protection and custom SMTP. Without custom SMTP, password-reset emails may not arrive under load.

## 10. Recommendation

**Not ready** for a public or paid launch, because of the blockers in section 9.

With the blockers fixed and Stripe's paid flow passing end to end in test mode, the evidence supports a **controlled launch**: invite-only, with the site-wide monthly cap set in Admin → Plans & pricing → Spending protection. The evidence for that:
- AI integration works for all 6 models;
- plan enforcement held against direct API bypass attempts;
- spending limits are in place;
- live testing passed 73 of 74 steps, and the remaining step was verified in the database.
