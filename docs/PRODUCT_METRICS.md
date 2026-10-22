# Product metrics: feedback, events and the measurement plan

How Orbis measures whether people get value from it and where it gets in their
way. Everything is first-party (Orbis's own Supabase database), tied to an
account but never to what anyone typed. No third-party tracking service is used
for this; Vercel Web Analytics still counts anonymous page visits as before.

The figures are on **Admin → Product** (`/admin`), computed by the
`admin_product_metrics` database function from real records. Your own admin
accounts and the `@orbis.invalid` test accounts are left out.

## What's recorded

### Feedback (`response_feedback`)

Offered only after someone acts, never as a form after every message:

- **Chat and agent replies.** Thumbs up saves "Helpful". Thumbs down opens a
  short list of reasons: Incorrect, Incomplete, Not relevant, Too slow, Used
  more than expected, Something else. There's an optional note. Clicking the
  same thumb again takes the rating back.
- **Finished templates and Verify results.** A single "Was this useful? Yes /
  Not quite" line, with the same reasons for "Not quite".

There's one rating per result per person, and the person can change it. The
result's text isn't stored with the rating. Guests' thumbs stay in their
browser as before.

### Product events (`product_events`)

| Event | Recorded when | Properties (fixed patterns only) |
| --- | --- | --- |
| `useful_result` | A result is copied, saved to a project, turned into a task/milestone/prompt/follow-up, or rated helpful | `how`, `feature` |
| `workflow_started` | A template's first step runs (server) | `template` |
| `workflow_completed` | A template's last step finishes (server) | `template`, `steps` |
| `workflow_failed` | A template step fails, not when cancelled (server) | `template`, `step` |
| `comparison_started` | An Arena run starts (server) or a Council run starts (browser) | `kind`, `models` |
| `comparison_completed` | Arena returns answers, or Council's synthesis finishes (server) | `kind`, `models` |
| `verify_completed` | A Verify check returns results (server) | `scope`, `searched`, `claims` |
| `usage_limit_reached` | A request is refused by a usage limit (server) | `scope` (which limit) |
| `palette_command` | A command palette command is run | `group` |

Properties pass through `cleanProps` (`src/lib/analytics/events.ts`), which
keeps only the listed keys and only values that match short patterns. Free
text can't get through, and the test suite checks this. The database also
rejects unknown event names and properties over 512 bytes.

People can turn events off in **Settings → Privacy and data**. Ratings they
choose to give are still saved. Guests aren't tracked. The Privacy Policy
describes all of this (the collect, use, retention and controls sections).

### Already recorded, reused

These come from data Orbis already keeps:

- First prompt, first successful result, activity and feature use come from
  `model_runs` (usage records).
- Projects created come from `projects` and `code_projects`.
- Accepting the terms at sign-up comes from `legal_acceptances`.
- Paid status comes from `subscriptions`.

## The measurement plan

| Metric | Definition | Source |
| --- | --- | --- |
| Activation rate | Of people who signed up in the period, the share with a successful AI result within 7 days | Accounts + usage records |
| Time to first result | Median, sign-up → first successful AI result | Accounts + usage records |
| Time to first useful result | Median, sign-up → first result used (copied, saved, rated helpful, or a finished template, check or comparison) | Events + feedback |
| 7/30-day retention | Of people who signed up ≥7 (≥30) days ago, the share who used AI again on or after day 7 (30) | Accounts + usage records |
| Returned after a break | People who came back in the period after ≥7 days without using AI | Usage records |
| Workflow completion | Templates finished ÷ started, per template | Events |
| Feature adoption | People who used each feature successfully in the period | Usage records |
| Reported satisfaction | Share of ratings that are "helpful", and the reasons when not | Feedback |
| Usage-limit friction | Requests refused by a limit, by limit, and how many people hit them | Events |
| Free → paid | People with a live paid subscription | Subscriptions |

Rules the admin page follows:

- When there's nothing to measure, it says so ("Not measurable yet" with the
  reason) instead of showing 0% or a guess.
- Rates based on fewer than 20 people carry a warning.
- Event- and feedback-based figures only cover time since **22 October 2026**,
  when recording started.
- **Free → paid can't be calculated yet**, because payments aren't live and no
  paid subscriptions have been recorded.

## Current state (22 October 2026)

At launch of this feature, all five accounts in the database are admins or
test accounts. The metrics therefore cover **0 people**, and every figure
reads "not measurable yet". That's accurate: there are no outside users to
measure. Once real people sign up, the page fills in from their activity
without further work.

## Using it to prioritise

1. Each week, open Admin → Product (last 30 days).
2. Look at what "Not quite" ratings say (counts by reason, and the notes in the
   `response_feedback` table) and at templates with low completion or many
   failures. Those are the first things to fix.
3. Usage-limit friction tells you whether limits are pushing people away. If
   it's frequent, review plan sizes, model defaults or Auto routing; don't add
   nags.
4. Check activation and time to first result after any change to sign-up, Home
   or the first-run starter.

What's deliberately not done:

- No engagement nudges.
- No streaks.
- No urgency messaging.
- No notifications to bring people back.
- No feedback prompt after every message.

## Not covered yet

- A single "onboarding completed" step beyond accepting the terms at sign-up.
  Orbis has no multi-step onboarding to complete. The first-run starter's
  choices are counted (anonymously) by Vercel Web Analytics.
- Deleting a person's past events from Settings. They can turn events off
  there; deleting past events is by email, as the Privacy Policy says. Deleting
  the account removes them (cascade).
