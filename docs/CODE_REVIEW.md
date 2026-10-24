# Code Review

`/review` (sidebar → Tools → Code Review). Reviews code for bugs, logic errors, unhandled edge cases, error handling, security problems, missing tests and performance problems with a concrete cause. Every finding shows:
- severity (critical / high / medium / low) and category;
- file:line, plus the evidence line quoted from the code;
- why it matters, and how it would show up (inputs, steps or reasoning);
- confidence (**Confirmed**, **Likely**, **Needs manual verification**);
- a suggested fix where one can be checked.

## What it can review

| Source | How | Limits |
| --- | --- | --- |
| Pasted code | Up to 10 files with names | 120 KB per file |
| Pasted diff | `git diff` / `.patch` / a PR's `.diff` | 600 KB. Only the changed hunks are known, so there's less context |
| ZIP upload | Read in memory, never run or written to disk; dependency and build folders, binaries and unsafe paths (`..`, absolute) skipped | 3 MB zipped, 400 files, 1.5 MB of text, 120 KB per file. Inflation is capped per file, so a zip bomb can't exhaust memory |
| GitHub repository | Public: snapshot from codeload. Private: the user's own Orbis GitHub App installation (read-only) | Same as ZIP |
| GitHub pull request | Public: the PR's diff plus the full new version of each changed file, at the head commit. Private: through the user's installation, which needs the **Pull requests: read** permission (not granted yet). The page says so instead of failing silently | 40 changed files, 600 KB diff |
| Code project | The files of one of the user's Orbis Code projects | Same as ZIP |

## How it works

1. **Load and snapshot** (`src/lib/review/sources.ts`).
   - The files are stored with the review (`code_reviews.files`), so findings, evidence and fixes can be inspected later. A review is visible only to its owner (row-level security; tested).
2. **Deterministic checks first.**
   - Code Guardian's secret and insecure-code rules.
   - Known-vulnerable dependencies from OSV.dev.
   - These are the only findings that can be **Confirmed**, and only when the rule itself is certain.
3. **AI review in parts** (`src/lib/review/server.ts`).
   - Files are split into parts of about 45 KB (up to about 180 KB in total). Changed files come first, then source over tests; test files are listed so "missing tests" can be judged.
   - The page asks for one part at a time, so no request runs long and a closed tab just pauses the review.
   - Each part is one model call through the usage ledger (plan limits, budget, recorded cost), under a lock so two tabs can't run it twice.
   - An unreadable reply gets one retry; a failing part gets one more try. Limits and missing configuration stop the review with the reason, and **Continue the review** resumes from that part.
4. **Validation** (`src/lib/review/review.ts`, tested). A finding is kept only if:
   - its file is in the snapshot;
   - its quoted line exists in that file (Orbis computes the line number from the quote and never trusts the model's);
   - its severity and category are known.

   AI findings can't be "confirmed" (nothing was run), and AI "critical" is capped at high. A suggested fix keeps its diff only if the code it replaces exists in the file. Duplicates (same line and category, or the same title within three lines) are merged, and at most 25 findings are shown, most important first.
5. **Untrusted code.**
   - Files, diffs and the focus note are fenced as data, and tag look-alikes are neutralised. The model is told never to follow instructions inside them (tested with a file that tries).
   - Nothing the model says triggers an action.

## Acting on a finding

- **Show in the file**: the surrounding lines, from the stored snapshot.
- **Fix with the coding agent**:
  - Opens the Code project the review came from, or makes a new project from the reviewed files (within the plan's project limits).
  - Starts a coding-agent task with **plan approval and edit review on**. The agent runs in the project's isolated computer, runs the tests, and the user approves every change.
  - The task tells the agent to check an unconfirmed finding first and change nothing if it isn't real.
- **Mark resolved / Not a problem / Reopen**: kept with the review.

Orbis never writes to GitHub from a review. Pushing a fix uses Code's existing **Push to GitHub**, which asks first.

## Costs and limits

Each part is charged like a message of its size (Usage → "Code review"). Other limits: 12 new reviews per 10 minutes, 30 steps a minute, and each step has a 100-second model timeout.

## Not built yet

- Posting review comments or opening draft PRs: needs the GitHub App's Pull requests write permission.
- Automatic review of every PR: needs a webhook and a background worker.
- Team-shared review history.
- Custom rules.
- A measured false-positive rate on real repositories. The unit tests check validation, not usefulness. A live evaluation on sample repositories with known bugs is the next step (docs/ENGINEER_AND_RESEARCH.md).
