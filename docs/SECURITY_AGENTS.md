# Orbis Security Team

`/agents/security` — three cybersecurity agents that work alone or together. Scanners
produce the findings; AI models only explain them, propose fixes, and write reports.

## Agents

| Agent                   | Action                       | Real tools it uses                                                                                                                                                                                                                                                      | Never does                                                                                                                                                                |
| ----------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orbis Sentinel**      | Scan website, Security audit | Built-in header/config checks (HTTPS, HSTS, CSP, framing, nosniff, cookies, CORS, version disclosure, mixed scripts, security.txt); exposed-file checks (`.env`, `.git`, backups, server-status…) in _active_ scope only; in audits, read-only site mapping (see below) | Scan a site without fresh proof of ownership; follow links or redirects to other domains; reach private/internal addresses; sign in, submit forms or send attack payloads |
| **Orbis Threat Hunter** | Investigate threat           | Log analyzer for web access logs (combined/common), SSH auth logs and JSON lines; AbuseIPDB reputation when `ABUSEIPDB_API_KEY` is set                                                                                                                                  | Claim continuous monitoring; call an event a confirmed attack from a guess                                                                                                |
| **Orbis Code Guardian** | Audit code                   | Secret & insecure-code rules (JS/TS, Python, PHP); application map and config checks; OSV.dev dependency vulnerabilities (package-lock, yarn.lock, requirements.txt, package.json ranges); GitHub snapshots; AI review whose quoted code must exist in your files       | Apply, commit or deploy patches (the coding agent can, with your approval of each plan and edit)                                                                          |

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
| `GITHUB_TOKEN` | Private repositories — administrators only |

## Not connected yet (shown as "Not connected", never simulated)

OWASP ZAP, Semgrep, Trivy and Wazuh need a separate, isolated scanner runner (containers with
their own resource limits) — they cannot run inside Vercel serverless functions. Domain/URL
reputation services are not connected either. Orbis does not monitor systems continuously.
