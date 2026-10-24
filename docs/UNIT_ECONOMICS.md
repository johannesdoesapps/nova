# Unit economics (Admin → Finance)

Administrators see **Unit economics** at the bottom of Admin → Finance (`/api/admin/unit-economics?days=7|30|90`). Everything comes from records the server writes; nothing is estimated. A figure without enough data shows "Not enough data", and the panel lists what's missing. Ordinary users never see any of it: the database function `admin_unit_economics` refuses anyone not in `public.admins`, and the route checks admin rights first.

## Sources

| Figure | Source | Limitation |
| --- | --- | --- |
| Model cost | `model_runs.estimated_cost`: provider-reported tokens × the verified list prices in `src/lib/ai/cost.ts` | Not reconciled with provider invoices here (the daily reconciliation job compares them) |
| Sandbox cost | `model_runs` rows with purpose `code_workspace` / `code_run`: measured time × Vercel Sandbox's published per-hour prices | Not Vercel's invoice |
| Coding task cost | `code_agent_runs.report.usage.costUsd`, else the running `usage.costUsd` | Model calls only; workspace computer time isn't linked to tasks |
| Task success | The task's report `state` is `verified` or `checked` (older reports: tests passed) | Tasks still open aren't counted either way |
| Revenue | `billing_ledger` (Stripe paid invoices and refunds, excluding tax) | Payment fees not recorded per payment |
| Plan | `model_runs.entitlement` at the time of the request | Rows from before entitlements were recorded show as "No plan recorded" |

## Metrics (`src/lib/billing/unit-economics.ts`)

- **Variable cost per active user**: model + sandbox cost of non-administrator users ÷ how many made a request in the period.
- **Cost per successful coding task**: model cost of tasks that finished verified or checked ÷ their number.
- **All task cost per successful task**: model cost of every task (failed, stopped and unverified included) ÷ successful tasks — what one success really costs.
- **Failed or stopped task cost**: model cost already spent on tasks that failed or were stopped. Users are charged for the calls that answered.
- **Model cost / Sandbox cost / Free tier cost**: totals for the period.
- **Failed model calls**: share of calls that ended in an error. They're charged 0 units.
- **Top user's share / top 10% share of cost**: cost concentration among non-administrator users.
- **Per plan**: active users, calls, model and sandbox cost, cost per active user, collected (payments − refunds) and gross margin = (collected − variable cost) ÷ collected. No revenue → no margin. Fees and hosting are in the Finance plan table, which uses the fee rate and overhead set in Admin → Plans.

## First reading (30 days to 24 Oct 2026)

Almost all usage is testing. Model cost $0.48, sandbox $0.47 (workspace computer time is the largest single feature). Administrators: 248 calls, $0.81 of the $0.95 total. Non-administrator users: 4, $0.14 between them, one user 51% of it. One coding task, still open; no payments recorded; both subscriptions rows canceled. None of the per-user, per-task or margin figures are meaningful yet.

## Data still needed

1. **Subscription history**: one row per Stripe subscription change (created, upgraded, downgraded, canceled, renewed) to measure upgrade and retention rates. `subscriptions` keeps only the current state.
2. **Payment fees per payment**: Stripe's balance-transaction fee on each `billing_ledger` row, so margins don't rely on the configured fee rate.
3. **Hosting per request**: Vercel function and Supabase costs aren't recorded per request; Finance uses the configured overhead.
4. **Workspace time per task**: link `code_workspace` usage to the coding task that was running, so per-task cost includes the computer.
5. **Volume**: at least ~20 non-administrator users and ~20 coding tasks in a period before averages mean much.
