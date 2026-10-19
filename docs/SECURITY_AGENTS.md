# Nova Security Team

`/agents/security` — three cybersecurity agents that work alone or together. Scanners
produce the findings; AI models only explain them, propose fixes, and write reports.

## Agents

| Agent | Action | Real tools it uses | Never does |
|---|---|---|---|
| **Nova Sentinel** | Scan website | Built-in header/config checks (HTTPS, HSTS, CSP, framing, nosniff, cookies, CORS, version disclosure, mixed scripts, security.txt); exposed-file checks (`.env`, `.git`, backups, server-status…) in *active* scope only | Scan a site without fresh proof of ownership; follow redirects to other domains; reach private/internal addresses |
| **Nova Threat Hunter** | Investigate threat | Log analyzer for web access logs (combined/common), SSH auth logs and JSON lines; AbuseIPDB reputation when `ABUSEIPDB_API_KEY` is set | Claim continuous monitoring; call an event a confirmed attack from a guess |
| **Nova Code Guardian** | Audit code | Secret & insecure-code rules (JS/TS, Python, PHP); OSV.dev dependency vulnerabilities (package-lock, yarn.lock, requirements.txt, package.json ranges); GitHub snapshots; AI review whose quoted code must exist in your files | Apply, commit or deploy patches |

**Coordinated investigation** runs the selected agents in order (Sentinel → Threat Hunter →
Code Guardian, each as its own cancellable request), links related findings with transparent
rules (e.g. SQL-injection code ↔ SQL-injection attempts in logs; an exposed file ↔ requests for
it in logs), then writes one report. Skipped or failed steps are reported as such.

**Planned agents** (shown as "Planned", not launchable): Nova Incident Responder and Nova
Threat Intelligence. To add one: add its entry in `src/lib/security/agents.ts`, a runner in
`src/lib/security/runners.ts`, a route under `src/app/api/security/`, and a form in
`src/components/security/forms.tsx`. Findings, history, the dashboard and exports pick it up
automatically; the database already accepts the `incident_responder` and `threat_intel` ids.

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
- **Website ownership** is proved by a token at `/.well-known/nova-security-verification.txt`
  or a TXT record on `_nova-verify.<domain>`, re-checked by the server immediately before
  every scan. Administrators may scan this Nova deployment's own domain without a token.
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
reputation services are not connected either. Nova does not monitor systems continuously.
