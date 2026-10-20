# Orbis release checklist

Use for every production release. Tick each item, or write why it doesn't apply.

## Before merging
- [ ] `npx tsc --noEmit` passes.
- [ ] `npx eslint src tests` — no errors.
- [ ] `npx vitest run` — all tests pass (database tests run the real migrations).
- [ ] `npm run build` succeeds.
- [ ] New or changed database objects have RLS and column grants, and a test on PGlite.
- [ ] No secrets, keys or personal data in the diff, logs or test fixtures.
- [ ] Prices, plan limits and entitlements unchanged unless the owner approved the change.
- [ ] Docs updated (feature doc, changelog).

## Database
- [ ] Migration is additive, or a destructive step has the owner's explicit approval and a backup.
- [ ] Migration applied to production **before** the code that needs it is deployed.
- [ ] Rollback note: can the previous code run against the new schema?

## Deploy
- [ ] Push to `main`; Vercel builds and promotes the production deployment.
- [ ] Deployment status is READY; no new runtime errors in Vercel logs in the first minutes.

## After deploy (production)
- [ ] Public pages load: `/`, `/pricing`, `/features`, `/privacy`, `/terms`.
- [ ] Sign-in works; the consent gate shows only for accounts that haven't accepted the current terms.
- [ ] Chat answers with the default model.
- [ ] Code: open a project, start the computer, run a command, stop the computer.
- [ ] Coding agent: a small task on a disposable project reaches a report with real test output (see ORBIS_CODE_TEST_PLAN.md → Live acceptance).
- [ ] Test accounts locked again and temporary credentials deleted.

## Rollback plan
1. In Vercel, promote the previous production deployment (instant), or revert the commit and push.
2. Leave additive migrations in place; for anything else, follow the migration's own rollback note.
3. Record what happened and why in the changelog.

## Owner-only items (can't be done by the implementer)
- [ ] Provider API keys present and valid in Vercel (Anthropic, OpenAI; others optional).
- [ ] Billing (Stripe) configured before paid plans are sold.
- [ ] GitHub App configured with Contents read/write for Push to GitHub.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` only if background agent runs are built (not needed today).
- [ ] Legal: operator name and address in the Terms and Privacy Policy; lawyer review.
