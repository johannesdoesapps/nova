# Orbis Security Team — GitHub, Vercel and Cloudflare

The Security Team is the set of security capabilities on `/agents/security`, coordinated by Aegis and guarded by
Bastion (see [SECURITY_AGENTS.md](SECURITY_AGENTS.md)). This page covers what was added for auditing real
repositories, pull requests and deployments, and for reviewing live protection on Cloudflare.

## Roles

| Role (brief) | What does it in Orbis |
|---|---|
| Security Auditor | Code Guardian (code, dependencies, routes, auth checks, config) and Sentinel (websites you proved you own) |
| Vulnerability Verification | The independent verification step plus classification (confirmed / likely / needs verification / disproven) and re-checks |
| Application Protection | Sentinel's `deployment` (Vercel) and `cloudflare` actions |
| Identity & Access | Code Guardian's auth/ownership rules and the Cloudflare Zero Trust Access review |
| Reporting & Remediation | Aegis reports, fix proposals (never applied without approval), retests, history |

The roles are modules of existing agents rather than new agent ids, so no database migration was needed.

## Audit phases

1. **Scope** — what's connected, what's readable; anything unreadable is listed as not checked.
2. **Attack surface** — routes, auth checks and data access (code map); project, domain and DNS inventory (Vercel, Cloudflare).
3. **Investigation** — rules, OSV, AI review (when allowed), configuration rules.
4. **Independent verification** — a separate model call challenges each medium-or-worse, not-yet-certain code
   finding against ±30 lines of the real code. "Confirmed" and "disproven" are accepted only with an exact quote of
   the shown code; otherwise they're downgraded to "likely" / "unverified". The verifier can't raise severity or
   add findings; repository text is treated as data. Disproven findings become false positives that people can reopen.
5. **Risk** — severity per finding (Critical…Info) with the reason; no single score is presented as proof.
6. **Reporting and remediation** — run report, finding pages, fix proposals, retests.

Finding statuses shown to people: Open, In progress, Fix proposed, Awaiting verification (`fixed`), Accepted risk
(needs a written reason), Fixed — verified by re-check (`verified`, set only by a re-check that no longer detects it;
the API refuses it from people), False positive / disproven.

## GitHub (Workflow A, F)

- Private repositories are read through **the person's own GitHub connection** (`/api/security/github/repos`
  lists only the repositories they shared with Orbis's GitHub App). Administrators may still fall back to
  `GITHUB_TOKEN`. Public repositories work without signing in.
- **Pull-request audit** (`source: { type: "github_pr" }`): the whole repository at the PR head is read for context,
  but only findings in changed files are reported; each is marked *introduced* (on an added line or new file) or
  *already present*. Dependency findings count only when a manifest or lockfile changed. Earlier findings are
  re-checked only in files the PR still changes.
- **PR comment**: posted only when the person clicks and confirms, with write access granted, through Bastion, once
  per audit. It lists titles, severities and locations — never evidence, code or secrets.
- Re-checking a PR finding re-runs the PR audit on the PR's latest commit.
- Nothing from a repository is executed.

## Vercel (Workflow B, C)

`POST /api/security/vercel/audit` with `{ project, teamId?, gate?, siteChecks? }`:

- Reads project settings, environment-variable **metadata** (name, type, targets — `decrypt` is never requested
  and any value Vercel includes is dropped while parsing), domains and recent deployments.
- Findings: secret-like names exposed to the browser (`NEXT_PUBLIC_…`; needs verification), secrets stored as
  plain, one variable shared by Production and Preview, unprotected previews (backed by one passive request to a
  real preview), fork protection off, public source, directory listing, end-of-life Node.js, unverified domains,
  and the number (never the values) of protection-bypass secrets.
- Passive header/TLS/cookie checks on the project's verified production domain (ownership: it's a verified domain
  of a project the person's own token can read).
- **Deploy gate**: `warn` or `block` on chosen severities, counting this audit plus the linked repository's open
  Code Guardian findings. Findings that still need verification never block. A check that didn't run makes the
  result *incomplete*, not a pass. The gate is advisory: Orbis doesn't stop builds on Vercel.

## Cloudflare (Workflow G)

Connected with a **scoped API token** the person creates in Cloudflare (Cloudflare has no OAuth for third-party
apps). `POST /api/connectors/cloudflare/token` verifies it (`/user/tokens/verify`, or a zone read for account
tokens), stores it sealed with `ORBIS_CONNECTOR_KEY`, and never returns, logs or sends it to a model.

Suggested read-only token: Zone Read, Zone Settings Read, DNS Read, Zone WAF Read, Bot Management Read,
Access: Apps and Policies Read, Analytics Read. Add Zone Settings Edit only to allow approved fixes.

`POST /api/security/cloudflare/audit` reviews up to five zones (or one): SSL mode, Always Use HTTPS, minimum TLS,
HSTS, managed WAF (deployed / log-only), rate limiting, HTTP DDoS overrides, bot protection, DNS-only records
(confirmed origin exposure when a DNS-only record shares a proxied address), Zero Trust Access (Everyone allowed or
bypassed; no MFA as a lead) and 24-hour security event counts. Each area records *checked*, *missing permission*,
*unavailable* or *error*; the run says when it's incomplete and names the permission to add. Unreadable areas
produce no findings and their earlier findings are left untouched.

**Approved changes** (`/api/security/cloudflare/changes`): only SSL mode → Full (strict), Always Use HTTPS → on, and
minimum TLS → 1.2. The proposal shows the live current value, the new value, the impact and how to undo it. Applying
needs `{ confirm: true }`, the current value the person saw (otherwise nothing is written), write permission on the
connection and a Bastion allow; the setting is read back, the attempt is logged with before/after/rollback, and the
finding becomes "awaiting verification" until a re-check confirms it. DNS, firewall rules and Access policies are
never changed by Orbis.

## Schedules and alerts (Workflow D, E)

- `GET/POST /api/security/schedules`: up to 10 daily or weekly audits of a GitHub repository, a Vercel project or
  Cloudflare zones, plus alert settings. Stored as events in the append-only `security_audit` log.
- `/api/cron/security` (Vercel Cron, daily 07:17 UTC, `CRON_SECRET`) runs due schedules one at a time within four
  minutes; the rest wait for the next day. Each runs **as its owner** through `userScopedDb`: a service-role client
  that can reach only the audit tables, filters every read/update/delete by the owner's id, forces it on inserts,
  strips `user_id` from patches and refuses RPCs. Scheduled runs make no AI calls. Every attempt is logged.
- Website scans aren't schedulable: they re-check ownership proof, which needs the person.
- **Alerts**: after any run, new or reopened findings at or above the chosen severity (high by default) that are
  confirmed or likely are logged as `alert.raised` (shown in Recent events) and emailed if the person allows it.
  The email has titles and locations, never evidence.

Known limits: scheduled runs check that the Security Team isn't paused by an administrator but don't re-check the
person's plan on each run; a schedule whose connection has expired records a failed attempt.

## Audit log

Every action is in `security_audit` with actor (the row's user), time, target and outcome — e.g.
`pr.comment`, `deployment_gate.evaluated`, `cloudflare.change_applied` (before/after/rollback),
`cloudflare.change_failed`, `verification.disproven`, `schedule.set|removed|ran`, `alert.raised`,
`connector.connected`, `finding.updated`.

## Attribution

The verification discipline (only confirmed findings carry severity with certainty; independent validation that
must rest on source evidence; a coverage ledger; no live probing) is adapted from Cloudflare's
**security-audit skill**, which Cloudflare published under the MIT License. Orbis's implementation is
original code; the methodology is credited here as the licence asks.

## Tests

`tests/security-team.test.ts` (PR scoping, comment, verification guard rails, status rules, GitHub access),
`tests/security-vercel-audit.test.ts`, `tests/security-cloudflare.test.ts`, `tests/security-schedules.test.ts`
(scoped client isolation, schedules, alerts, the scheduler).
