# Orbis deep audit

**Target:** https://tryorbis.app · **Repository:** `johannesdoesapps/nova`, branch `audit-2026-10-26` · **Date:** 26 October 2026

Machine-readable version: [`orbis-deep-audit.json`](./orbis-deep-audit.json) (same findings, generated from the same source).

## A. Summary

<!-- COUNTS -->
Critical: 0 · High: 1 · Medium: 13 · Low: 17 · Info: 5 · Total: 36

Status: fixed 13, partially fixed 5, open 17, fixed before this audit 1.
<!-- /COUNTS -->

**The most important result:** any signed-in user could have switched off AI for every Orbis user until the end of the month (**ORB-001**, High). Production has a $75 monthly AI cap. One user-written usage record above that amount would refuse every AI request on the site, administrators included. I found no sign that this has happened: the largest single run cost this month is $0.188. The fix is ready in two parts:
- **Code:** usage records are written by the server. This is committed, not deployed.
- **Database migration:** it revokes users' insert rights and is prepared, not applied.

Deploy the code first, then apply the migration.

What else changed on the audit branch:
- **Coding agent:** closed a shell-injection path in the browser check (**ORB-003**) and several ways around the command safe-list (**ORB-004**). Command output now redacts credentials with common variable names (**ORB-005**).
- **Connectors:** the Slack confirm card shows the real destination (**ORB-006**), Slack messages are never retried (**ORB-007**), and a confirmed action can't run twice (**ORB-008**).
- **Link reader:** a crafted page could block a server for minutes; parsing is now linear time (**ORB-009**).
- **Security tools:** the website-ownership proof for active scans is now exact and bound to the user it was issued to (**ORB-011**), and scheduled audits are capped and taken in turns (**ORB-012**).

What I could not fix without your decision:
- making usage reservations server-only (**ORB-002**, **ORB-014**);
- keeping `.env` files out of the project computer (**ORB-005**);
- routing files changed by agent commands through edit review (**ORB-010**);
- enabling Cards in Stripe (**ORB-027**, nobody can subscribe until then).

**Production was not changed.** Nothing was deployed, no migration was applied, no real user data was touched, no emails or payments were sent, and no load tests were run. The production checks were read-only:
- HTTP GETs and unauthenticated probes;
- read-only SQL;
- Vercel logs and environment variable names. Secret values were not read.

**App stores:** not ready to claim. The Capacitor shell exists (`mobile/`, see `docs/MOBILE_APPS.md`), but no iOS or Android build was produced or tested in this audit.

## B. Scope and method

| Area | How it was checked | Evidence level used |
| --- | --- | --- |
| Code (216 route handlers, 88 pages, 53 migrations) | Read end to end, split into three parallel reviews (authorization, AI/agents/execution, database). Every finding that went into a fix was checked again by me. | Code-verified |
| Database | All 53 migrations loaded into PGlite with Supabase's default privileges, then attacked as ordinary users (proof-of-concept tests, now regression tests) | Test-inferred |
| Production database | Read-only SQL: settings, counts, orphans, advisors | Observed |
| Production HTTP | Headers; unauthenticated request to every API method and route (262 pairs); public pages at 9 viewports | Observed |
| Production logs | Vercel runtime errors and logs, last 7 days | Observed |
| Signed-in UI | A local production build with a mock Supabase and a synthetic user ("Tester", `tester@example.com`) at 9 viewports | Observed (local) |
| Performance | Lighthouse 12.8.2 against production, mobile and desktop profiles | Observed |
| Fixes | Unit, engine and database regression tests; each one confirmed to fail on the old code and pass on the new | Test-inferred |

Evidence levels:
- **Observed:** seen directly.
- **Code-verified:** confirmed by reading the code path.
- **Test-inferred:** reproduced by an automated test against the real code or migrations, not production.
- **Unverified:** plausible, not confirmed.
- **N/A:** not applicable.

A test passing after a build is not counted as evidence; each regression test asserts the behaviour itself.

## C. System inventory

- **App:**
  - Next.js 16.4.2 (App Router) with React 19.3, Tailwind v4, on Vercel.
  - Database and auth: Supabase (Postgres with row-level security, PostgREST).
  - Payments: Stripe 23. Email: Resend.
- **Size:**
  - 88 page routes and 216 API route handlers;
  - 53 SQL migrations;
  - 74 public tables, all with row-level security on;
  - 31 SECURITY DEFINER functions, all with `search_path=''`;
  - 125 test files.
- **AI:** Anthropic, OpenAI-compatible and other providers behind one router. Every user-facing model route goes through `enforceLimits` (an atomic reservation), and usage is recorded per run.
- **Features audited:** chat (with link reader, memory, connectors), Orbis Code (coding agent with an isolated Vercel Sandbox computer, preview, browser check, GitHub sync), agents and workflows, security team (Sentinel, Guardian, Hunter, Aegis, Bastion), Mimic, billing (plans, credits, Stripe), teams, admin.
- **Mobile:** Capacitor 8 shell in `mobile/` that loads the website. Not built in this audit.

## D. Baseline and results after the fixes

| Check | Before (commit `da535ec`) | After (commit `83e39d6`) |
| --- | --- | --- |
| Unit, integration and database tests (`vitest run`) | 123 files, 1,712 passed | 125 files, 1,733 passed, 2 todo (known open issues), 0 failed |
| Type check (`tsc --noEmit`) | 0 errors | 0 errors |
| Lint (`eslint .`) | 0 errors, 2 warnings | 0 errors, 2 warnings (same two, in code not touched here) |
| Production build (`next build`) | passed | passed |
| `npm audit` | 0 vulnerabilities | not re-run (no dependency changes) |
| Secret scan (repository, history, production JavaScript) | Only test fixtures; production bundles contain no secret values | no new secrets added |

Dependencies were not upgraded. None are reported as vulnerable.

## E. All findings

<!-- FINDINGS-TABLE -->
| ID | Severity | Title | Status | Evidence |
|---|---|---|---|---|
| [ORB-001](#orb-001) | High | Any signed-in user could write their own usage records and shut off AI for every user | Fixed in code; database migration prepared, not applied | Code-verified, Test-inferred, Observed |
| [ORB-002](#orb-002) | Medium | Usage reservations trust caller-supplied estimates and let users release or settle their own holds | Partially fixed (migration prepared): hold estimates clamped to $5; release/settle bypass still open | Code-verified, Test-inferred |
| [ORB-003](#orb-003) | Medium | Shell injection through the coding agent's browser-check path, bypassing command approval | Fixed | Code-verified, Test-inferred |
| [ORB-004](#orb-004) | Medium | Coding-agent command safe-list could be bypassed (env prefix, nested shells, redirects, split rm flags) | Fixed | Code-verified, Test-inferred |
| [ORB-005](#orb-005) | Medium | Withheld secret files are reachable through commands; redaction missed common variable names | Partially fixed (redaction); .env still copied into the sandbox | Code-verified, Test-inferred |
| [ORB-006](#orb-006) | Medium | Slack action card showed an assistant-chosen channel name, not where the message goes | Fixed (card shows the channel id and labels the name as unchecked) | Code-verified, Test-inferred |
| [ORB-009](#orb-009) | Medium | Pasting a link to a crafted page could block a server instance for minutes (quadratic regex) | Fixed | Test-inferred |
| [ORB-010](#orb-010) | Medium | Files changed by agent commands are saved without Bastion's file checks or edit review | Open (design change); reduced by ORB-004 | Code-verified |
| [ORB-011](#orb-011) | Medium | Website-ownership proof for active scans could be bypassed | Fixed in code; token lock in the prepared migration | Code-verified, Test-inferred |
| [ORB-012](#orb-012) | Medium | Scheduled audits could be created directly in the audit table, past the cap and plan check | Partially fixed: per-user cap of 10 and round-robin order in the cron; entitlement re-check open | Code-verified, Test-inferred |
| [ORB-014](#orb-014) | Medium | Workspace reservations take their limits from the caller, so one user can block sandboxes site-wide | Open | Code-verified, Test-inferred |
| [ORB-015](#orb-015) | Medium | Mimic data wasn't deleted with the account | Fixed in the prepared migration | Code-verified, Test-inferred, Observed |
| [ORB-027](#orb-027) | Medium | Stripe checkout fails: no payment methods enabled | Open (Stripe dashboard) | Observed |
| [ORB-028](#orb-028) | Medium | GPT-5.6 Luna rejected coding-agent tool calls (Oct 20) | Fixed before this audit (commit 7a12f21) | Observed |
| [ORB-007](#orb-007) | Low | Slack chat.postMessage was retried after timeouts, so a message could be posted twice | Fixed | Code-verified, Test-inferred |
| [ORB-008](#orb-008) | Low | Confirmed connector actions were not idempotent | Fixed (best effort) | Code-verified, Test-inferred |
| [ORB-013](#orb-013) | Low | Users could flood the admin Bastion summary with fake decision rows | Fixed | Code-verified |
| [ORB-016](#orb-016) | Low | Newer tables still granted TRUNCATE to signed-in and anonymous roles | Fixed in the prepared migration | Test-inferred |
| [ORB-017](#orb-017) | Low | Site-cap queries scan all holds; holds are never purged; checkSiteCap loads up to 500k rows | Partially fixed (index in the prepared migration) | Code-verified, Observed |
| [ORB-018](#orb-018) | Low | Some server-owned columns are editable by the user | Partially fixed (security_targets); others open | Code-verified |
| [ORB-019](#orb-019) | Low | Forgeable analytics events and assistant messages | Open | Code-verified |
| [ORB-020](#orb-020) | Low | A chat turn is lost when the model fails mid-stream | Open | Code-verified |
| [ORB-021](#orb-021) | Low | Request cost estimate leaves out side context; auxiliary model calls aren't reserved | Open | Code-verified |
| [ORB-022](#orb-022) | Low | Backslash in a page URL returns a 500 in production | Open | Observed |
| [ORB-023](#orb-023) | Low | About 83 API routes validate the request body before authentication | Open | Observed |
| [ORB-024](#orb-024) | Low | Security headers: inline scripts allowed, HSTS without includeSubDomains, ACAO * on static pages | Open | Observed |
| [ORB-025](#orb-025) | Low | Leaked-password protection is off in Supabase Auth | Open (dashboard setting) | Observed |
| [ORB-029](#orb-029) | Low | Stripe webhook check-then-mark race; subscription sync without locking | Open | Code-verified |
| [ORB-033](#orb-033) | Low | Accessibility: sidebar history not keyboard-scrollable, alert role on a heading, share error page without a main landmark | Fixed | Observed, Test-inferred |
| [ORB-034](#orb-034) | Low | Accessibility: minor remaining issues (error screens without an h1, small text links, one obscured back link) | Open | Observed |
| [ORB-036](#orb-036) | Low | Homepage Largest Contentful Paint on mobile is above 2.5 s in lab tests | Open | Observed |
| [ORB-026](#orb-026) | Info | Rate limits are per server instance | Open | Code-verified |
| [ORB-030](#orb-030) | Info | Database housekeeping: 10 unindexed foreign keys, 37 unused indexes | Open | Observed |
| [ORB-031](#orb-031) | Info | Coding-agent 'never run' list can be satisfied by approval for some destructive forms | Fixed for the reported forms | Code-verified |
| [ORB-032](#orb-032) | Info | Guest mode skips model-tier checks (only when Supabase isn't configured) | Open (not applicable to production) | Code-verified |
| [ORB-035](#orb-035) | Info | CSP blocks a harmless eval probe from zod on every page | Open | Observed |
<!-- /FINDINGS-TABLE -->

## F. Security, authorization and AI agents

<!-- SECURITY-DETAILS -->
### ORB-003

**Shell injection through the coding agent's browser-check path, bypassing command approval**

- **Severity:** Medium · **Confidence:** High · **Evidence:** Code-verified, Test-inferred
- **Status:** Fixed
- **Where:** `src/lib/code/agent/tool-specs.ts:91-101`; `src/lib/code/preview.ts:149-163`; `src/lib/code/agent/tools.ts:722-746`
- **What:** check_preview accepted any path matching /^\/[^\s]*$/ and put it inside double quotes on a bash -c command line, where $(...) and backticks still expand. The handler didn't check plan approval or the commands setting.
- **Impact:** Prompt-injected repository content could make the agent run arbitrary commands in the user's project computer (e.g. delete files, alter the sync script) without the user's approval, even with commands turned off. Limited to the user's own isolated sandbox.
- **How it was shown:** Engine test: check_preview {path: '/$(rm${IFS}-rf${IFS}/vercel/sandbox/src)'} reached the preview stub on the old code (2 checks ran) and is refused on the new code.
- **Fix:** Path limited to URL characters (PREVIEW_PATH in src/lib/code/projects.ts) in the schema and again at the shell boundary, single-quoted; check_preview now requires plan approval and commands not 'off'.
- **Regression test:** tests/code-agent-engine.test.ts (ORB-003), tests/audit-2026-10-26.test.ts

### ORB-004

**Coding-agent command safe-list could be bypassed (env prefix, nested shells, redirects, split rm flags)**

- **Severity:** Medium · **Confidence:** High · **Evidence:** Code-verified, Test-inferred
- **Status:** Fixed
- **Where:** `src/lib/code/agent/policy.ts`
- **What:** `env` was classed as a read-only inspect command, so `env bash -c '...'` and `env node -e` ran without approval. Relative redirects (`echo x > .github/workflows/ci.yml`) and `git diff --output=` were allowed. `rm -r -f .` and `git -C . push` missed the never-run list.
- **Impact:** Agent-run commands could change files (including CI files) or run arbitrary scripts without the user's approval.
- **How it was shown:** classifyCommand('env bash -c "rm -rf src"') returned allow/inspect before the fix; now ask.
- **Fix:** env only allowed bare; nested shells and inline scripts ask; redirects into files and --output ask; split rm flags and git options before push are blocked.
- **Regression test:** tests/audit-2026-10-26.test.ts (ORB-004)

### ORB-005

**Withheld secret files are reachable through commands; redaction missed common variable names**

- **Severity:** Medium · **Confidence:** High · **Evidence:** Code-verified, Test-inferred
- **Status:** Partially fixed (redaction); .env still copied into the sandbox
- **Where:** `src/lib/secrets.ts:23`; `src/lib/code/workspace.ts:150-155`; `src/lib/bastion/guards.ts:57`
- **What:** read_files withholds .env, but the file is copied into the project computer and the secret-read guard is pattern based (`cat .e"n"v` passes). The redaction applied to command output needed a word boundary before the keyword, so DB_PASSWORD=, JWT_SECRET=, OPENAI_API_KEY= values went to the model unredacted.
- **Impact:** A project's own .env values could reach the AI provider and the run log.
- **How it was shown:** redactAll('DB_PASSWORD=hunter2222') returned the value unchanged before the fix.
- **Fix:** Done: the credential pattern now matches names inside longer variable names. Open (product decision): leave isSecretPath files out of the sandbox, or mount them unreadable to agent commands; this changes how users' dev servers get their environment.
- **Regression test:** tests/audit-2026-10-26.test.ts (ORB-005)
- **Needs your approval:** Decide whether the project computer should receive .env files

### ORB-010

**Files changed by agent commands are saved without Bastion's file checks or edit review**

- **Severity:** Medium · **Confidence:** High · **Evidence:** Code-verified
- **Status:** Open (design change); reduced by ORB-004
- **Where:** `src/lib/code/agent/engine.ts:337-347`; `src/lib/code/server.ts:376-396`
- **What:** After a command, changed and deleted files are synced straight into code_files without fileWriteOp (secret content, CI/deploy/migration files, bulk deletes) and regardless of 'review each edit'.
- **Impact:** An auto-allowed install script or approved command can change CI files that may later be pushed to GitHub, without per-edit review.
- **How it was shown:** Code path review; not exercised end to end.
- **Fix:** Run each synced change through the same gate as write_file (saveChanges with the Bastion gate), and queue changes as proposed edits when reviewEdits is on.
- **Needs your approval:** Behaviour change for the coding agent

### ORB-011

**Website-ownership proof for active scans could be bypassed**

- **Severity:** Medium · **Confidence:** High · **Evidence:** Code-verified, Test-inferred
- **Status:** Fixed in code; token lock in the prepared migration
- **Where:** `src/lib/security/authz.ts`; `supabase/migrations/20261019090000_security_center.sql:6-14,96`
- **What:** Users could rewrite their target's token over REST, and the check passed if the verification file or any TXT record merely contained the token (e.g. an SPF string). Tokens are also public once published, so another user's token could be copied.
- **Impact:** Sentinel could be pointed at sites the user doesn't control and crawl/probe them from Orbis infrastructure.
- **How it was shown:** Set token to 'v=spf1 include:_spf.google.com', verify against a domain with that SPF record (code path; not run against third parties).
- **Fix:** Token must have the server-issued format, belong to the first user it was issued to (service-role lookup), and appear exactly (whole line / whole record). Migration revokes UPDATE on security_targets except verified_at/verified_method. UI instructions updated.
- **Regression test:** tests/audit-2026-10-26.test.ts (ORB-011 matching), tests/audit-db.test.ts (ORB-011 token update refused)

### ORB-012

**Scheduled audits could be created directly in the audit table, past the cap and plan check**

- **Severity:** Medium · **Confidence:** High · **Evidence:** Code-verified, Test-inferred
- **Status:** Partially fixed: per-user cap of 10 and round-robin order in the cron; entitlement re-check open
- **Where:** `src/lib/security/scheduler.ts`; `supabase/migrations/20261019090000_security_center.sql:104`
- **What:** Users can insert security_audit rows with action 'schedule.set'; the daily cron used every such row and ran them in insertion order.
- **Impact:** One user could starve every other user's scheduled audits daily.
- **How it was shown:** Code path review.
- **Fix:** Cron now takes at most MAX_SCHEDULES per user and interleaves users. Open: re-check the Security agent entitlement in the cron, or move schedules to their own table written only by the route.
- **Regression test:** tests/audit-2026-10-26.test.ts (ORB-012 interleave)

### ORB-013

**Users could flood the admin Bastion summary with fake decision rows**

- **Severity:** Low · **Confidence:** Medium · **Evidence:** Code-verified
- **Status:** Fixed
- **Where:** `src/app/api/admin/bastion/route.ts`; `src/lib/bastion/view.ts:65`
- **What:** The admin summary read all users' bastion.* audit rows without checking Orbis's signature.
- **Impact:** Real denials could be pushed out of the administrator's view.
- **How it was shown:** Code path review.
- **Fix:** Only signed rows are summarised (when a signing key is configured).

### ORB-023

**About 83 API routes validate the request body before authentication**

- **Severity:** Low · **Confidence:** High · **Evidence:** Observed
- **Status:** Open
- **Where:** `e.g. /api/projects POST, /api/projects/[id]/notes POST`
- **What:** Unauthenticated requests with an empty body get 400 with field names instead of 401.
- **Impact:** Reveals request schemas to anonymous callers; no data exposure.
- **How it was shown:** Unauthenticated sweep of 262 method/route pairs: 83 x 400.
- **Fix:** Authenticate before parseJsonBody (as done for Mimic routes).

### ORB-024

**Security headers: inline scripts allowed, HSTS without includeSubDomains, ACAO * on static pages**

- **Severity:** Low · **Confidence:** High · **Evidence:** Observed
- **Status:** Open
- **Where:** `next.config / vercel headers`
- **What:** CSP has script-src 'unsafe-inline'; HSTS max-age=63072000 without includeSubDomains/preload; access-control-allow-origin: * on the prerendered homepage HTML. XFO DENY, nosniff, referrer-policy and permissions-policy are present.
- **Impact:** Weaker XSS defence in depth; no cookie-bearing API responses carry ACAO.
- **How it was shown:** curl -sI https://tryorbis.app/
- **Fix:** Move to nonce-based CSP; add includeSubDomains once every subdomain is HTTPS; drop ACAO on HTML.
- **Needs your approval:** includeSubDomains/preload affects every subdomain

### ORB-025

**Leaked-password protection is off in Supabase Auth**

- **Severity:** Low · **Confidence:** High · **Evidence:** Observed
- **Status:** Open (dashboard setting)
- **Where:** `Supabase advisor auth_leaked_password_protection`
- **What:** Supabase's HaveIBeenPwned check for new passwords is disabled.
- **Impact:** Users can choose known-breached passwords.
- **How it was shown:** Supabase security advisor (WARN).
- **Fix:** Enable it in Supabase Dashboard -> Authentication -> Password security.
- **Needs your approval:** Dashboard change

### ORB-026

**Rate limits are per server instance**

- **Severity:** Info · **Confidence:** High · **Evidence:** Code-verified
- **Status:** Open
- **Where:** `src/lib/rate-limit.ts`
- **What:** The per-minute and guest daily limits are in memory, so each Vercel instance counts separately. Database reservations remain the real cost limit.
- **Impact:** Limits are weaker than configured under load.
- **How it was shown:** Code review (the file says so).
- **Fix:** Move to a shared store (Postgres or Upstash) if abuse appears.

### ORB-031

**Coding-agent 'never run' list can be satisfied by approval for some destructive forms**

- **Severity:** Info · **Confidence:** Medium · **Evidence:** Code-verified
- **Status:** Fixed for the reported forms
- **Where:** `src/lib/code/agent/policy.ts BLOCKED`
- **What:** rm -r -f . and git -C . push fell through to 'ask'.
- **Impact:** Could run once approved; sandbox network is allow-listed.
- **How it was shown:** classifyCommand.
- **Fix:** Patterns extended (see ORB-004).
- **Regression test:** tests/audit-2026-10-26.test.ts

### ORB-035

**CSP blocks a harmless eval probe from zod on every page**

- **Severity:** Info · **Confidence:** High · **Evidence:** Observed
- **Status:** Open
- **Where:** `zod v4 allowsEval check (client bundle)`
- **What:** Chrome reports a CSP issue (script-src eval) on production pages: zod tries `Function("")` inside try/catch to decide whether it can compile validators, and falls back when blocked.
- **Impact:** Console/Lighthouse noise only; Best Practices 96 on /pricing because of it.
- **How it was shown:** Chrome DevTools Protocol Audits.issueAdded on https://tryorbis.app/pricing.
- **Fix:** Set z.config({ jitless: true }) once in client code to skip the probe.

<!-- /SECURITY-DETAILS -->

## G. Database, data integrity and billing

<!-- DATA-DETAILS -->
### ORB-001

**Any signed-in user could write their own usage records and shut off AI for every user**

- **Severity:** High · **Confidence:** High · **Evidence:** Code-verified, Test-inferred, Observed
- **Status:** Fixed in code; database migration prepared, not applied
- **Where:** `supabase/migrations/20261018000000_initial_schema.sql:243 (model_runs_insert_own)`; `src/lib/budget.ts:204-232 (checkSiteCap)`; `supabase/migrations/20261027100000_usage_limits_v5.sql:181-187`; `src/lib/usage.ts:453`
- **What:** model_runs rows were written through the user's own Supabase session, and the insert policy accepted any column values. Every row counts toward the site-wide monthly AI cap and toward the in-flight hold checks.
- **Impact:** Production has ORBIS_MONTHLY_AI_BUDGET_USD=75 (Observed, Vercel env). One REST insert of a row with estimated_cost >= 75 would refuse AI requests for every user, administrators included, until the month ends, and corrupt finance figures. A dummy row with an in-flight request_id also stopped that hold counting against the user's budget. No sign of exploitation: the largest run cost this month is $0.188 (Observed, read-only SQL).
- **How it was shown:** PGlite with all migrations and Supabase default privileges: as user A, insert model_runs(units=1, estimated_cost=999999); user B's next usage_reserve_v5 with a site cap returns {ok:false, scope:'site'}. Not run against production (it would cause the outage).
- **Fix:** Runs are now inserted with the service role (src/lib/supabase/admin.ts usageWriter; usage.ts, code/meter.ts, code/server.ts). Migration 20261109000000_audit_hardening.sql revokes INSERT on model_runs from anon/authenticated and drops the insert policy. Deploy the code first, then apply the migration.
- **Regression test:** tests/audit-db.test.ts (ORB-001 x2), tests/rls.test.ts
- **Needs your approval:** Apply migration 20261109000000_audit_hardening.sql to production after deploying the code

### ORB-002

**Usage reservations trust caller-supplied estimates and let users release or settle their own holds**

- **Severity:** Medium · **Confidence:** High · **Evidence:** Code-verified, Test-inferred
- **Status:** Partially fixed (migration prepared): hold estimates clamped to $5; release/settle bypass still open
- **Where:** `supabase/migrations/20261027100000_usage_limits_v5.sql:158,181-187`; `supabase/migrations/20261019130000_usage_ledger.sql:181-191 (usage_finish)`; `usage_credit_settle (usage ledger migrations)`
- **What:** usage_reserve_v5 is callable by any signed-in user with their own p_est_cost_usd, and active holds count toward the site cap. usage_finish(id,'released') and usage_credit_settle are callable directly, so a user can free their own holds early and overdraw credits (floored at 0).
- **Impact:** One huge hold refused all users for up to 10 minutes, renewable. Credits: 20 units used against a balance of 10 (Test-inferred).
- **How it was shown:** PGlite PoC: reserve(est=999999) as user A, then user B's reserve with site cap 5000 fails; reserve 10 credit units, usage_finish('released'), reserve 10 more, settle both: balance 0 after 20 units used.
- **Fix:** Done: BEFORE INSERT/UPDATE trigger clamps usage_holds.est_cost_usd to $5 unless the JWT role is service_role. Remaining (needs a billing refactor and your approval): make reserve/finish/settle callable only by the service role with an explicit p_user_id, server-side estimates, and require state='active' in usage_credit_settle.
- **Regression test:** tests/audit-db.test.ts (ORB-002 clamp; release/settle as it.todo)
- **Needs your approval:** Billing refactor (reservations made only by the server) and production migration

### ORB-014

**Workspace reservations take their limits from the caller, so one user can block sandboxes site-wide**

- **Severity:** Medium · **Confidence:** High · **Evidence:** Code-verified, Test-inferred
- **Status:** Open
- **Where:** `supabase/migrations/20261020020000_code_workspace.sql:179-229`
- **What:** code_workspace_reserve is executable by signed-in users and accepts p_user_limit, p_site_limit and p_site_concurrent from the caller.
- **Impact:** Repeated calls add 60-minute blocks and fake live sessions; other users get 'busy' or 'site limit reached'.
- **How it was shown:** PGlite PoC: 5 direct calls by one user, then another user's reservation returns {ok:false, reason:'busy'}.
- **Fix:** Read the limits inside the function from server-side settings, or make it callable only by the service role (with p_user_id).
- **Regression test:** tests/audit-db.test.ts (ORB-014, it.todo)
- **Needs your approval:** Production migration + code change

### ORB-015

**Mimic data wasn't deleted with the account**

- **Severity:** Medium · **Confidence:** High · **Evidence:** Code-verified, Test-inferred, Observed
- **Status:** Fixed in the prepared migration
- **Where:** `supabase/migrations/20261108000000_mimic.sql`
- **What:** The seven mimic_* tables had no foreign key to auth.users with ON DELETE CASCADE.
- **Impact:** Invoice text and drafts would be left behind after account deletion, against the privacy policy. Production currently has no Mimic rows and no orphans (Observed).
- **How it was shown:** PGlite: delete an auth user with a mimic_documents row; the row remained.
- **Fix:** NOT VALID foreign keys with ON DELETE CASCADE on all seven tables (no existing rows touched).
- **Regression test:** tests/audit-db.test.ts (ORB-015)
- **Needs your approval:** Apply migration

### ORB-027

**Stripe checkout fails: no payment methods enabled**

- **Severity:** Medium · **Confidence:** High · **Evidence:** Observed
- **Status:** Open (Stripe dashboard)
- **Where:** `Vercel runtime logs: 'No valid payment method types'`
- **What:** Get Pro shows 'Something went wrong' because the Stripe account has no payment method types enabled.
- **Impact:** Nobody can subscribe.
- **How it was shown:** Click Get Pro on /pricing (observed earlier this session).
- **Fix:** Enable Cards in Stripe -> Settings -> Payment methods, then retry.
- **Needs your approval:** Stripe dashboard change (yours)

### ORB-016

**Newer tables still granted TRUNCATE to signed-in and anonymous roles**

- **Severity:** Low · **Confidence:** High · **Evidence:** Test-inferred
- **Status:** Fixed in the prepared migration
- **Where:** `supabase/migrations/20261104000000_code_reviews.sql:56`
- **What:** The blanket revoke ran before mimic_* and bastion_workspace_roles existed. TRUNCATE ignores RLS; PostgREST cannot issue it, so this is defence in depth.
- **Impact:** Only reachable through a direct database connection as those roles.
- **How it was shown:** PGlite: user B truncated user A's mimic_events.
- **Fix:** Revoke on those tables and in default privileges.
- **Regression test:** tests/audit-db.test.ts (ORB-016)
- **Needs your approval:** Apply migration

### ORB-018

**Some server-owned columns are editable by the user**

- **Severity:** Low · **Confidence:** Medium · **Evidence:** Code-verified
- **Status:** Partially fixed (security_targets); others open
- **Where:** `supabase/migrations/20261022030000*.sql (code_agent_runs)`; `supabase/migrations/20261021000000_connectors.sql (connector_accounts.write_enabled, scopes)`
- **What:** code_agent_runs token_budget/usage/report/step_limit, connector_accounts.write_enabled/scopes, and security_targets.verified_at can be changed over REST.
- **Impact:** Mostly bounded by check constraints and server re-checks; weakens the app's own consent step for connector write access.
- **How it was shown:** Code review.
- **Fix:** Move these columns to service-role or definer-function updates.

### ORB-019

**Forgeable analytics events and assistant messages**

- **Severity:** Low · **Confidence:** Medium · **Evidence:** Code-verified
- **Status:** Open
- **Where:** `product_events and messages insert policies`
- **What:** Users can insert any allowed product_events, and messages with role='assistant', which then show in their own public share links.
- **Impact:** Fake admin metrics; a shared chat can show text Orbis never wrote (only in the sharer's own conversation).
- **How it was shown:** Code review.
- **Fix:** Restrict role on insert to 'user' (server writes assistant messages with the service role), and record analytics server-side.

### ORB-021

**Request cost estimate leaves out side context; auxiliary model calls aren't reserved**

- **Severity:** Low · **Confidence:** Medium · **Evidence:** Code-verified
- **Status:** Open
- **Where:** `src/app/api/chat/route.ts:65`; `src/lib/connectors/chat.ts:25`; `src/lib/search/live.ts:78`
- **What:** The estimate covers message, attachments and history, not linked pages, connector docs or memory (up to ~60k chars); the connector planner and Claude-backed search are recorded afterwards but not reserved.
- **Impact:** maxRequestCostUsd can be exceeded somewhat.
- **How it was shown:** Code review.
- **Fix:** Include side context in the estimate and reserve auxiliary calls.

### ORB-029

**Stripe webhook check-then-mark race; subscription sync without locking**

- **Severity:** Low · **Confidence:** Medium · **Evidence:** Code-verified
- **Status:** Open
- **Where:** `src/app/api/stripe/webhook/route.ts:36,116`; `syncSubscription`
- **What:** eventSeen is checked first and markEvent written last, so two simultaneous deliveries are both processed; writes are mostly idempotent via unique keys.
- **Impact:** Rare duplicate processing.
- **How it was shown:** Code review.
- **Fix:** Insert the stripe_events row first (unique) and skip on conflict.

### ORB-030

**Database housekeeping: 10 unindexed foreign keys, 37 unused indexes**

- **Severity:** Info · **Confidence:** High · **Evidence:** Observed
- **Status:** Open
- **Where:** `Supabase performance advisors`
- **What:** Reported by Supabase advisors.
- **Impact:** Slower deletes/joins as data grows; unused index write cost.
- **How it was shown:** Supabase advisors.
- **Fix:** Add covering indexes for hot foreign keys; review unused indexes after more traffic.

### ORB-032

**Guest mode skips model-tier checks (only when Supabase isn't configured)**

- **Severity:** Info · **Confidence:** Medium · **Evidence:** Code-verified
- **Status:** Open (not applicable to production)
- **Where:** `src/lib/usage.ts:149-153`; `src/lib/ai/index.ts:164`
- **What:** With Supabase unconfigured and guest AI allowed, guests can pick premium models and limits are per instance.
- **Impact:** None in production (Supabase is configured).
- **How it was shown:** Code review.
- **Fix:** Apply tier checks to guests too.

<!-- /DATA-DETAILS -->

## H. Integrations, reliability, performance and accessibility defects

<!-- INTEGRATION-DETAILS -->
### ORB-006

**Slack action card showed an assistant-chosen channel name, not where the message goes**

- **Severity:** Medium · **Confidence:** High · **Evidence:** Code-verified, Test-inferred
- **Status:** Fixed (card shows the channel id and labels the name as unchecked)
- **Where:** `src/lib/connectors/providers/slack.ts:68-81`; `src/components/connectors/action-card.tsx:24-29`
- **What:** The confirm card displayed channelName and text; the real destination `channel` was hidden but kept as proposed.
- **Impact:** Injected page or email content could make the card read '#team-updates' while Confirm posts private content to another conversation.
- **How it was shown:** Proposal {channel:'D0ATTACKER', channelName:'team-updates'} rendered as 'Post … in #team-updates'.
- **Fix:** Card now shows the channel id as the destination and marks the name as unverified. A full fix (resolve the name with conversations.info) needs the channels:read/im:read scopes, so users would have to reconnect Slack.
- **Regression test:** tests/audit-2026-10-26.test.ts (ORB-006/007/008)
- **Needs your approval:** Optional: add Slack read scopes to show verified names

### ORB-009

**Pasting a link to a crafted page could block a server instance for minutes (quadratic regex)**

- **Severity:** Medium · **Confidence:** High · **Evidence:** Test-inferred
- **Status:** Fixed
- **Where:** `src/lib/links/parse.ts:50-62`; `src/lib/connectors/http.ts (htmlToText)`
- **What:** Backreference and lazy regexes over up to 2 MB of HTML rescanned to the end for every unclosed tag.
- **Impact:** Measured locally: 200 KB of repeated '<main>x' took 5,052 ms (synchronous). After the fix, 2 MB hostile inputs of 8 shapes each take under 40 ms.
- **How it was shown:** readablePage('<main>x'.repeat(28571), 'text/html').
- **Fix:** Linear-time stripElements/stripComments/titleOf/mainElement, bounded tag regexes, and a 400 KB cap before parsing.
- **Regression test:** tests/audit-2026-10-26.test.ts (ORB-009 timing and output)

### ORB-028

**GPT-5.6 Luna rejected coding-agent tool calls (Oct 20)**

- **Severity:** Medium · **Confidence:** High · **Evidence:** Observed
- **Status:** Fixed before this audit (commit 7a12f21)
- **Where:** `src/lib/ai/providers/openai-compatible.ts:134`
- **What:** 115 errors for 23 users on 20 October, none since.
- **Impact:** Coding-agent runs failed for those users that day.
- **How it was shown:** Vercel runtime errors (7 days).
- **Fix:** reasoning_effort 'none' for tool calls.

### ORB-007

**Slack chat.postMessage was retried after timeouts, so a message could be posted twice**

- **Severity:** Low · **Confidence:** High · **Evidence:** Code-verified, Test-inferred
- **Status:** Fixed
- **Where:** `src/lib/connectors/providers/slack.ts:29`; `src/lib/connectors/http.ts:74-91`
- **What:** slackApi used the default 2 retries on network errors, the 15 s timeout and 502/503/504; every other write action already passed retries: 0.
- **Impact:** A slow Slack response could post the same message two or three times.
- **How it was shown:** Fetch stub that always fails: chat.postMessage was attempted 3 times before; now once.
- **Fix:** chat.postMessage is never retried; reads still are.
- **Regression test:** tests/audit-2026-10-26.test.ts (ORB-006/007/008)

### ORB-008

**Confirmed connector actions were not idempotent**

- **Severity:** Low · **Confidence:** High · **Evidence:** Code-verified, Test-inferred
- **Status:** Fixed (best effort)
- **Where:** `src/app/api/connectors/actions/route.ts`
- **What:** The route ran the action and only afterwards marked the proposal done; it never checked whether the proposal was already done.
- **Impact:** A double click or client retry could send an email, create an issue or post a message twice.
- **How it was shown:** Two POSTs with the same messageId/proposalId both ran the action.
- **Fix:** Before running, the route refuses a proposal that is done or started in the last 5 minutes, and records startedAt. A millisecond race between two simultaneous requests remains; a database-level claim would close it.
- **Regression test:** tests/audit-2026-10-26.test.ts (ORB-006/007/008: proposal runs once)

### ORB-017

**Site-cap queries scan all holds; holds are never purged; checkSiteCap loads up to 500k rows**

- **Severity:** Low · **Confidence:** High · **Evidence:** Code-verified, Observed
- **Status:** Partially fixed (index in the prepared migration)
- **Where:** `supabase/migrations/20261027100000_usage_limits_v5.sql:184`; `src/lib/budget.ts:213`
- **What:** Each reservation sums active holds site-wide with no suitable index; nothing deletes old holds. checkSiteCap sums in Node.
- **Impact:** Slower reservations as data grows. Today: 432 holds, 353 runs this month (Observed), so no current impact.
- **How it was shown:** Code review.
- **Fix:** Partial index usage_holds(expires_at) where state='active' added. Open: purge holds older than a day; sum in SQL.

### ORB-020

**A chat turn is lost when the model fails mid-stream**

- **Severity:** Low · **Confidence:** High · **Evidence:** Code-verified
- **Status:** Open
- **Where:** `src/app/api/chat/route.ts:302-329,368`
- **What:** On a mid-stream error the route records the run and rethrows; the user message and partial reply are not saved.
- **Impact:** The user's message disappears from history even though usage is recorded.
- **How it was shown:** Code review.
- **Fix:** Save the user message and partial assistant text with an error flag in the catch path.

### ORB-022

**Backslash in a page URL returns a 500 in production**

- **Severity:** Low · **Confidence:** High · **Evidence:** Observed
- **Status:** Open
- **Where:** `Next.js routing on Vercel (before src/proxy.ts runs)`
- **What:** GET https://tryorbis.app/pricing%5C returned 500 (Observed today); Vercel logs show MODULE_NOT_FOUND. The local production build returns 404 for the same URL.
- **Impact:** Error noise and alerts; no data exposure.
- **How it was shown:** curl -s -o /dev/null -w '%{http_code}' 'https://tryorbis.app/pricing%5C' -> 500
- **Fix:** A proxy redirect was tried and reverted: Next.js resolves %5C paths before the proxy runs (locally even /api/models%5C skipped the proxy). Options: a Vercel-level redirect rule for paths containing %5C, or an upstream Next.js report.

### ORB-033

**Accessibility: sidebar history not keyboard-scrollable, alert role on a heading, share error page without a main landmark**

- **Severity:** Low · **Confidence:** High · **Evidence:** Observed, Test-inferred
- **Status:** Fixed
- **Where:** `src/components/studio/sidebar.tsx`; `src/components/workforce/task-view.tsx`; `src/components/workspaces/share-view.tsx`
- **What:** axe (WCAG 2.2 AA + best practice) on the signed-in sweep: scrollable-region-focusable (serious) on 12 routes where the sidebar's history area shrinks and overflows with only text; aria-allowed-role on the workforce task error; landmark-one-main/region on the share error page.
- **Impact:** Keyboard-only users couldn't scroll the history area on those pages; screen readers got a wrong role and no main landmark.
- **How it was shown:** Local production build, axe 4.x at 390 and 1440 px.
- **Fix:** History area is a labelled, focusable region; role moved to a wrapper; share view uses <main>. Re-checked after a rebuild: none of these violations remain.
- **Regression test:** Re-run of the axe sweep on the 17 affected routes

### ORB-034

**Accessibility: minor remaining issues (error screens without an h1, small text links, one obscured back link)**

- **Severity:** Low · **Confidence:** High · **Evidence:** Observed
- **Status:** Open
- **Where:** `detail views' not-found states (research, review, pair, missions, workflows, research-print)`; `/agents/research back link`; `breadcrumb and footer links`
- **What:** Not-found states show the error in a role=alert paragraph with no h1. On phones, breadcrumb/footer links such as 'Docs' and 'Features' are 20 px high (WCAG 2.5.8 asks for 24 px or enough spacing). The 'All agents' link on /agents/research is partly covered at 390 px (axe target-size).
- **Impact:** Small usability cost for screen-reader and touch users; no blocking issue.
- **How it was shown:** Sweeps at 9 widths; axe at 390/1440.
- **Fix:** Render error states with an h1; give standalone small links min-h-6 (24 px); fix the overlap on /agents/research.

### ORB-036

**Homepage Largest Contentful Paint on mobile is above 2.5 s in lab tests**

- **Severity:** Low · **Confidence:** Medium · **Evidence:** Observed
- **Status:** Open
- **Where:** `https://tryorbis.app/ (mobile profile)`
- **What:** Lighthouse mobile (simulated 4G, 4x CPU), three runs on their own: performance 97/87/88, LCP 2.55/3.42/3.38 s, TBT 50–132 ms, CLS 0. Desktop scores 100 (LCP 0.63 s).
- **Impact:** Slower first view on phones; Core Web Vitals field data may differ (not available here).
- **How it was shown:** npx lighthouse@12.8.2 https://tryorbis.app/ x3
- **Fix:** Identify the LCP element (hero text/screenshot), preload it or reduce work before it; trim the homepage chunk (28 KiB unused JS reported).

<!-- /INTEGRATION-DETAILS -->

## I. Protections checked and found working

Checked by reading the code, plus the tests named:
- **Authentication and authorization on every route handler.** The admin and workforce routes use a server-side admin lookup, and the `admin_*` database functions refuse non-admins. In production, all 9 returned 42501 for a synthetic non-admin user (Observed). The other routes use `requireUser` or `codeContext` plus row-level security. Every service-role query I traced is filtered by a user id.
- **Unauthenticated production sweep (262 method/route pairs):**
  - 177 × 401, 83 × 400 (see ORB-023), 11 × 404, 4 redirects;
  - 12 × 200, all public catalogue or status data (models, agents, discover, connector catalogue, guest usage/home);
  - no private data returned.
- **Outbound requests (SSRF):** DNS checked at connect time against private, loopback, CGNAT, link-local, metadata and mapped-IPv6 addresses. Literal IPs are checked, only ports 80/443 are allowed, and redirects are re-checked on every hop. Limits on size and time.
- **ZIP import:** skips `..`, absolute, encrypted and binary entries; limits inflated size and entry counts. Project paths are validated in code and by a database CHECK constraint.
- **OAuth:** a signed HttpOnly state cookie bound to the user, PKCE, a 10-minute expiry, and a fixed redirect. `safeNext` blocks open redirects on `/auth/callback`. Sign-out is POST-only, and cross-site POSTs are refused by the Origin check.
- **Stripe webhook:** the signature is verified (an unsigned request gets 400, Observed) and events are deduplicated. Credits are only added by the service role.
- **Cron routes:** a `CRON_SECRET` bearer token is required, and they fail closed.
- **Coding agent:**
  - Plan approval, read-only mode and QA's tests-only edits are enforced on the server.
  - Command approval is bound to the stored pending command, and Bastion re-checks every command.
  - The GitHub tool is read-only.
  - The run-code VM has no network.
- **Connectors:** arguments are validated with zod on the server; write actions need write access, the scope and an explicit confirm; tool output is redacted and checked for prompt injection.
- **Share links:** a 24-byte random token; only messages up to `shared_until` are returned.
- **Teams:** every write goes through definer functions with owner, seat and invite checks.
- **Production response headers (Observed):** X-Frame-Options DENY, nosniff, strict referrer policy, permissions policy, a CSP with `frame-ancestors 'none'` and `object-src 'none'`, and HSTS for 2 years (see ORB-024 for the gaps).

## J. UI and responsive layout (9 viewports)

<!-- UI -->
Widths checked: 320, 375, 390, 430, 768, 1024, 1280, 1440 and 1920 px. Each page load also checked for horizontal scrolling, elements past the edge, exactly one h1, console errors, failed requests and touch-target size.

| Sweep | Page loads | Routes | Horizontal scroll | Elements past the edge |
| --- | --- | --- | --- | --- |
| Public pages, production (light theme) | 279 | 31 | 0 | 0 |
| Signed-in app, local production build (dark theme, synthetic user) | 675 | 75 | 0 | 0 |

- **Public:** status 0 = /chat, /mimic, /agents, /templates as a guest: the pages rendered (correct title, one h1, no overflow) but keep a connection open, so the 45 s network-idle wait timed out before the status was recorded; the 9 x 404 are the deliberate /no-such-page. Every public page had exactly one h1, no console errors and no failed same-origin requests.
- **Signed in:** Local production build with a mock Supabase and a synthetic user; 404s are deliberate missing-id and does-not-exist routes. Console errors from /_vercel/insights (served only on Vercel) and from RPC calls the mock does not implement (/admin finance, /api/code/projects) are harness artefacts.
- **Two first attempts were thrown away:**
  - In the first, every signed-in page was actually the terms-acceptance page, because the synthetic user hadn't accepted the terms.
  - In the second, a stale server process kept the port and served an older build, which made JavaScript chunks go missing.
  - Both problems came from the test setup, not the product. The numbers above are from the clean run.
- **No layout defects were found:** nothing scrolls sideways or overflows at any of the nine widths.
<!-- /UI -->

## K. Accessibility

<!-- A11Y -->
axe-core (WCAG 2.0/2.1/2.2 A and AA, plus best practice) ran at 390 and 1440 px on every swept page.

- **Public pages:** No violations on 31 public routes at 390 and 1440 px.
- **Signed-in pages before the fixes:** scrollable-region-focusable (12), target-size (1), aria-allowed-role (1), landmark-one-main (1), region (1), page-has-heading-one (1).
- **After the fixes (ORB-033, re-checked on a rebuilt app):** target-size (1), page-has-heading-one (not-found state) (1). The remaining minor items are ORB-034.
- **Not covered:** manual screen-reader and keyboard-only walkthroughs were not done (section P).
<!-- /A11Y -->

## L. Performance

<!-- PERF -->
Lighthouse 12.8.2 against https://tryorbis.app. Lab measurements from this container (simulated throttling for mobile); one run per page and profile; another local browser sweep was running at the same time, which can lower scores slightly.

| Page | Profile | Performance | Accessibility | Best practices | SEO | LCP (ms) | TBT (ms) | CLS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /features | desktop | 100 | 100 | 100 | 100 | 526 | 0 | 0 |
| /features | mobile | 99 | 100 | 100 | 100 | 1980 | 96 | 0 |
| /login | desktop | 100 | 100 | 100 | 66 | 602 | 2 | 0 |
| /login | mobile | 90 | 100 | 100 | 66 | 2859 | 290 | 0 |
| /pricing | desktop | 100 | 100 | 96 | 100 | 564 | 0 | 0 |
| /pricing | mobile | 94 | 100 | 96 | 100 | 2258 | 221 | 0 |
| / | desktop | 100 | 100 | 100 | 100 | 630 | 0 | 0 |
| / | mobile | 77 | 100 | 100 | 100 | 3232 | 634 | 0 |

- **Homepage, mobile, re-run three times on its own:** 97 (LCP 2554 ms, TBT 50 ms); 87 (LCP 3419 ms, TBT 132 ms); 88 (LCP 3383 ms, TBT 87 ms). LCP is above the 2.5 s target (ORB-036).
- **`/login` SEO 66:** the page is deliberately not indexed.
- **`/pricing` Best practices 96:** a CSP report caused by zod's eval probe (ORB-035).
- **Server-side performance:** see ORB-009 (parsing is now linear time) and ORB-017 (database growth).
<!-- /PERF -->

## M. Mobile and app-store readiness

- **Mobile web:**
  - Every public and signed-in page was checked at 320, 375, 390 and 430 px wide (section J).
  - The coding agent's own browser check covers 390 px.
- **Native apps:**
  - `mobile/` holds a Capacitor 8 shell that loads https://tryorbis.app, with an offline page, in-app browser for other sites, Google sign-in through the system browser, and store-safe purchase handling (`docs/MOBILE_APPS.md`).
  - **No iOS or Android build was produced, installed or tested in this audit.** That needs Xcode or Android Studio plus a device or emulator, and a store developer account.
  - So the apps are **not** confirmed ready for the App Store or Google Play.
- **Before submitting:**
  - build both apps;
  - test sign-in (email, GitHub, Google through the system browser), chat, Code and the offline page on real devices;
  - make sure no purchase UI shows inside the apps (store rules);
  - add privacy labels and a data-safety form that match the privacy policy;
  - provide an in-app account deletion path. Store rules require one, and today deletion is by email (see ORB-015).

## N. Fixes applied on the audit branch

| Commit | What |
| --- | --- |
| `faf2695` | All code fixes and regression tests below, plus the prepared migration `20261109000000_audit_hardening.sql` |
| `33b434b` | Reverted an attempted fix for ORB-022 after it proved ineffective (Next.js resolves `%5C` paths before the proxy runs) |
| `83e39d6` | Accessibility fixes (ORB-033) |

Regression tests added:
- **`tests/audit-2026-10-26.test.ts`** (15 tests):
  - preview path rules and schema;
  - command policy;
  - credential redaction;
  - linear-time HTML parsing on 2 MB hostile inputs and unchanged output on normal pages;
  - schedule interleaving;
  - Slack no-retry and card destination;
  - single-run proposals;
  - exact ownership-token matching.
- **`tests/code-agent-engine.test.ts`** (1 new): the browser check never runs with shell syntax in the path or with commands off. It fails on the old code (2 injected checks ran).
- **`tests/audit-db.test.ts`** (6 tests + 2 todo), on all migrations with Supabase default privileges:
  - users can't write usage records or dummy runs;
  - hold estimates are clamped;
  - Mimic rows cascade with the account;
  - TRUNCATE is refused;
  - the ownership token can't be rewritten.

  All 6 fail without the migration and pass with it.
- **Changed tests:** `tests/rls.test.ts` now asserts that users can't insert usage records. `usage-ledger`, `plans-billing` and `code-run` insert their fixture runs as the server (as production now does).

## O. Needs your approval or action

| # | Action | Why it needs you |
| --- | --- | --- |
| 1 | Deploy the audit branch (merge to `main`) | Production deploy |
| 2 | **Then** apply `supabase/migrations/20261109000000_audit_hardening.sql` (SQL editor or `apply_migration`) | Production database change. Order matters: with the old code still running, runs would stop being recorded until the new code is live |
| 3 | Enable Cards in Stripe → Settings → Payment methods (ORB-027) | Your Stripe account. Until then nobody can subscribe |
| 4 | Enable leaked-password protection in Supabase → Authentication (ORB-025) | Dashboard setting |
| 5 | Decide: keep `.env` files out of the project computer (ORB-005) | Changes how users' own dev servers get their settings |
| 6 | Decide: route files changed by agent commands through edit review and Bastion file checks (ORB-010) | Changes how the coding agent behaves |
| 7 | Approve a billing refactor so reservations, releases and settlements are made only by the server (ORB-002, ORB-014) | Touches every metered path; needs its own migration and a careful rollout |
| 8 | Optional: Slack read scopes to show verified channel names (ORB-006) | Existing Slack users would need to reconnect |
| 9 | Optional: HSTS includeSubDomains/preload (ORB-024) | Affects every subdomain of tryorbis.app |

## P. Not tested, and why

<!-- NOT-TESTED -->
- **Native iOS and Android builds:** Needs Xcode/Android Studio, devices or emulators and store accounts; not available in this environment.
- **Real sign-in flows in production (email, GitHub, Google):** Would create real accounts; synthetic local sessions were used instead.
- **Real AI requests, coding-agent runs and connector actions in production:** Cost money, contact third parties or send messages; covered by tests with stubs.
- **Stripe checkout end to end:** Payment methods are not enabled in the Stripe account (ORB-027); no charges allowed.
- **Exploit of ORB-001/002/014 against production:** Would cause a real outage; shown on PGlite with all migrations instead.
- **Load and stress testing:** Not authorised against production; only single sequential requests were made.
- **The Python engine (workspaces, share, connections):** Separate service outside this repository review.
- **Whether Supabase requires email confirmation:** Auth setting not readable read-only; affects team_accept_invite email matching.
- **Live grants on the production database:** Assumed Supabase's default privileges, as the migrations do.
- **Screen-reader and keyboard-only walkthroughs:** Automated axe checks only; manual assistive-technology testing not done.
<!-- /NOT-TESTED -->

## Q. Recommended next steps, in order

1. Deploy, then apply the migration (O.1–O.2). After that, check on production:
   - a chat message still records usage (`model_runs` gets a row);
   - the Usage page still shows the run;
   - the site-cap check still works.
2. Enable Stripe Cards and retry Get Pro end to end with a test card in test mode (O.3).
3. Billing refactor for ORB-002 and ORB-014: reservations, releases and settlements made only by the server.
4. Coding agent: route command-made file changes through the edit gate (ORB-010); decide on `.env` (ORB-005).
5. Lower-severity items:
   - authenticate before body validation (ORB-023);
   - restrict assistant-role inserts (ORB-019);
   - save partial chat turns (ORB-020);
   - nonce-based CSP (ORB-024);
   - shared rate-limit store if abuse appears (ORB-026).
6. Native apps: build and test on devices before any store submission (section M).

## R. Completion checklist

<!-- CHECKLIST -->
- [x] Inventory of routes, pages, migrations, tables and functions
- [x] Baseline: tests, type check, lint, build, dependency audit, secret scan
- [x] Authorization review of every route handler
- [x] Multi-user isolation and RLS tested with synthetic users (PGlite)
- [x] AI, agents and code execution review
- [x] Integrations review (connectors, Stripe, email)
- [x] Unauthenticated production API sweep
- [x] Production headers, logs, advisors (read-only)
- [x] UI at 9 viewports: public pages on production
- [x] UI at 9 viewports: signed-in pages on a local production build
- [x] Accessibility: axe at 390 px and 1440 px
- [x] Performance: Lighthouse on key production pages
- [x] Every confirmed finding has an ORB ID, status, confidence and evidence level
- [x] Safe fixes applied with regression tests that fail on the old code
- [x] Full test suite, type check, lint and build pass after the fixes
- [x] Risky or approval-bound fixes documented with a patch or plan
- [x] No secrets, personal data or raw logs in the reports
- [ ] Production deploy
- [ ] Production migration
- [ ] Native app builds tested
<!-- /CHECKLIST -->
