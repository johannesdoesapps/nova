/**
 * The Security Team's eleven agents as people see them on the dashboard: what each is for, what it actually does in
 * Orbis today, what it may touch, and a status taken only from real runs and logged events. An agent with no matching
 * run or event is "idle" — never shown as working or completed by default. Several agents share an engine (e.g. the
 * GitHub agent is Code Guardian reading GitHub), so one run can count for more than one card; that's stated, not hidden.
 */

export type AgentStatus = "idle" | "working" | "needs_approval" | "completed" | "error";

export interface RunLike {
  id: string;
  parent_id: string | null;
  agent: string;
  action: string;
  status: "running" | "completed" | "failed" | "cancelled";
  asset: string | null;
  tools: { tool: string; status: string; detail?: string }[];
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface EventLike {
  action: string;
  run_id: string | null;
  finding_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export interface IntegrationLike {
  id: "github" | "vercel" | "cloudflare";
  status: string;
  writeEnabled: boolean;
}

export interface TeamInput {
  runs: RunLike[];
  events: EventLike[];
  integrations: IntegrationLike[];
  /** Findings with a proposed patch waiting for the person's decision. */
  fixesAwaitingApproval: number;
  activeSchedules: number;
  alertsByEmail: boolean;
}

export interface AgentCard {
  id: string;
  name: string;
  /** What it runs on, shown under the name. */
  engine: string;
  summary: string;
  responsibilities: string[];
  /** What the summary describes that Orbis doesn't do yet (shown, so the card doesn't overpromise). */
  notYet: string | null;
  status: AgentStatus;
  statusNote: string | null;
  lastActivity: { label: string; at: string; href: string | null } | null;
  permissions: string[];
  details: { label: string; href: string };
}

interface Def {
  id: string;
  name: string;
  engine: string;
  summary: string;
  responsibilities: string[];
  notYet?: string;
  /** Runs that are this agent's work. */
  runs?: (r: RunLike) => boolean;
  /** Logged events that are this agent's work. */
  events?: (e: EventLike) => boolean;
  permissions: (i: TeamInput) => string[];
  details: { label: string; href: string };
}

const conn = (i: TeamInput, id: IntegrationLike["id"]) => i.integrations.find((x) => x.id === id);
const connLabel = (i: TeamInput, id: IntegrationLike["id"], name: string, write: string) => {
  const c = conn(i, id);
  if (!c || c.status !== "connected") return `${name}: not connected`;
  return c.writeEnabled ? `${name}: read, plus ${write} after your approval` : `${name}: read-only`;
};
const isGuardianAudit = (r: RunLike) => r.agent === "code_guardian" && (r.action === "audit" || r.action === "pr_audit");
const hasStep = (r: RunLike, label: string) => r.tools.some((t) => t.tool.startsWith(label) && t.status !== "skipped");

export const TEAM_AGENTS: Def[] = [
  {
    id: "auditor",
    name: "Security Auditor Agent",
    engine: "Code Guardian and Sentinel",
    summary: "Scans application code, APIs, dependencies, and configurations to identify potential security vulnerabilities before attackers can exploit them.",
    responsibilities: [
      "Secret and insecure-code rules for JavaScript/TypeScript, Python and PHP",
      "Known-vulnerable dependencies (OSV.dev) from your lockfiles",
      "Maps routes and API handlers and checks their sign-in, validation and rate limits",
      "Website checks (HTTPS, headers, cookies, CORS, exposed files) on sites you've proved you own",
      "Reads code only; never runs it",
    ],
    runs: (r) => isGuardianAudit(r) || (r.agent === "sentinel" && r.action === "scan"),
    permissions: (i) => ["Code you upload, or repositories you share", connLabel(i, "github", "GitHub", "PR comments"), "Websites you've verified (read-only requests)", "OSV.dev vulnerability database"],
    details: { label: "Code Guardian workspace", href: "/agents/security/guardian" },
  },
  {
    id: "verification",
    name: "Vulnerability Verification Agent",
    engine: "Independent verifier",
    summary: "Independently investigates suspected vulnerabilities, checks supporting evidence, and separates confirmed security issues from false positives and unverified risks.",
    responsibilities: [
      "Challenges each medium-or-worse code finding against the code around it, separately from the auditor",
      "Accepts “confirmed” or “disproven” only with an exact quote of the real code",
      "Marks disproven findings as false positives (you can reopen them)",
      "Re-checks findings to decide whether a fix really worked",
    ],
    runs: (r) => hasStep(r, "Independent verification"),
    events: (e) => e.action === "verification.disproven",
    permissions: () => ["Code already read for the audit (nothing new is fetched)", "One AI model call per audit, within your plan", "Can change a finding's verification, never its severity"],
    details: { label: "Findings", href: "/agents/security?tab=findings" },
  },
  {
    id: "protection",
    name: "Application Protection Agent",
    engine: "Sentinel on Cloudflare and Vercel",
    summary: "Reviews and helps configure Cloudflare security features, including DDoS protection, WAF rules, bot protection, rate limiting, and secure connections.",
    responsibilities: [
      "Reviews DDoS, WAF, bot, rate-limiting and TLS settings on Cloudflare, and deployment protection on Vercel",
      "Offers three reversible fixes: SSL Full (strict), Always Use HTTPS, minimum TLS 1.2",
      "Shows current value, impact and how to undo before anything changes; applies only after you approve, then reads it back",
      "Never changes DNS, firewall rules or Access policies",
    ],
    runs: (r) => r.agent === "sentinel" && (r.action === "cloudflare" || r.action === "deployment"),
    events: (e) => e.action.startsWith("cloudflare.change"),
    permissions: (i) => [connLabel(i, "cloudflare", "Cloudflare", "TLS setting changes"), connLabel(i, "vercel", "Vercel", "redeploys")],
    details: { label: "Cloudflare and Vercel results", href: "/agents/security?tab=history" },
  },
  {
    id: "identity",
    name: "Identity and Access Security Agent",
    engine: "Code Guardian rules and Cloudflare Access",
    summary: "Audits authentication, authorization, user permissions, sessions, admin access, OAuth integrations, and Zero Trust policies to prevent unauthorized access.",
    responsibilities: [
      "Finds routes and handlers without a sign-in or ownership check (code)",
      "Flags committed credentials and tokens",
      "Reviews Cloudflare Zero Trust Access: apps open to everyone, policies without MFA",
      "Checks Vercel preview protection and protection-bypass secrets",
    ],
    notYet: "Session settings, your identity provider's configuration and third-party OAuth grants aren't audited yet.",
    runs: (r) => isGuardianAudit(r) || (r.agent === "sentinel" && r.action === "cloudflare" && hasStep(r, "Zero Trust Access")) || (r.agent === "sentinel" && r.action === "deployment"),
    permissions: (i) => ["Code you share (read-only)", conn(i, "cloudflare")?.status === "connected" ? "Cloudflare Access: read-only (never changed)" : "Cloudflare: not connected", conn(i, "vercel")?.status === "connected" ? "Vercel protection settings: read-only" : "Vercel: not connected"],
    details: { label: "Findings", href: "/agents/security?tab=findings" },
  },
  {
    id: "reporting",
    name: "Security Reporting and Remediation Agent",
    engine: "Aegis reports and remediation",
    summary: "Turns audit results into clear security reports, prioritizes risks, recommends fixes, tracks remediation, and verifies whether vulnerabilities have been resolved.",
    responsibilities: [
      "Writes a report for each audit and one unified report for coordinated audits",
      "Ranks risks by severity and how certain they are",
      "Gives fix steps for every finding and tracks it to “Fixed (verified by re-check)”",
      "Exports reports when you ask",
    ],
    runs: (r) => hasStep(r, "AI report") || r.agent === "coordinated",
    events: (e) => e.action === "aegis.report" || e.action === "finding.updated",
    permissions: () => ["Your findings and run history", "One AI model call per report, within your plan", "Exports only when you ask"],
    details: { label: "Aegis command center", href: "/agents/security/aegis" },
  },
  {
    id: "github",
    name: "GitHub Security Agent",
    engine: "Code Guardian on GitHub",
    summary: "Audits authorized GitHub repositories, pull requests, code changes, dependencies, and repository settings to detect security risks throughout development.",
    responsibilities: [
      "Audits the repositories you shared with Orbis (read-only snapshot, nothing run)",
      "Pull-request audits: only changed files, each finding marked new or already there",
      "Dependency checks when a manifest or lockfile changes",
      "Posts a summary on the pull request only when you confirm",
    ],
    notYet: "Repository settings (branch protection, Actions permissions) aren't checked yet, and PRs aren't audited automatically on push.",
    runs: (r) => r.agent === "code_guardian" && (r.asset ?? "").startsWith("github:"),
    events: (e) => e.action === "pr.comment" || e.action === "pr.comment_failed",
    permissions: (i) => [connLabel(i, "github", "GitHub", "PR comments"), "Only repositories you chose on GitHub"],
    details: { label: "Code Guardian workspace", href: "/agents/security/guardian" },
  },
  {
    id: "vercel",
    name: "Vercel Deployment Security Agent",
    engine: "Sentinel on Vercel",
    summary: "Reviews Vercel projects, preview and production deployments, build settings, environment-variable exposure, and deployment configurations for security weaknesses.",
    responsibilities: [
      "Reads project settings, domains and recent deployments",
      "Checks environment-variable names, types and targets — never their values",
      "Checks preview protection, fork protection, public source and Node.js version",
      "Runs passive checks on the live production domain and an advisory deploy gate",
    ],
    runs: (r) => r.agent === "sentinel" && r.action === "deployment",
    events: (e) => e.action === "deployment_gate.evaluated",
    permissions: (i) => [connLabel(i, "vercel", "Vercel", "redeploys"), "Environment-variable values: never read"],
    details: { label: "Deployment audits", href: "/agents/security?tab=history" },
  },
  {
    id: "cloudflare",
    name: "Cloudflare Security Agent",
    engine: "Sentinel on Cloudflare",
    summary: "Inspects connected Cloudflare accounts and zones, checks available traffic-protection settings, identifies configuration gaps, and recommends improvements to live application security.",
    responsibilities: [
      "Reviews TLS/HTTPS, managed WAF, rate limiting, HTTP DDoS overrides and bot protection per zone",
      "Finds DNS-only records that reveal your origin server",
      "Lists what the token couldn't read and which permission would fix it",
      "Recommends fixes; three TLS settings can be applied after your approval",
    ],
    runs: (r) => r.agent === "sentinel" && r.action === "cloudflare",
    events: (e) => e.action.startsWith("cloudflare.change"),
    permissions: (i) => [connLabel(i, "cloudflare", "Cloudflare", "TLS setting changes"), "Only zones and areas your token allows"],
    details: { label: "Cloudflare reviews", href: "/agents/security?tab=history" },
  },
  {
    id: "monitoring",
    name: "Security Monitoring Agent",
    engine: "Scheduler and alerts",
    summary: "Monitors scheduled audit results, newly discovered vulnerabilities, configuration changes, and recurring issues, then alerts authorized users when important risks require attention.",
    responsibilities: [
      "Runs your scheduled audits daily or weekly, as you, read-only and without AI",
      "Notices new and reopened (recurring) findings after every audit",
      "Alerts you about confirmed or likely serious findings, by email if you allow it",
      "Records every scheduled run and alert in the security log",
    ],
    notYet: "Configuration changes are noticed when a scheduled audit runs, not the moment they happen.",
    events: (e) => e.action === "schedule.ran" || e.action === "alert.raised",
    permissions: (i) => [`${i.activeSchedules} active schedule${i.activeSchedules === 1 ? "" : "s"}`, "Your own connections, read-only", i.alertsByEmail ? "Email alerts: on" : "Email alerts: off"],
    details: { label: "Schedules and alerts", href: "/agents/security?tab=schedules" },
  },
  {
    id: "fix",
    name: "Security Fix Agent",
    engine: "Patch proposals and the coding agent",
    summary: "Proposes targeted code fixes, prepares patches or pull requests where supported, runs relevant tests, and retests vulnerabilities after fixes are applied. Requires approval for authorized write actions.",
    responsibilities: [
      "Proposes patches with a regression test for up to three findings per audit — never applied automatically",
      "Hands a finding to the coding agent, which edits, runs tests and opens a pull request only after you approve",
      "Applies approved Cloudflare TLS fixes",
      "Retests: a fix counts only when a re-check no longer finds the issue",
    ],
    events: (e) => e.action === "patch.proposed" || e.action === "fix.project_opened" || e.action === "cloudflare.change_applied",
    permissions: (i) => ["Writes nothing without your approval", connLabel(i, "github", "GitHub", "branches and pull requests"), connLabel(i, "cloudflare", "Cloudflare", "TLS setting changes")],
    details: { label: "Findings with proposed fixes", href: "/agents/security?tab=findings" },
  },
  {
    id: "orchestrator",
    name: "Security Orchestrator Agent",
    engine: "Aegis coordination",
    summary: "Coordinates the entire Security Team, assigns tasks to the appropriate agents, combines their findings, resolves conflicting results, and ensures that audits follow the correct security and approval procedures.",
    responsibilities: [
      "Plans coordinated audits and runs each agent in order",
      "Combines findings, links related ones across agents and merges duplicates",
      "Refuses a second identical audit while one is already running",
      "Sends every change through Bastion's approval rules",
    ],
    runs: (r) => r.agent === "coordinated",
    events: (e) => e.action.startsWith("aegis."),
    permissions: () => ["Starts the agents above", "Can't change anything itself", "Bastion policy applies to every step"],
    details: { label: "Aegis command center", href: "/agents/security/aegis" },
  },
];

const RUN_LABEL: Record<string, string> = {
  audit: "Code audit",
  pr_audit: "Pull-request audit",
  scan: "Website scan",
  deployment: "Vercel deployment audit",
  cloudflare: "Cloudflare review",
  investigate: "Log investigation",
};
const EVENT_LABEL: Record<string, string> = {
  "verification.disproven": "Disproved a finding",
  "cloudflare.change_applied": "Applied an approved Cloudflare change",
  "cloudflare.change_failed": "A Cloudflare change failed",
  "pr.comment": "Posted a pull-request summary",
  "pr.comment_failed": "Pull-request comment failed",
  "deployment_gate.evaluated": "Evaluated the deploy gate",
  "schedule.ran": "Ran a scheduled audit",
  "alert.raised": "Raised an alert",
  "patch.proposed": "Proposed a patch",
  "fix.project_opened": "Opened a fix in the coding agent",
  "aegis.report": "Exported a report",
  "finding.updated": "Updated a finding",
};

const runLabel = (r: RunLike) => `${r.agent === "coordinated" ? "Coordinated audit" : (RUN_LABEL[r.action] ?? r.action)}${r.asset ? ` · ${r.asset.replace(/^github:/, "").slice(0, 60)}` : ""}`;

/** Each agent's card, with status and last activity from real runs and events only. */
export function teamAgents(input: TeamInput): AgentCard[] {
  return TEAM_AGENTS.map((d) => {
    const runs = d.runs ? input.runs.filter(d.runs).sort((a, b) => b.started_at.localeCompare(a.started_at)) : [];
    const events = d.events ? input.events.filter(d.events).sort((a, b) => b.created_at.localeCompare(a.created_at)) : [];
    const running = runs.find((r) => r.status === "running");
    const lastRun = runs.find((r) => r.status !== "running");
    const lastEvent = events[0];
    const lastRunAt = lastRun ? (lastRun.finished_at ?? lastRun.started_at) : null;

    let status: AgentStatus = "idle";
    let statusNote: string | null = null;
    if (running) {
      status = "working";
      statusNote = `${runLabel(running)} in progress`;
    } else if (d.id === "fix" && input.fixesAwaitingApproval > 0) {
      status = "needs_approval";
      statusNote = `${input.fixesAwaitingApproval} proposed fix${input.fixesAwaitingApproval === 1 ? "" : "es"} waiting for your decision`;
    } else {
      // The most recent of the last run and the last event decides between completed and error.
      const eventAt = lastEvent?.created_at ?? null;
      if (lastRun && (!eventAt || lastRunAt! >= eventAt)) {
        if (lastRun.status === "completed") status = "completed";
        else {
          status = "error";
          statusNote = lastRun.status === "cancelled" ? "Last run was cancelled" : (lastRun.error ?? "Last run failed").slice(0, 160);
        }
        // Verification's outcome is its own step inside the audit.
        if (d.id === "verification") {
          const step = lastRun.tools.find((t) => t.tool.startsWith("Independent verification"));
          status = step?.status === "failed" ? "error" : "completed";
          statusNote = step?.status === "failed" ? (step.detail ?? "Verification failed").slice(0, 160) : null;
        }
      } else if (lastEvent) {
        const failed = lastEvent.action.endsWith("_failed") || (lastEvent.action === "schedule.ran" && String(lastEvent.detail?.outcome ?? "").startsWith("failed"));
        status = failed ? "error" : "completed";
        if (failed) statusNote = String(lastEvent.detail?.outcome ?? lastEvent.detail?.error ?? "Last action failed").slice(0, 160);
      }
    }

    const fromRun = lastRun ? { label: runLabel(lastRun), at: lastRunAt!, href: `/agents/security/runs/${lastRun.id}` } : null;
    const fromEvent = lastEvent
      ? { label: EVENT_LABEL[lastEvent.action] ?? lastEvent.action, at: lastEvent.created_at, href: lastEvent.run_id ? `/agents/security/runs/${lastEvent.run_id}` : lastEvent.finding_id ? `/agents/security/findings/${lastEvent.finding_id}` : null }
      : null;
    const fromRunning = running ? { label: runLabel(running), at: running.started_at, href: `/agents/security/runs/${running.id}` } : null;
    const lastActivity = [fromRunning, fromRun, fromEvent].filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;

    return {
      id: d.id,
      name: d.name,
      engine: d.engine,
      summary: d.summary,
      responsibilities: d.responsibilities,
      notYet: d.notYet ?? null,
      status,
      statusNote,
      lastActivity,
      permissions: d.permissions(input),
      details: lastActivity?.href && d.id !== "monitoring" ? { label: "View latest result", href: lastActivity.href } : d.details,
    };
  });
}
