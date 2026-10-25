import { findSecrets } from "../../secrets";
import { hardSecrets } from "../guards";

/**
 * Essential workspace checks: what a workspace's own records show about its agents, connected services, sharing,
 * automation and access. Pure — the server loads a snapshot (only this workspace's rows) and these rules read it.
 * A check whose data couldn't be read is reported as unavailable, never as passed.
 */

export interface WorkspaceSnapshot {
  ownerId: string;
  now: number;
  team: { name: string; ownerIsYou: boolean; members: { userId: string; role: string; joinedAt: string }[]; grants: { userId: string; role: string; grantedAt: string }[] | null } | null;
  customAgents: { id: string; name: string; capabilities: string[]; instructions: string; updatedAt: string; lastUsedAt: string | null }[];
  connectors: {
    connectorId: string;
    name: string;
    status: string;
    writeEnabled: boolean;
    scopes: string[];
    aiMode: string;
    connectedAt: string;
    lastUsedAt: string | null;
    lastError: string | null;
  }[];
  sharedChats: { id: string; title: string; sharedUntil: string }[];
  projects: { id: string; name: string; sourceRepo: string | null; secretFiles: string[]; lastAssessed: string | null }[];
  codeRuns: { id: string; projectId: string; agent: string; createdAt: string; approvePlans: boolean; reviewEdits: boolean; commands: string; readOnly: boolean }[];
  verifiedSites: { hostname: string; verifiedAt: string; lastScan: string | null }[];
  logUploads: number;
  decisions: { agent: string; outcome: string; at: string; op: string }[];
  lastAccessReview: string | null;
  policyVersion: number;
  blockThreshold: number;
  /** Data sources that couldn't be read (their checks are unavailable). */
  unavailable: string[];
}

export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type FindingKind = "verified" | "suspected" | "informational";

/** A finding before workflow is applied. */
export interface RawFinding {
  id: string;
  checkId: string;
  kind: FindingKind;
  severity: Severity;
  confidence: "confirmed" | "firm" | "tentative";
  asset: string;
  assetLabel: string;
  title: string;
  description: string;
  evidence: string[];
  method: string;
  impact: string;
  remediation: string;
  /** Where to act on it (a page in Orbis). */
  href: string | null;
}

export interface CheckResult {
  id: string;
  area: string;
  label: string;
  state: "passed" | "failed" | "unavailable";
  note: string;
}

const DAY = 86_400_000;
const days = (now: number, iso: string | null) => (iso ? Math.floor((now - Date.parse(iso)) / DAY) : Infinity);

/** Stable finding id from the check and what it's about (so the same issue keeps its id across runs). */
export function findingId(checkId: string, subject: string): string {
  let h = 0x811c9dc5;
  const s = `${checkId}|${subject}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `BW-${(h >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
}

interface Check {
  id: string;
  area: string;
  label: string;
  /** Data the check needs (if any is unavailable the check is unavailable). */
  needs: string[];
  run(s: WorkspaceSnapshot): RawFinding[];
}

const METHOD = "Bastion workspace check (reads this workspace's own records; nothing is executed)";

const CHECKS: Check[] = [
  {
    id: "agents.secret-in-instructions",
    area: "Agents",
    label: "Custom agents' instructions don't contain credentials",
    needs: ["agents"],
    run: (s) =>
      s.customAgents.flatMap((a) => {
        const hard = hardSecrets(a.instructions);
        const soft = findSecrets(a.instructions).filter((k) => !hard.length || !/key|token/i.test(k));
        if (!hard.length && !soft.length) return [];
        return [
          {
            id: findingId("agents.secret-in-instructions", a.id),
            checkId: "agents.secret-in-instructions",
            kind: hard.length ? "verified" : "suspected",
            severity: hard.length ? "high" : "medium",
            confidence: hard.length ? "confirmed" : "tentative",
            asset: `agent:${a.id}`,
            assetLabel: a.name,
            title: `${a.name}'s instructions contain ${hard.length ? "a credential" : "what looks like a credential"}`,
            description: "Agent instructions are sent to the AI provider with every message, so anything in them leaves Orbis.",
            evidence: [`Recognised: ${[...hard, ...soft].join(", ")} (value not shown).`],
            method: METHOD,
            impact: "The credential is exposed to the AI provider and to anyone who can read the agent's settings; if it's real, it should be treated as leaked.",
            remediation: "Remove the value from the instructions, then rotate the credential with its provider. Keep secrets in environment variables, not in prompts.",
            href: `/agents/${a.id}`,
          } satisfies RawFinding,
        ];
      }),
  },
  {
    id: "integrations.write-unused",
    area: "Connected services",
    label: "Write access is only kept where it's used",
    needs: ["connectors"],
    run: (s) =>
      s.connectors
        .filter((c) => c.status === "connected" && c.writeEnabled && days(s.now, c.lastUsedAt ?? c.connectedAt) > 30)
        .map((c) => ({
          id: findingId("integrations.write-unused", c.connectorId),
          checkId: "integrations.write-unused",
          kind: "suspected" as const,
          severity: "medium" as const,
          confidence: "firm" as const,
          asset: `integration:${c.connectorId}`,
          assetLabel: c.name,
          title: `${c.name} has write access that hasn't been used for over 30 days`,
          description: "The connection lets Orbis create or send things in this service (each action still needs your confirmation).",
          evidence: [
            `Connected ${c.connectedAt.slice(0, 10)}; last used ${c.lastUsedAt ? c.lastUsedAt.slice(0, 10) : "never"}.`,
            `Permissions: ${c.scopes.length ? c.scopes.slice(0, 4).join(", ") : "(granted by the service)"}.`,
          ],
          method: METHOD,
          impact: "Unused write access widens what a mistaken or manipulated action could do, for no benefit.",
          remediation: "Reconnect it read-only, or disconnect it (Bastion → Agents → Revoke, or the Connectors page).",
          href: "/connectors",
        })),
  },
  {
    id: "integrations.needs-reauth",
    area: "Connected services",
    label: "Connected services are healthy",
    needs: ["connectors"],
    run: (s) =>
      s.connectors
        .filter((c) => c.status === "reauth_required" || c.status === "error")
        .map((c) => ({
          id: findingId("integrations.needs-reauth", c.connectorId),
          checkId: "integrations.needs-reauth",
          kind: "verified" as const,
          severity: "low" as const,
          confidence: "confirmed" as const,
          asset: `integration:${c.connectorId}`,
          assetLabel: c.name,
          title: `${c.name} ${c.status === "error" ? "is failing" : "needs to be reconnected"}`,
          description: "Orbis can't use this connection until it's fixed; a revoked or expired grant on the service's side also shows up here.",
          evidence: [c.lastError ? `Last error: ${c.lastError.slice(0, 160)}` : `Status: ${c.status}.`],
          method: METHOD,
          impact: "Monitoring and agent features that rely on this service don't work; an unexpected revocation can mean the account changed hands.",
          remediation: "Reconnect it from the Connectors page, or disconnect it if it's no longer needed.",
          href: "/connectors",
        })),
  },
  {
    id: "sharing.public-chats",
    area: "Data sharing",
    label: "No chats are shared by public link",
    needs: ["sharing"],
    run: (s) =>
      s.sharedChats.length
        ? [
            {
              id: findingId("sharing.public-chats", s.ownerId),
              checkId: "sharing.public-chats",
              kind: "verified",
              severity: s.sharedChats.some((c) => days(s.now, c.sharedUntil) > 90) ? "medium" : "low",
              confidence: "confirmed",
              asset: "sharing",
              assetLabel: "Shared chats",
              title: `${s.sharedChats.length} chat${s.sharedChats.length === 1 ? " is" : "s are"} readable by anyone with the link`,
              description: "A share link shows the chat (up to when it was shared) to anyone who has the link, without signing in.",
              evidence: s.sharedChats.slice(0, 8).map((c) => `“${c.title.slice(0, 80)}” — shared ${c.sharedUntil.slice(0, 10)}`),
              method: METHOD,
              impact: "Links get forwarded and indexed; whatever the chat contains is effectively public.",
              remediation: "Turn sharing off for chats that no longer need it (open the chat → Share → Stop sharing).",
              href: "/history",
            },
          ]
        : [],
  },
  {
    id: "automation.unreviewed-runs",
    area: "Automation",
    label: "Coding agents work with plan approval or edit review",
    needs: ["runs"],
    run: (s) => {
      const recent = s.codeRuns.filter((r) => days(s.now, r.createdAt) <= 30 && !r.readOnly && !r.approvePlans && !r.reviewEdits && r.commands !== "off");
      if (!recent.length) return [];
      return [
        {
          id: findingId("automation.unreviewed-runs", s.ownerId),
          checkId: "automation.unreviewed-runs",
          kind: "verified",
          severity: "low",
          confidence: "confirmed",
          asset: "automation",
          assetLabel: "Coding agents",
          title: `${recent.length} coding task${recent.length === 1 ? "" : "s"} in the last 30 days ran without plan approval or edit review`,
          description:
            "These tasks changed files and ran recognised commands without a person approving a plan or reviewing edits. Bastion still applied its rules (risky commands and sensitive files always needed approval).",
          evidence: recent.slice(0, 5).map((r) => `${r.agent.replace("_", " ")} task started ${r.createdAt.slice(0, 10)}`),
          method: METHOD,
          impact: "Mistakes — or instructions planted in files the agent read — reach your project without a person seeing them first.",
          remediation: "Keep “Approve the plan first” on for important projects, or require approval for every file change in Bastion → Policies.",
          href: null,
        },
      ];
    },
  },
  {
    id: "secrets.project-files",
    area: "Secrets",
    label: "Projects don't keep credentials in files",
    needs: ["projects"],
    run: (s) =>
      s.projects
        .filter((p) => p.secretFiles.length)
        .map((p) => ({
          id: findingId("secrets.project-files", p.id),
          checkId: "secrets.project-files",
          kind: "informational" as const,
          severity: "low" as const,
          confidence: "confirmed" as const,
          asset: `project:${p.id}`,
          assetLabel: p.name,
          title: `${p.name} stores ${p.secretFiles.length} secret file${p.secretFiles.length === 1 ? "" : "s"}`,
          description: "Orbis never shows these files to the AI and never pushes them to GitHub, but they're stored with the project.",
          evidence: [`Files: ${p.secretFiles.slice(0, 6).join(", ")}${p.secretFiles.length > 6 ? "…" : ""}`],
          method: METHOD,
          impact: "Anyone with access to the project (or a download of it) gets the credentials.",
          remediation: "Keep real credentials in your hosting provider's environment settings and use an .env.example with placeholders in the project.",
          href: `/code/${p.id}`,
        })),
  },
  {
    id: "bastion.repeated-blocks",
    area: "Agents",
    label: "No agent keeps hitting Bastion's rules",
    needs: ["decisions"],
    run: (s) => {
      const recent = s.decisions.filter((d) => d.outcome === "deny" && days(s.now, d.at) <= 7);
      const by = new Map<string, number>();
      for (const d of recent) by.set(d.agent, (by.get(d.agent) ?? 0) + 1);
      return [...by]
        .filter(([, n]) => n >= s.blockThreshold)
        .map(([agent, n]) => ({
          id: findingId("bastion.repeated-blocks", agent),
          checkId: "bastion.repeated-blocks",
          kind: "suspected" as const,
          severity: "medium" as const,
          confidence: "firm" as const,
          asset: `agent:${agent}`,
          assetLabel: agent.replace("_", " "),
          title: `${agent.replace("_", " ")} was refused ${n} times in the last 7 days`,
          description: "Repeated refusals usually mean a task the agent can't do within policy — or content it read trying to steer it. It's a signal to look at, not a confirmed incident.",
          evidence: [...new Set(recent.filter((d) => d.agent === agent).map((d) => d.op))].slice(0, 5).map((op) => `Refused: ${op}`),
          method: "Bastion's own enforcement records",
          impact: "If the agent was being steered by untrusted content, the refusals are what stopped it; the task itself may be compromised.",
          remediation: "Open the decisions on the Audit tab, check what the agent was working on, and pause it if the activity isn't expected.",
          href: null,
        }));
    },
  },
  {
    id: "sites.stale-verification",
    area: "Applications",
    label: "Website ownership proofs are recent",
    needs: ["sites"],
    run: (s) =>
      s.verifiedSites
        .filter((v) => days(s.now, v.verifiedAt) > 180)
        .map((v) => ({
          id: findingId("sites.stale-verification", v.hostname),
          checkId: "sites.stale-verification",
          kind: "informational" as const,
          severity: "info" as const,
          confidence: "confirmed" as const,
          asset: v.hostname,
          assetLabel: v.hostname,
          title: `${v.hostname} was verified over 6 months ago`,
          description: "Ownership is re-checked before every scan, so an old proof can't be misused; it's listed so you can remove sites you no longer own.",
          evidence: [`Verified ${v.verifiedAt.slice(0, 10)}.`],
          method: METHOD,
          impact: "None directly.",
          remediation: "Remove the site from the Security Team's websites if you no longer control it.",
          href: "/agents/security",
        })),
  },
  {
    id: "access.review",
    area: "Access",
    label: "Team access was reviewed in the last 90 days",
    needs: ["team"],
    run: (s) => {
      if (!s.team || s.team.members.length < 2) return [];
      const stale = s.team.grants?.filter((g) => !s.team!.members.some((m) => m.userId === g.userId)) ?? [];
      const out: RawFinding[] = [];
      if (stale.length)
        out.push({
          id: findingId("access.departed-grants", s.ownerId),
          checkId: "access.review",
          kind: "verified",
          severity: "low",
          confidence: "confirmed",
          asset: "access",
          assetLabel: "Workspace roles",
          title: `${stale.length} role${stale.length === 1 ? " is" : "s are"} held by people no longer in the team`,
          description: "Bastion refuses access when someone has left the team, but the grant is still on record.",
          evidence: stale.map((g) => `${g.role.replace("_", " ")} — user ${g.userId.slice(0, 8)}, granted ${g.grantedAt.slice(0, 10)}`),
          method: METHOD,
          impact: "If the person rejoins, the old role would apply again without anyone deciding it.",
          remediation: "Remove the role on the Workspace tab.",
          href: null,
        });
      if (days(s.now, s.lastAccessReview) > 90)
        out.push({
          id: findingId("access.review", s.ownerId),
          checkId: "access.review",
          kind: "informational",
          severity: "low",
          confidence: "confirmed",
          asset: "access",
          assetLabel: "Team access",
          title: s.lastAccessReview ? "Team access hasn't been reviewed for over 90 days" : "Team access has never been reviewed",
          description: `${s.team.members.length} people are in the team${s.team.grants?.length ? `, ${s.team.grants.length} with a role on this workspace` : ""}.`,
          evidence: s.team.members.slice(0, 10).map((m) => `${m.role} — user ${m.userId.slice(0, 8)}, joined ${m.joinedAt.slice(0, 10)}`),
          method: METHOD,
          impact: "People who changed role or left keep access longer than needed.",
          remediation: "Check the list on the Workspace tab and record the review.",
          href: null,
        });
      return out;
    },
  },
];

export const CHECK_IDS = CHECKS.map((c) => c.id);

export function runChecks(s: WorkspaceSnapshot): { findings: RawFinding[]; checks: CheckResult[] } {
  const findings: RawFinding[] = [];
  const checks: CheckResult[] = [];
  for (const c of CHECKS) {
    const missing = c.needs.filter((n) => s.unavailable.includes(n));
    if (missing.length) {
      checks.push({ id: c.id, area: c.area, label: c.label, state: "unavailable", note: `Couldn't read ${missing.join(", ")}.` });
      continue;
    }
    const f = c.run(s);
    findings.push(...f);
    checks.push({
      id: c.id,
      area: c.area,
      label: c.label,
      state: f.length ? "failed" : "passed",
      note: f.length ? `${f.length} finding${f.length === 1 ? "" : "s"}` : "Nothing found in this workspace's records.",
    });
  }
  return { findings, checks };
}

/* ---------------------------------------------------------------- coverage */

export interface CoverageArea {
  id: string;
  label: string;
  state: "assessed" | "partial" | "not_assessed" | "unavailable" | "not_applicable";
  note: string;
}

export function workspaceCoverage(s: WorkspaceSnapshot): CoverageArea[] {
  const assessedProjects = s.projects.filter((p) => days(s.now, p.lastAssessed) <= 30).length;
  const scannedSites = s.verifiedSites.filter((v) => days(s.now, v.lastScan) <= 30).length;
  const read = (key: string, label: string, id: string, note: string): CoverageArea =>
    s.unavailable.includes(key) ? { id, label, state: "unavailable", note: `Couldn't be read just now.` } : { id, label, state: "assessed", note };
  return [
    read("agents", "Agents and their tools", "agents", "Every custom agent and Orbis agent available to this workspace, checked on each visit."),
    read("connectors", "Connected services", "integrations", "Every connection's status and permissions, checked on each visit."),
    read("sharing", "Shared chats", "sharing", "Public share links, checked on each visit."),
    s.projects.length === 0
      ? { id: "projects", label: "Code projects", state: "not_applicable", note: "No Orbis Code projects." }
      : {
          id: "projects",
          label: "Code projects",
          state: assessedProjects === s.projects.length ? "assessed" : assessedProjects ? "partial" : "not_assessed",
          note: `${assessedProjects} of ${s.projects.length} checked in the last 30 days (Applications tab). Code checks read files; they don't run the application.`,
        },
    s.verifiedSites.length === 0
      ? { id: "sites", label: "Live websites", state: "not_assessed", note: "No verified websites: Bastion has no runtime view of your sites. Verify one on the Security Team page to scan it." }
      : {
          id: "sites",
          label: "Live websites",
          state: scannedSites === s.verifiedSites.length ? "assessed" : scannedSites ? "partial" : "not_assessed",
          note: `${scannedSites} of ${s.verifiedSites.length} verified sites scanned by Sentinel in the last 30 days.`,
        },
    {
      id: "telemetry",
      label: "Runtime logs",
      state: s.logUploads ? "partial" : "not_assessed",
      note: s.logUploads ? "Threat Hunter has logs you uploaded; there's no continuous log feed." : "No logs uploaded: Orbis doesn't monitor your systems' activity.",
    },
    { id: "identity", label: "Identity provider (SSO, MFA)", state: "unavailable", note: "No identity-provider integration exists in Orbis yet." },
    { id: "cloud", label: "Cloud accounts", state: "unavailable", note: "No cloud-account integration exists in Orbis yet." },
  ];
}
