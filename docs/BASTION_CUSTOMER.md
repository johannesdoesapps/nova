# Bastion Customer Security

`/agents/security/bastion` — the customer-facing layer of Orbis Bastion. Bastion has two layers:

- **Bastion Core** (`src/lib/bastion/*.ts`, see `SECURITY_AGENTS.md`): the mandatory enforcement every Orbis agent
  passes through. Managed only by Platform Security Administrators (Orbis administrators) on the Platform tab.
- **Bastion Customer Security** (`src/lib/bastion/customer/`): what a workspace sees and controls — posture,
  findings, agent and application protection, its own policies, its own audit log and notifications.

It is not a separate agent. It reuses Bastion Core's decisions, Code Guardian's scanners and finding store,
Sentinel's site verification, the connectors runtime, the email sender and the `security_audit` trail.

## Workspaces and tenancy

A workspace is one Orbis account (`ownerId`) and everything it owns: custom agents, Code projects, connected
services, shared chats, security findings and audit records.

- Every request resolves its workspace on the server (`resolveWorkspace` in `customer/workspace.ts`). Your own
  workspace makes you its owner. Any other workspace id must be a UUID, have a role grant visible through your own
  session (row-level security), both people must be in the same team, and the owner's tier must include roles —
  otherwise the answer is 404, the same as for a workspace that doesn't exist.
- Shared workspaces are read with the service client, but only after those checks, and every query is filtered by
  the owner id. Connector secrets are never selected; Code files are read as paths only.
- Tests: `tests/bastion-tenancy.test.ts` runs against an in-memory database that applies the same row rules as the
  migrations (`tests/stubs/tenant-db.ts`) and checks that every service query was filtered to the workspace being
  served. Removing the owner filter from a query makes it fail.

## Roles

| Role                            | Can                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| Workspace owner                 | Everything, including roles and revoking connected services                                       |
| Security administrator          | Policies, findings, assessments, pausing agents, access reviews. Not roles, not revoking services |
| Developer                       | See findings and inventories, run checks, work findings to a re-check. No policies, no audit log  |
| Viewer / auditor                | Read-only: overview, findings, inventories, policies, audit log                                   |
| Platform Security Administrator | Orbis administrators only. Bastion Core controls. Never a workspace role                          |

Permissions are checked by the API (`requirePermission`); the page hides buttons only as a convenience. Grants are
stored in `bastion_workspace_roles` (migration `20261107000000_bastion_workspace_roles.sql`): the owner and the
grantee can read a grant; only the owner can write one, and only for someone in the owner's team.

## Tiers

Plans map to tiers through Bastion Core's controls (`planTiers`, editable on the Platform tab); the default is
Free → Basic, Pro → Advanced, Max → Business, and unlimited administrator accounts are Business. Checked on the
server (`requireFeature`); a locked feature returns `plan_required` with what it needs.

| Tier     | Adds                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| Basic    | Overview, workspace checks, agent inventory, pausing agents, Quick check, critical and high findings, 7 days of history |
| Advanced | All severities, finding workflow, Deep assessment, Pre-deployment gate, Targeted recheck, workspace policies, 90 days   |
| Business | Team roles, custom retention, audit and findings export, 365 days                                                       |

Bastion Core protections apply on every plan. Prices and plan allowances are unchanged.

## Sections

- **Overview**: posture (At risk / Needs attention / No known issues in what was checked / Not assessed), with the
  rule that produced it. Never "secure": coverage lists what was assessed, partly assessed, not assessed or
  unavailable (identity providers and cloud accounts have no integration yet). Health shows whether Bastion's own
  controls, policy signatures, email and the last assessment are working.
- **Findings**: workspace checks (`customer/checks.ts`) plus application findings. Workflow: assign, investigate,
  suppress (reason and optional expiry required), request resolution. Requesting resolution only moves a finding
  to "pending verification"; it becomes resolved when a later check that actually ran no longer finds it. A check
  that couldn't run never resolves anything.
- **Agents**: inventory of Orbis task agents, chat agents and custom agents with their tools, connected services
  and projects. Pause/resume, restrict to projects, limit a custom agent's tools — each previewed, confirmed and
  recorded. Agents never gain privileges from here; restrictions are applied where the agent runs.
- **Applications**: Quick check (secrets and code rules), Deep assessment (adds the application map and dependency
  vulnerabilities from OSV), Pre-deployment gate (pass / fail / incomplete with the criteria used), Targeted
  recheck of selected findings. These read code; they never run it and are labelled as code checks, not runtime
  tests. Runs are stored as Code Guardian runs, so findings appear in Aegis too.
- **Workspace**: connected services (status, permissions, last used; owner can revoke, and success is reported only
  after the connection is confirmed gone), team roles, access reviews, shared chats.
- **Policies**: require approval for commands, file writes or previews; block capabilities; pause agents; limit
  agents to projects; allow-list connected services; custom-agent tool limits; notification preferences; retention.
  Policies can only restrict: they merge with Bastion Core by union and maximum, never weaken a Core rule, and are
  validated against the workspace's real agents, projects and connections. Saving shows a preview of the impact,
  needs confirmation and the current version number (a stale version is refused), and checks the new version is
  active before reporting success. Earlier versions can be restored the same way.
- **Audit log**: decisions and changes for this workspace with actor, workspace and correlation id; filters by area
  and text; integrity shown per record (signed / unsigned / invalid). JSON export on Business.
- **Notifications**: email through the existing sender for credentials found, critical findings, repeated blocks
  and Core control failures, per the workspace's preferences, at most once per period per kind. Wording says
  "detected", never "confirmed incident".

## How enforcement works

Customer policies are signed `bastion.policy` records in the owner's `security_audit` (HMAC with a key derived from
`ORBIS_CONNECTOR_KEY`). Unsigned or tampered records are ignored. `loadWorkspacePolicy` caches the active policy for
10 s; if it can't be read, Bastion fails closed — only low-risk actions go ahead (`decideWithWorkspace`).

Applied at: Bastion's `guard` (every enforcement point in Core), the coding agent's steps (paused agents, project
limits), coding-run creation, agent-platform access, connected-service tool calls by agents, and agent chat (paused
agents, custom-agent tool limits). `tests/bastion-bypass.test.ts` lists every call site that can run, push, act,
disconnect, write roles or change settings; a new one fails the test until reviewed.

## Deployment requirements

| Requirement                                            | Without it                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| Migration `20261107000000_bastion_workspace_roles.sql` | Shared team workspaces show "not set up"; own workspace works              |
| `ORBIS_CONNECTOR_KEY`                                  | Policies can't be signed, so they can't be saved; health shows the problem |
| `SUPABASE_SERVICE_ROLE_KEY`                            | Shared workspaces can't be read                                            |
| `RESEND_API_KEY`                                       | No emails; health shows email as not configured                            |

## Limitations and remaining paths

- No identity-provider (SSO, MFA) or cloud-account integration; shown as unavailable.
- No runtime telemetry beyond Sentinel scans of verified sites and logs uploaded to Threat Hunter.
- Application assessments read code; they don't run it or test a deployed application.
- The owner's own session can append (never change or delete) rows in their audit trail; unsigned rows are
  ignored for policies and marked unsigned in the log.
- Policy changes reach other servers within the 10 s cache; an action already running finishes.
- The Bastion Core limits in `SECURITY_AGENTS.md` still apply.

## Operating it

- **A customer says an agent is blocked**: Audit log → filter "Decisions"; `source` says whether Bastion Core
  ("platform") or their policy ("workspace") refused it.
- **Policy saves fail with a signature error**: check `ORBIS_CONNECTOR_KEY` is set in the deployment.
- **Change tier packaging**: Platform tab → Bastion controls → plan tiers. Recorded as a new controls version.
- **Workspace shows "policy unavailable"**: the audit table couldn't be read; non-low actions are refused until
  it can. Check Supabase health.
