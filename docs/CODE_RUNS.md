# Running code (the Run button)

Code blocks in chat and agent replies tagged `python`, `javascript`, `typescript` or `bash` (and the usual aliases: `py`, `js`, `ts`, `sh`…) get a **Run** button. The output appears under the block: standard output, errors, the exit code and how long it took.

## How a run works

`POST /api/code/run` with `{ language, code, requestId }` (`src/app/api/code/run/route.ts`):

1. **Sign-in required.** Guests see "Sign in to run code".
2. **Reserved like an AI request** (`usage_reserve_v4`, purpose `code_run`). Duplicate request ids are refused. The run's worst-case cost is held against the budget, and the daily and site-wide money caps and the emergency stop apply.
3. **Allowance check** (`code_run_status`, migration `20261020000000_code_runs.sql`). This counts the user's runs this period, including runs still in progress, so parallel requests can't slip past the limit. It also counts everyone's runs this month for the site-wide limit. A refused run's hold is released.
4. **Runs in a fresh Vercel Sandbox microVM** (`src/lib/code/run.ts`):
   - One VM per run, 1 vCPU and 2 GB.
   - **No network.**
   - Nothing from Orbis's environment is passed in.
   - The program gets no input and is killed at the time limit (30 s by default).
   - Output files are capped, and the first 64 KB of stdout and stderr are returned.
   - The VM is stopped as soon as the run ends.
5. **Recorded** in `model_runs` (`model_id = vercel:sandbox`, `tools = {code_run}`, 0 usage units) with its sandbox cost. Only the language and the exit code are stored, not the code or its output. If the sandbox couldn't start, nothing is recorded and the run isn't counted.

The image has Python 3.14 (standard library only) and Node.js 24, which runs TypeScript by stripping types. Packages can't be installed because there's no network.

## Allowances (Admin → Plans & pricing)

| | Free | Pro | Max |
| --- | --- | --- | --- |
| Code runs per month | 20 | 300 | 1,500 |

Site-wide settings:
- **Code runs / month, whole site:** default 4,000. It applies to everyone, administrators included. Vercel's Hobby plan allows 5,000 sandbox starts a month, which Workforce also uses.
- **Code run time limit:** 30 s by default.

## Cost

Vercel Sandbox prices, from https://vercel.com/docs/sandbox/pricing, checked 2026-10-19:
- $0.128 per active CPU hour;
- $0.0212 per GB-hour of memory;
- $0.60 per million sandbox starts.

A run is costed as if the CPU were busy the whole time, which is an upper bound. At the 30 s limit, plus about 3 s to start and stop, a run costs at most **$0.0016**. A typical 2-second run costs about $0.0002.

Each plan's runs are set aside at that worst case **before** its AI budget is worked out (`planEconomics` → `codeRunsUsd`). The contribution margin therefore stays at or above the target even if every run and the whole AI budget are used:

| | Code runs, worst case / month | AI budget / month |
| --- | --- | --- |
| Pro ($20) | $0.47 | $3.59 (after Code workspace minutes are also set aside) |
| Max ($100) | $2.34 | $24.07 (likewise) |

## Known limits

- **Site-wide count can be inflated.** Users can insert their own rows in `model_runs` (RLS), so a user could make the site-wide run count look higher than it is. That would stop runs for everyone until the month ends; it doesn't cost money. The site-wide AI spend cap has the same weakness. Fixing it needs the Supabase service role key, so usage rows can be written by the server only.
- **Rate limit is per server instance.** The per-minute limit (10 runs) is kept in each server instance's memory. The monthly allowance is enforced in the database.
