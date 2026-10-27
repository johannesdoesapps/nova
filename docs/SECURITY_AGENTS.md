# Orbis Security Team

`/agents/security` — three cybersecurity agents that work alone or together, coordinated by Aegis (command
center) and protected by Bastion (enforcement layer for every Orbis agent). Scanners
produce the findings; AI models only explain them, propose fixes, and write reports.

## Agents

| Agent                   | Action                       | Real tools it uses                                                                                                                                                                                                                                                      | Never does                                                                                                                                                                |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orbis Sentinel**      | Scan website, Security audit | Built-in header/config checks (HTTPS, HSTS, CSP, framing, nosniff, cookies, CORS, version disclosure, mixed scripts, security.txt); exposed-file checks (`.env`, `.git`, backups, server-status…) in _active_ scope only; in audits, read-only site mapping (see below) | Scan a site without fresh proof of ownership; follow links or redirects to other domains; reach private/internal addresses; sign in, submit forms or send attack payloads |
| **Orbis Threat Hunter** | Investigate threat           | Detection library (19 versioned rules, ATT&CK-mapped) over uploaded web, SSH/Linux auth, CloudTrail, Okta, Windows/Sysmon and DNS exports; investigations; AbuseIPDB reputation when `ABUSEIPDB_API_KEY` is set; CISA KEV catalogue | Claim continuous monitoring or data it never saw; confirm an attack or attribute it to a group from a score; perform any response action |
| **Orbis Code Guardian** | Audit code                   | Security: secret & insecure-code rules (JS/TS, Python, PHP), application map and config checks, OSV.dev vulnerabilities, AI review whose quoted code must exist. Engineering: module graph, 23 defect rules, dependency compatibility (lockfile, peers, engines), maintainability, change impact, regression memory; repairs via the coding agent | Run your code or tests during an audit; claim a check passed that didn't run; apply, commit, push or deploy changes (the coding agent can edit, with your approval of each plan and edit) |

**Coordinated investigation** runs the selected agents in order (Sentinel → Threat Hunter →
Code Guardian, each as its own cancellable request), links related findings with transparent
rules (e.g. SQL-injection code ↔ SQL-injection attempts in logs; an exposed file ↔ requests for
it in logs), then writes one report. Skipped or failed steps are reported as such.

**Planned agents** (shown as "Planned", not launchable): Orbis Incident Responder and Orbis
Threat Intelligence. To add one: add its entry in `src/lib/security/agents.ts`, a runner in
`src/lib/security/runners.ts`, a route under `src/app/api/security/`, and a form in
`src/components/security/forms.tsx`. Findings, history, the dashboard and exports pick it up
automatically; the database already accepts the `incident_responder` and `threat_intel` ids.

## Sentinel audits

**Security audit** (dashboard button, `POST /api/security/coordinate` with `audit`) runs Sentinel on a
verified website and Code Guardian on code (Threat Hunter on logs optionally), then analyses everything
together. The audit's settings are stored with the parent run and **enforced by the server** on every step
(a browser can't widen the scope or switch on AI review for the gate).

| Mode              | Website (standard budget)                        | Code                             | Decision                         |
| ----------------- | ------------------------------------------------ | -------------------------------- | -------------------------------- |
| Quick scan        | home page, 3 scripts                             | rules, map, dependencies (no AI) | findings                         |
| Deep audit        | up to 25 pages, 12 scripts, 15 endpoint checks\* | + AI review                      | findings, attack paths, coverage |
| Attack-path audit | 15 pages, 8 scripts, 20 endpoint checks\*        | + AI review                      | focus on chains                  |
| Pre-release gate  | 10 pages, 8 scripts, 10 endpoint checks\*        | no AI                            | **passed / failed / incomplete** |

\* only with active testing. Time budgets (short / standard / extended) scale these and cap crawl time.

**Site mapping** (`src/lib/security/crawl.ts`, `surface.ts`) — GET requests only, same host (and www twin),
robots.txt respected, sitemap read, links that look like actions (log out, delete, unsubscribe, reset, pay…)
never requested, a pause between requests. It records pages, forms (fields, password/file inputs,
anti-forgery fields), scripts (first/third party, integrity), API endpoints referenced by pages and scripts,
redirect-style parameters, technology hints, and what it didn't fetch. Findings: secrets in served
JavaScript, public source maps, third-party scripts without integrity, forms posting over HTTP, password
forms on HTTP, POST forms without anti-forgery fields (tentative), redirect parameters (informational).
**Active testing** adds: signed-out GETs to discovered endpoints that need no invented id (personal-looking
field _names_ are reported, values never stored) and a not-found page checked for stack traces. Sentinel
never signs in, submits forms, sends attack payloads or invents parameters.

**Application map** (`src/lib/security/code-map.ts`) — Next.js (app and pages), Express-style, Flask,
FastAPI and Django routes with what each handler visibly does (sign-in check, validation, rate limit, DB
read/write, privileged client, outbound fetch, upload, webhook signature, owner filter), trust boundaries,
frameworks, runtimes and security libraries. Findings (tentative unless stated): state-changing routes with
no visible sign-in check, id routes with no owner filter, unsigned webhooks (firm), request bodies written
straight to the DB (firm), server fetches of request-supplied URLs, auth routes without rate limits; config:
tables without RLS (firm), `using (true)` write policies, `pull_request_target` + head checkout, root
containers, unpinned images, CORS any-origin + credentials, open Firebase rules, public buckets, committed
`.env` files. Languages it can't map are listed as not assessed.

**Classification** (`details.ts`) — Confirmed (observed directly), Likely (firm pattern, or a tentative lead
corroborated by an independent source), Needs verification, Informational, False positive. Separate from
severity. Each finding page shows reproduction steps (test accounts and synthetic data only), expected vs
observed, realistic impact, what an attacker needs first, root cause, how to verify a fix, a CVSS vector only
where the rule's impact is well-defined, and the nine investigation steps (detect → retest) with what was
actually done — code findings say "not tested at runtime".

**Correlation and attack paths** (`correlate.ts`, `attack-paths.ts`) — code routes are linked to live
endpoints that answered signed out on the same path; a key in code is linked to the same masked key served to
browsers. Ten path rules (public secret, `.git` + committed secrets, XSS sink + weak CSP + readable session
cookie, permissive CORS, unprotected route confirmed live, unsigned billing webhooks, mass assignment, tables
without RLS, redirect parameters, logged injection attempts against string-built SQL). A path is
**theoretical** unless every step is confirmed, and then **"each step confirmed · chain not executed"** —
never "reproduced" or "compromised".

**Coverage, posture and the gate** (`audit.ts`, `audit-report.ts`) — every area of the brief is listed as
assessed / partly / not assessed with exactly what ran and what didn't (e.g. cross-account tests, sign-in
flows, business-logic abuse, load testing — not available). Posture is counts by severity and
classification; there is no score. The gate fails on open confirmed/likely findings of the chosen
severities (optionally also unverified ones), ignores accepted risks and false positives, and is
**incomplete** (treated as failed) if any planned step didn't finish. Each audit is compared with the
previous one of the same name; open findings the audit didn't re-check are counted, not hidden. The AI report
is written only from this data and must keep classifications and path statuses as given.

**Re-checks and fixes** — re-checking a site-map finding repeats a short mapping pass; findings are only
marked "not detected" at locations the run actually fetched again. "Fix with the coding agent" (repository
audits) opens a Code project with the repository, and the agent works with plan approval and edit review on:
smallest change, regression test, run the project's checks, look for the same weakness nearby, report exactly
what passed, failed or wasn't verified. Nothing is pushed or deployed; re-audit the repository after pushing
to verify the fix in Sentinel.

**Not built (said so in the product)**: scheduled monitoring (audits run when started), authenticated and
cross-account testing, external scanners (ZAP, Semgrep, Trivy), cloud-account permission review. No database
migration was needed: audit data lives in `security_runs.stats` (trimmed to its 20 KB limit, with the
trimming recorded).

## Threat Hunter

Open it from the Threat Hunter card ("Open investigations and detection lab") or at
`/agents/security/hunter`. Code: `src/lib/security/hunt/` (events, rules, investigate, intel, qa,
analyse, scenarios), runner `runHunterAgent` in `src/lib/security/runners.ts`.

**Sources.** Only log exports you upload or paste: web access logs, SSH and Linux auth/syslog (sudo,
su, useradd/usermod, crontab, systemd, auditd), CloudTrail (`Records` download or JSON lines), Okta
System Log, Windows Security/Sysmon/System events exported as JSON, DNS (Zeek, BIND query log, dnsmasq).
Every run records a source inventory per file: formats recognised, unrecognised lines, time range,
which fields are present, gaps in the timeline (longer than max(1 h, 20× the usual spacing)) and
assumptions (e.g. the year for syslog lines). SIEM, EDR, network flow, email security, live cloud audit
feeds and Kubernetes audit logs are **not connected**; the product lists what each blind spot hides.

**Detection library** (`rules.ts`, 19 rules, 27 built-in test cases). Each rule has an id, version and
changelog, ATT&CK tactic and techniques, the hypothesis it tests, required fields, logic, how severity is
chosen, known benign causes, tuning advice, limitations, hunting queries (Splunk SPL, Microsoft Sentinel KQL,
shell) and positive/negative test cases that run in the test suite and live in the Detection lab. Rules:
sign-in attacks (brute force, spraying, success after failures, sign-in from a new source — only for
accounts with ≥ 7 days and ≥ 10 sign-ins of history), web payloads and scanning, sudo to a root shell,
admin rights granted, accounts and credentials created, scheduled jobs/services, logging switched off,
suspicious parent/child processes, obfuscated or download-and-run commands, cloud root activity, cloud
exposure changes, large transfers, DNS tunnelling and NXDOMAIN bursts. Orbis never deploys a detection
anywhere; the queries are for you to run in your own tools.

**Investigations** (`investigate.ts`). Signals are grouped by account, host or address. An address links
signals only when it isn't shared (fewer than three different users signed in successfully from it);
failures from shared addresses are downgraded. Each investigation has: severity, confidence (with its
basis) and urgency as separate fields; a timeline; the ATT&CK stages with each marked observed, attempted
or inferred; malicious and benign hypotheses with what supports and contradicts each; open questions and
what couldn't be checked; a response plan (priorities, evidence to preserve, scoping, containment,
credentials, further investigation, eradication, validation, follow-up) where every item is a
recommendation — items that change systems are marked as needing approval; structured handoffs (task,
scope, evidence, confidence, permissions, open questions) to Sentinel, Code Guardian, Research and
Writing; and links to earlier investigations that share an account, host or unshared address.
States: New, Investigating, Suspicious, Likely malicious, Confirmed malicious, Benign, Inconclusive,
Contained, Resolved. The engine only sets Suspicious, Likely malicious or Inconclusive. Confirmed
malicious, Benign, Contained and Resolved are set by a person with a required note
(`PATCH /api/security/runs/[id]/investigations/[invId]`), which also records approved / declined / done /
verified for each response item; every change goes to the audit trail.

**Intelligence** (`intel.ts`). IP reputation from AbuseIPDB (when configured) is stored with source,
retrieval date, last report date and caveats (shared hosting, CDN, Tor, allow-listed, stale > 30 days).
Domains and URLs are recorded as not checked. `GET /api/security/intel` matches the public CISA Known
Exploited Vulnerabilities catalogue against your stack: CVEs already listed by a Code Guardian dependency
finding are verified matches; products seen in a Sentinel or Guardian map, added to the catalogue in the
last year, are leads (your version isn't known). Reputation and catalogue matches are context, never proof.

**Report and QA.** The AI writes the summary only from the investigation data. A deterministic check
(`qa.ts`) then flags named threat groups or state involvement not in the evidence, certainty beyond the
investigations' states, claims about SIEM/EDR/firewall data Orbis didn't have, and claims of monitoring.
Flags are shown with the report; the report isn't rewritten.

**Validation** (`scenarios.ts`, `tests/threat-hunter.test.ts`). Ten synthetic scenarios (documentation
IP ranges and example domains): five malicious (SSH takeover with a backdoor account, cloud root misuse,
macro document launching an encoded command, DNS tunnelling, sign-in from a new source) and five benign
(internet background scanning, an office behind one address, routine administration, security-product DNS,
planned key rotation). Current result: all expected detections found (19/19), no medium-or-worse alert in
any benign scenario, and no benign scenario reaches Likely malicious. These are synthetic checks, not a
measure of performance on real environments. The Detection lab re-runs them in the browser, and lets you
run the whole analysis locally on a file without saving anything.

**Storage.** No migration: investigations, inventory, intelligence and QA notes live in
`security_runs.stats`, which the database caps at 20 KB (`fitHuntStats`, `compactInvestigations`).
Every investigation stays visible: the highest-priority ones keep their full structure at shorter detail,
the rest are stored as summaries (state, accounts, signals; no timeline or response plan), and the page
says so. About 1.5 KB is kept free for decisions people record; decision notes are stored shortened in the
run (full text in the audit trail), and the record is re-compacted if it would overflow. A typical hunt with
four investigations stores one in full and three as summaries. Raising the cap would need a database
migration.

## Code Guardian engineering analysis

Open it from the Code Guardian card ("Open code health, impact analysis and repairs") or at
`/agents/security/guardian`. Code: `src/lib/security/guardian/` (source, graph, profile, defects, semver,
compat, maintain, impact, memory, repair, analyse); it runs as the "Engineering analysis" and "Regression memory"
steps of every Code Guardian audit (`runGuardianAgent`). Engineering findings use the rule prefixes `quality.`
(defects), `compat.` (dependencies) and `arch.` (maintainability); they're stored with the other findings but
excluded from every security count, report and correlation (`listFindings` `scope`), and listed separately on
run pages and in the workspace.

**What it reads.** The files of the audit — a GitHub snapshot or an upload. Nothing is executed: tests, type
checks, lint and builds are listed with their commands as "not run". Uploads may be partial, so imports that
don't resolve are reported as defects only for GitHub snapshots.

**Project profile.** Languages and lines, frameworks and versions (package.json, requirements, pyproject), runtime
declarations (engines, .nvmrc, Dockerfile, requires-python), scripts, test files/frameworks/command, CI workflows
and whether they run tests/lint/typecheck/build, environment variables referenced in code versus documented in
`.env.example` or docs, migrations, docs and decision records, entry points.

**Module graph.** Imports, requires, re-exports and dynamic imports (JS/TS, with tsconfig/jsconfig `paths`
aliases) and Python imports (indented imports count as lazy). From it: runtime import cycles (Tarjan; type-only
and lazy imports excluded), imports that point at no file (with a "differs only in letter case" check — works on
macOS, fails on Linux), files nothing imports, exports nothing imports (split into dead and "only used in its own
file"), and the most depended-on files.

**Defect rules** (`defects.ts`, 23 rules, each with failure scenario, impact, fix, how to test the fix, and its
own positive and negative cases in the test suite): async callbacks in forEach, async useEffect, NaN comparisons,
impossible typeof checks, assignment in conditions, self-comparison, React state mutated then set, unguarded
JSON.parse of browser storage, fetch responses used without a status check, unawaited `res.json()`, API routes
returning an error body with status 200, intervals and listeners never cleaned up, awaited I/O inside loops (N+1),
getYear, UTC date used as "today", `map(parseInt)`, duplicate case labels, promise chains without a rejection
handler, empty catch blocks, Python mutable defaults, bare except and `is` with literals. Rules match code with
comments removed and string contents blanked; test files are skipped; evidence lines are redacted for secrets.

**Dependency compatibility** (`compat.ts`, package.json + package-lock v2/v3; security advisories stay with the
OSV check): package.json ranges the lockfile doesn't satisfy (npm ci fails), imports of undeclared packages
(high when not installed at all, medium when present only as someone else's dependency), peer-dependency
conflicts, packages that need a newer Node than the project allows (low when only dev tools are affected),
deprecated direct dependencies, unused dependencies, packages declared twice, unpinned versions, and .nvmrc
versus engines. Semver matching is local (`semver.ts`, checked against npm's semver).

**Maintainability** (`maintain.ts`): long (>120 lines) and branch-heavy (>25 decision points) functions, files
over 800 lines, import cycles, duplicated blocks (≥10 identical lines; ≥15 become findings), and TODO/FIXME/HACK/XXX
in comments. Each recommendation states the benefit and risk and is marked as optional, not urgent.

**Change impact** (`impact.ts`, the Impact analysis tab, `POST /api/security/guardian/impact`): for files you plan
to change, every direct and indirect dependent, the entry points and tests that reach them, files with no test,
concerns (dependencies, migrations, auth, CI/deploy config, build config, API contracts), a risk level with its
reasons, a test plan that starts with the tests importing the changed code and widens to the full suite with the
risk (commands from the project's scripts and test framework, all marked "planned"), and a rollback approach for
high-risk changes. It reads a fresh GitHub snapshot and changes nothing.

**Repair** (`repair.ts`, `POST /api/security/findings/[id]/fix`): opens a Code project from the repository and
starts the coding agent with plan approval and edit review on. The task gives the evidence, the change-impact
report and the checks to run, and requires the nine-step workflow: confirm the finding, reproduce it with a
failing test before editing (or say it can't be reproduced and stop), trace, isolate, check alternatives, make the
smallest root-cause fix in the project's conventions, run the reproducer and the planned checks (stop after two
failed attempts), look for side effects and the same root cause elsewhere, and report what ran, what passed or
failed, whether the defect was reproduced and resolved, remaining risks and what couldn't be verified —
"implemented but unverified" when no check could run. Dependency changes, migrations, auth changes, CI changes,
refactors across modules and interface changes to widely used files need the user's approval first. Nothing is
pushed or deployed. Files over the Code project's 1 MB file limit (often lockfiles) can't be edited there; the
route says so and gives the manual steps.

**Regression memory** (`memory.ts`): from this repository's stored findings — findings that came back after being
fixed, findings seen in three or more scans, fragile files (three or more open findings, or a regression), the same
rule in three or more files, counts versus the previous audit, and findings the scan no longer detects. Only rule
ids, paths and titles are used. Flaky tests and test history aren't available (audits don't run tests).

**Validation** (`tests/code-guardian.test.ts`): every rule's own cases; a seeded project with 13 planted defects
(all found) and its corrected twin (no findings); graph, semver, compatibility, maintainability, impact, memory,
repair-task and storage tests. On this repository (1,036 files, about 3 s) the analysis reports 17 findings, none
above low severity: 2 import cycles, 5 very complex functions, 1 duplicated block, the dev-tool Node version
mismatch, and 8 low/tentative patterns.

**Storage.** No migration: the summary is stored in `security_runs.stats.guardian`, trimmed to about 8.5 KB
(`fitGuardianSummary`), alongside the application map within the 20 KB limit.

**Not built.** Executing tests or builds during an audit (the coding agent does that when it repairs), profiling
and benchmarks (performance findings are static patterns, never measured claims), type-aware analysis (rules are
text-based), pnpm/yarn lockfile compatibility checks, continuous monitoring, and automatic upgrades.

## Aegis — command center

`/agents/security/aegis` (`src/lib/security/aegis/`, API `/api/security/aegis`). Aegis decides and coordinates; it
doesn't scan and never changes a system. Everything is rebuilt on each load from stored findings and runs plus
the decisions people recorded (`security_audit` rows named `aegis.*`, append-only).

- **Roster** (`roster.ts`): Sentinel, Threat Hunter, Code Guardian and Bastion are available; Supply Chain,
  Identity and Incident Commander are partial (their work is done today by the agents above); Cloud Guardian,
  Red Team and Compliance & Privacy are **unavailable** and shown that way — no task is ever run or simulated for
  them, and their coverage domains read "Unavailable".
- **Unified model** (`model.ts`): assets (verified websites, audited repositories and uploads, log sources),
  identities seen in investigations, and facts you declare per asset (criticality, internet exposure, data held,
  owner, links). Declared links count as real; links Aegis suggests from shared names are hypotheses until you
  confirm them.
- **Prioritisation** (`risk.ts`): severity and confidence come from the agent; Aegis adds documented points for
  exposure, CISA KEV listing, malicious activity or attack attempts on the same asset, declared criticality and
  sensitive data. Tiers: immediate (credible, ≥ 50 points, and exploitation evidence or a critical internet-facing
  issue), priority, strategic. Every ranked risk shows its factors and points; the assumptions are listed on the
  page. Accepted risks need an expiry (1–366 days) and a reason; without one they're listed as excluded.
- **Attack paths** (`paths.ts`): single-domain chains plus cross-agent hypotheses (probe after a weakness, leaked
  credential with suspicious logins, KEV dependency with attacks on a linked system, logging switched off near
  serious weaknesses, low-severity web weaknesses that combine into session theft). Each says how its pieces
  relate (same asset, declared link, or *not linked — assumed*) and is marked **not reproduced**.
- **Tasks** (`orchestrate.ts`): investigate → repair → verify for each immediate risk (dependent, so sequential),
  assessments for stale or never-assessed assets (independent, parallel), link confirmations for you, and
  "not covered" tasks for unavailable domains (blocked). Each task has an id, scope, objective, due-by suggestion,
  completion criteria and dependencies; "done" comes from evidence (a newer run or a re-check), not from a click.
- **Investigations** (`workflow.ts`): a ten-step record per serious risk, filled in only from recorded data,
  with notes and a conclusion (exploitable / exploited / not exploitable / false positive / inconclusive) you add.
- **Remediation**: Proposed → Approved → In progress → Verification required, or Rolled back — set by people.
  **Verified / Partially resolved / Failed are set only by re-check evidence after the fix was applied**: a
  finding still detected after that time (failed), or a dated "not detected" re-scan after it (verified).
  `canTransition` refuses those statuses from people.
- **Coverage** (`coverage.ts`): web, code, supply chain, telemetry, identity, cloud, attack validation, compliance
  and intelligence — assessed, partial, not assessed or unavailable — plus stale assessments (> 30 days).
- **Reports**: executive, technical and operational (Markdown download, logged as `aegis.report`).

Evaluation: `tests/aegis.test.ts` (prioritisation, exceptions, attack-path honesty, duplicates, remediation
verification rules, empty-state honesty, unavailable agents, task sequencing, reports).

## Bastion — enforcement layer

`/agents/security/bastion` (`src/lib/bastion/`, APIs `/api/bastion`, `/api/admin/bastion`). Security is enforced
by the platform at the point each action runs, not requested from the AI.

- **Policy** (`policy.ts`): every protected action is an operation with a risk level (low, moderate, high,
  critical), a capability group and a floor. Agents: low and moderate allowed; high needs the user's approval of
  that exact action (bound by a hash of user, agent, operation and resource — it doesn't carry over to another
  command, agent, user or operation); critical refused, approved or not. People need explicit confirmation for
  critical actions. Agents can't change policy or grant permissions.
- **Fail closed**: controls (`app_settings.settings.bastion`, cached ~10 s per server) that can't be read or don't
  validate mean only low-risk actions go ahead; administrators can still repair them.
- **Emergency controls** (administrators): lockdown (only reading and analysis), suspend agents (running coding
  tasks stop at their next step; others can't start), switch capabilities off, raise risk levels. Each change is a
  new version with a summary and a restorable snapshot (last 20), requires explicit confirmation and an
  up-to-date version number, and is recorded in the admin audit log. The general settings save keeps Bastion's
  controls as stored.
- **Guards** (`guards.ts`): secret and sensitive (CI, deployment, migration) paths, recognised credential formats
  in new content, commands that read secret files, workspace path canonicalisation, outbound destination checks,
  and prompt-injection signals in untrusted content.
- **Containment**: five refused actions in one coding run stop the run.
- **Audit**: refusals, approval requests and approved high-risk actions are recorded in the user's
  `security_audit` (`bastion.deny`, `bastion.needs_approval`, `bastion.allow`) with the resource redacted; command
  output and file contents are never recorded. Administrators see decisions across users when the service key is
  configured.

Where it's enforced is listed in `src/lib/bastion/coverage.ts` and on the Bastion page: coding agents' commands
(in `execCommand`, so approvals, pair coding and verification are covered too) and file saves (`saveChanges`),
preview starts, connected-service reads and actions, GitHub pushes (credential files are never pushed), the
user's terminal, chat code runs, project downloads, Workforce ticks, agent starts, and security scan starts.

**Remaining bypass paths and limits (not fixed):**

- Commands run inside the project's sandbox. Bastion classifies the command line; a recognised command (e.g.
  `npm test`) runs whatever the project's scripts say, so a malicious `package.json` script isn't inspected.
  The sandbox's own network allowlist (npm, PyPI) is the control there.
- Prompt-injection detection is pattern-based and can be evaded. It adds a warning; the real protection is that
  the actions an injection might ask for are checked regardless.
- Credential detection recognises specific formats (AWS, GitHub, Stripe live, Anthropic/OpenAI-style, Slack,
  Google, Supabase, private keys). Other secrets in new files aren't caught.
- Suspension and lockdown reach other servers within the controls cache (~10 s); an action already running
  (a command mid-execution) finishes.
- Containment counts refusals from the audit trail; if that query fails, the run isn't stopped early (the
  individual refusals still apply).
- Chat answers, research and code review aren't routed through Bastion's network switch; their web searches
  still run. Exports other than project downloads (research and security reports) aren't covered.
- Security scans are checked when they start, not per request; their own SSRF guard (`src/lib/security/net.ts`)
  limits requests to verified sites.
- Workforce sandbox commands use the Workforce's own command rules; Bastion checks each tick, not each command.
- Users act on their own data under row-level security; Bastion's records live in the user's own append-only
  audit trail, so a user can add (not change or remove) rows there.

Tests: `tests/bastion.test.ts` (decisions, approvals not carrying over, fail-closed, lockdown, suspension,
capability switches, floors, guards for secrets, commands, traversal, SSRF destinations and injection, redaction,
views, enforcement-point files exist) and the "Orbis Bastion in a coding task" cases in
`tests/code-agent-engine.test.ts` (credential written into code refused, CI file sent to review, destructive
command never runs even when approved, secret-reading command needs approval, output redacted, suspended agent
stopped mid-task, unreadable controls pause work).

Customers see and control Bastion for their own workspace (posture, findings, agent and application protection,
restrict-only policies, roles, audit log, notifications) through **Bastion Customer Security** — see
`BASTION_CUSTOMER.md`.

## Shared finding format

Every agent writes the same structure (`security_findings`): id, title, description,
**severity** (critical/high/medium/low/info) with rationale, **confidence**
(confirmed/firm/tentative — separate from severity), asset, location, evidence + evidence
source, remediation, references, status (open, investigating, fix proposed, fixed, accepted
risk, verified, false positive), verification (not re-checked / still present / not detected),
related findings, duplicate-of, reviewer note, proposed patch and tests.

Findings are de-duplicated by a fingerprint per user. Re-scans update existing findings; a
finding that was fixed and reappears is reopened; a finding a re-scan checked for and didn't
find is marked "not detected" (fixed → verified). There is **no security score** — the
dashboard shows plain counts of open findings by severity.

## Safeguards

- **Authorization in the backend**: every endpoint requires a signed-in user; Row Level
  Security isolates each user's targets, runs, findings and audit trail.
- **Website ownership** is proved by a token at `/.well-known/orbis-security-verification.txt`
  or a TXT record on `_orbis-verify.<domain>`, re-checked by the server immediately before
  every scan. Administrators may scan this Orbis deployment's own domain without a token.
  Every scan also requires an explicit "I'm authorised" confirmation.
- **SSRF protection**: only ports 80/443, public DNS names, no credentials in URLs; each
  connection's resolved IP is checked at connect time (blocks private, loopback, link-local,
  cloud-metadata and CGNAT ranges, including DNS-rebinding), redirects are not followed off-site.
- **Limits**: 12 agent runs per user per 10 minutes, 4 scans per website per 10 minutes,
  8 s per request, response size caps, 3 MB per upload, 40 MB GitHub tarballs, function timeouts.
- **Untrusted input**: code, logs, headers and scanner output are fenced as data in prompts;
  AI output can't trigger any action. AI-only code findings are kept only when the quoted line
  exists in your file, are marked tentative and capped at high severity.
- **No command execution**: scanners are plain HTTP requests and text analysis; nothing from
  a scan or a model is ever executed.
- **Secrets**: API keys stay in server env vars; secrets found in code or `.env` exposures are
  masked in evidence.
- **Audit trail** (`security_audit`, append-only for users): target added/verified, scans,
  investigations, audits, patch proposals, finding changes (with before/after), exports.

## Configuration

| Setting | Enables |
|---|---|
| (none) | Header checks, exposed-file checks, code rules, OSV dependency checks, log analysis, public GitHub repos |
| An AI provider key (OpenAI, Anthropic, Gemini, DeepSeek) | AI reports, AI code review, proposed patches (the user can pick any model or Auto) |
| `ABUSEIPDB_API_KEY` | IP reputation for Threat Hunter |
| The person's GitHub connection (Connectors) | Their private repositories, pull-request audits, PR summary comments (with write access and confirmation) |
| The person's Vercel connection | Vercel deployment audits and the advisory deploy gate |
| The person's Cloudflare API token | Cloudflare protection reviews and approved TLS setting fixes |
| `GITHUB_TOKEN` | Private repositories — administrators only (fallback when they haven't connected GitHub) |
| `CRON_SECRET` + `SUPABASE_SERVICE_ROLE_KEY` | Scheduled audits (`/api/cron/security`, daily 07:17 UTC) |

See [SECURITY_TEAM.md](SECURITY_TEAM.md) for the Security Team workflows built on these connections.

## Not connected yet (shown as "Not connected", never simulated)

OWASP ZAP, Semgrep, Trivy and Wazuh need a separate, isolated scanner runner (containers with
their own resource limits) — they cannot run inside Vercel serverless functions. Domain/URL
reputation services are not connected either. Orbis does not monitor systems continuously: scheduled
audits run once a day at most.
