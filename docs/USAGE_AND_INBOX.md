# Usage at a glance, estimates, and the Activity inbox

Two changes to make Orbis easier to live with: people can see how much of their allowance is left (and what a task
will use) without visiting the Usage page, and they hear about work that finished or needs them while they were away.

## 1. Usage you can understand

**One figure in the sidebar.** Above the account menu: "41% of this week used · Resets Mon 2:46 AM", with a bar
(amber from 80%, red at the limit, and "using extra usage" when paid extra usage carries on). It shows the week, or
the 5-hour session when that's closer to its limit (`headline()` in `src/lib/usage-glance.ts`). It links to the
Usage page, is hidden for guests and accounts without limits, and is re-read on navigation and when the tab comes
back into view (at most every 30 s), so no polling.

**"This will use about X% of your week" before costly tasks.** Under the start button of Deep Research, Code Review
and the coding agent:

> A research run usually uses about 10% of your week (5–20%, going by recent runs on Orbis). 59% of your week is left.

- It comes from real usage records, never a guess: the user's own runs of that task in the last 30 days (records of
  one feature less than 15 minutes apart count as one run; `runsFromRecords()`), else the typical run across all
  accounts from the database function `usage_typical_run`, which returns only aggregates and only once at least
  3 accounts and 5 runs exist. With neither, it says the task is counted as it runs, and how much of the week is
  left.
- It turns amber when a typical run may not fit in what's left, and mentions the 5-hour session when it's ≥ 80% used.
- Council and Arena keep their own estimates, worked out from the models picked (`lib/council/estimate.ts`).
- API: `GET /api/usage/estimate?feature=code_agent|bug_fix|qa_testing|deep_research|code_review` (shares only).

**Limit messages that say what upgrading gives.** "Pro gives you more." is now specific to the limit that was hit,
e.g. "Pro ($28/month) includes 36× this weekly allowance." or "Max ($153/month) includes 10× the allowance per
5-hour session." (`upgradeLine()` in `src/lib/usage-upgrade.ts`). Only ratios are shown; AI budgets stay internal.
When it resets was already in every limit message.

## 2. Hearing about background work

**What counts.** A coding task that runs with "keep working" carries on after its page is closed (the background
worker). When such a task **finishes**, **stops** or **needs the user** (a plan, command or edits to approve, a
question, a limit) while the worker is driving it, the user gets one update. The same changes while the page is
open don't create updates: the page already shows them. If the worker itself has to stop (a plan limit, say), that
is an update too.

**Where it shows.**
- **Activity badge** in the sidebar: tasks waiting for the user + new updates.
- **Updates** at the top of Activity: newest first, with a link to the task. They're marked read after 3 seconds on
  the page and stay highlighted for that visit. Activity now refreshes itself every 20 s while tasks are in
  progress, and the "Waiting for you" filter shows a count.
- **Email** (via Resend, when `RESEND_API_KEY` is set): "Done: …", "Stopped: …" or "Needs you: …", once per update,
  with a link to the task on Orbis. Off in Settings → Notifications ("Email me about tasks").
- **Browser alerts**: Settings → Notifications, or "Alert me in this browser" on Activity. A system notice appears
  when an update arrives while an Orbis tab is open in the background. Saved per browser.

**How it works.** `src/lib/inbox.ts`: the background worker runs each step inside `inBackground()`; every save of a
coding task's status (`updateRun` / `updateRunIfNotCancelled` in `runs.ts`) then calls `runNotice()`
(`code/agent/notify.ts`) and `notifyUser()`, which writes the update with the user's own session and emails it. A
repeat (same task, status and step) is ignored, and so is its email. Nothing here can fail a task.

**Data.** Migration `20261112000000_usage_estimates_inbox.sql`:
- `user_notifications` — the user's updates. Row-level security: users read, add, mark read and delete only their
  own; only `read_at` can be changed after a row is written; links must be paths inside Orbis (the server also drops
  anything else). Read updates older than 90 days are removed by the daily cron.
- `usage_typical_run(purposes)` — the all-accounts estimate (aggregates only, minimum 3 accounts / 5 runs).

APIs: `GET /api/inbox` (updates, unread count, tasks waiting), `POST /api/inbox` `{ ids: [..] | "all" }` (mark read),
`GET/PATCH /api/inbox/settings` `{ email }`. Polled once a minute by the sidebar (every two minutes in a hidden tab).

## Tests

`tests/usage-glance.test.ts`, `tests/inbox.test.ts`, `tests/usage-inbox-db.test.ts` (the migration on PGlite:
privacy threshold, run grouping, row-level security, the end-to-end path from a background status save to one update
and one email), additions to `tests/code-agent-background.test.ts` and `tests/usage-policy.test.ts`.

## Not done (needs a decision or setup)

- **Push notifications to phones** (when no Orbis tab is open). Needs Web Push signing keys (VAPID), a service
  worker and the `web-push` package; the keys are credentials you'd create and add as environment variables.
  Emails cover this case until then.
- **Orchestrator tasks** aren't in Activity or the inbox yet: the orchestrator has no page of its own (planned with
  its task board).
- Deep Research and Code Review stop when their page is closed, so they never run unattended and don't create
  updates.
- The migration must be applied to production before deploying (the estimate falls back to "counted as it runs"
  and the inbox stays empty until then).
