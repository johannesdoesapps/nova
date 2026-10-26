# Site audit, 26 October 2026

Branch `site-audit-2026-10-26` (based on `libraries-effects`, which adds Jarvis conversation mode). It fast-forwards from `main`. **Not deployed:** pushing to `main` was blocked by the session's permission check, so production still runs the previous build.

## Environment and limits

- All browser testing ran locally against a production build (`next build` + `next start`) with a mock Supabase server and a synthetic signed-in user (`tester@example.com`). No real users, emails, payments or production data were touched.
- No AI provider keys locally: chat uses the built-in demo model, or responses intercepted in the browser. Nothing was tested against a real model, a real microphone or a real Stripe checkout.
- Admin, some Code and Pair views return 500/502 locally only because the mock database lacks some RPCs. These are mock gaps, not production failures, and were not counted as bugs.

## Fixes made (all re-tested)

### Security and data integrity
| Area | Problem | Fix |
|---|---|---|
| `lib/engine-guard.ts` | A body that JSON.parse rejects (for example `{"use_model": NaN}`, which Python accepts as truthy) counted as "no model", so a non-admin could start paid engine model calls | Unparseable bodies fail closed (treated as using a model) |
| `lib/validation-research.ts` | User-supplied regex checker could run a catastrophic pattern (ReDoS) on the server | `regex` removed from user checker specs |
| `api/security/findings/[id]/recheck` | Re-check skipped the security-agent access check and the outbound-network policy | `assertAgentAccess` + Bastion `web.search` enforcement before external re-checks |
| Billing / team checkout | A double click could create two Stripe Checkout sessions | Idempotency key per user, plan, interval, seats and price in 15-minute buckets |
| `api/agent-platform/delegate` | An already started proposal could be started again | Refused with a conflict |
| `lib/mimic/server.ts` | Malformed ids reached the database | Non-UUID ids return 404 |
| `api/security/aegis/report` | `toString` and other prototype keys passed the report-kind check | `Object.hasOwn` |

### Behaviour and states
- Chat: opening a missing or failed conversation then sending now starts a fresh chat (it used to reuse the old conversation id). Focus returns to the composer after sending. Dictation no longer refills the box after sending. Edits aren't sent against an unsaved message.
- Code editor: unsaved edits are flushed when leaving the page (`pagehide`, keepalive).
- `/code`: the sidebar "New project" link opens the form every time (previously only once).
- Team: the seat field can be cleared and retyped, invalid counts are explained and block Continue. Remove, leave and withdraw ask first and show progress.
- Templates: an emptied step box stays empty (it used to snap back to the default), with a hint and Reset.
- Model picker inside dialogs (for example the Security launcher) now opens on top of the dialog and can be used.
- Lists that fail to load (Memory, Research, Reviews, Pair, Connectors) show "Couldn't load… Try again" instead of an empty list or an endless skeleton.
- Request errors read in plain English (401, 403, 404, 413, 429, 5xx) everywhere `readApiError` is used.
- Single-flight and busy states: Aegis forms, feedback, Mimic settings and inbox, Workforce panels, message rating.
- Pair: deleting a task really deletes it (after confirming).
- Jarvis: leaving the page stops the runner and aborts the in-flight turn; emergency stop errors are shown.
- Images: a finished image isn't lost when you start the next one.
- Home: the welcome doesn't reappear after onboarding in the same visit.

### Design (glass system)
- Studio tokens `--s-card`, `--s-card-hover`, ambient brand tints and `.s-card` (translucent fill, top sheen, hairline border, inner highlight), tuned separately for light and dark.
- Applied to 44 components that hand-rolled `rounded-* border border-s-line` cards, so cards share one surface, radius and border.
- Danger buttons use `--s-danger-ink` for readable contrast in both themes. Jarvis had a nested `<main>`, now fixed.

## Tests performed (real results)

| Check | Result |
|---|---|
| TypeScript `tsc --noEmit` | 0 errors |
| ESLint | 0 errors, 2 warnings (unused imports in files outside this change) |
| Unit tests (Vitest) | 130 files, 1783 tests passed |
| Production build | passed |
| Route sweep, signed in: 71 routes × 390/768/1440 px × dark/light (axe, console, overflow, failed requests) | issues found were fixed or are listed below |
| Fix verification in browser (`qa/fixes.mjs`) | 25/25 |
| Failed-load states (`qa/loadfail.mjs`) | 15/15 |
| Chat edge cases: 500, offline, slow + double submit, empty, HTML 502 | 13/13 |
| Jarvis conversation mode | 16/16 |
| Jarvis end-to-end (missions, approvals, undo, stop, push-to-talk, 390 px) | all passed |
| Click crawl, 15 signed-in pages, 211 controls | no page errors or failed requests. 24 flags checked by hand: already-selected tabs and radios, or false positives ("Tools", "Saved prompts" and Usage "Refresh" work) |
| Visual check, both themes, 1440 and 390 px | Home, Agents, Templates, Settings, Team |

## Remaining issues

1. **Not deployed.** Conversation mode and everything above are on `site-audit-2026-10-26` only. To ship it, fast-forward `main` to this branch: `git push origin site-audit-2026-10-26:main`. Rollback target: `dpl_E5fqomT3kKpAj9YFp8qe8d7hmKHv`.
2. **Branch `audit-2026-10-26` is unmerged.** It holds earlier hardening, including the sidebar scroll-region focus fix, and migration `20261109000000_audit_hardening.sql`, which needs your approval before it runs on production.
3. **PR comment double post.** Two simultaneous clicks can post a security PR comment twice. A proper fix needs a unique claim in the database (a migration), so it was left for approval.
4. **Legacy engine OAuth redirect** points to `/integrations`, which now redirects to `/chat`. This is unused by current flows.
5. **Not verifiable here:** real AI replies, real voice input, Stripe checkout, emails, and production-only data paths (Admin, some Code/Pair views behind missing mock RPCs).
6. **Observation, unchanged:** Team and Usage highlight "Home" in the sidebar by design (`nav.ts` sets their parent to Home).
