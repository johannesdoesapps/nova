/**
 * Where Bastion is enforced, in the code that carries each action out — and where it isn't yet. Shown on the
 * Bastion page and in docs/SECURITY_AGENTS.md so nobody reads a protection into a place that doesn't have one.
 * Keep this list in step with the code (tests/bastion.test.ts checks the files named here exist).
 */

export type EnforcementState = "enforced" | "partial" | "not_covered";

export interface EnforcementPoint {
  surface: string;
  state: EnforcementState;
  ops: string[];
  where: string;
  note: string;
}

export const ENFORCEMENT_POINTS: EnforcementPoint[] = [
  {
    surface: "Coding agents' commands (Software Engineer, Bug Fixing, QA Testing, Website Builder, pair coding, verification)",
    state: "enforced",
    ops: ["command.run", "command.run.unclassified", "command.read_secrets", "command.destructive"],
    where: "src/lib/code/agent/engine.ts (execCommand)",
    note: "Every command an agent runs passes Bastion where it's executed, including ones the user approved and the checks Orbis runs itself. Destructive and publishing commands are refused for agents; unrecognised commands and commands that read secret files need the user's approval of that exact command.",
  },
  {
    surface: "Coding agents' file changes",
    state: "enforced",
    ops: ["file.write", "file.write.sensitive", "file.write.secret_content", "file.delete.bulk", "checkpoint.restore"],
    where: "src/lib/code/agent/engine.ts (saveChanges), src/lib/code/agent/tools.ts",
    note: "A credential written into a file is refused. Secret, CI, deployment and migration files, and more than five deletions at once, go to the user for review even when edits are otherwise saved straight away.",
  },
  {
    surface: "Coding agents' preview server",
    state: "enforced",
    ops: ["preview.start"],
    where: "src/lib/code/agent/tools.ts, src/lib/code/agent/engine.ts (startApprovedPreview)",
    note: "Checked when the agent starts it and when it starts after the user's approval.",
  },
  {
    surface: "Untrusted content shown to coding agents (files, command output, web results, GitHub, attachments)",
    state: "partial",
    ops: [],
    where: "src/lib/code/agent/tools.ts (untrusted), src/lib/bastion/guards.ts (detectInjection)",
    note: "Credentials are removed from command output and GitHub results. Text that looks like it's instructing the AI gets a warning in front of it. Detection is pattern-based and can be evaded; the protection that matters is that the actions it might ask for are checked above regardless of what the AI was told.",
  },
  {
    surface: "Connected services (Gmail, Calendar, Drive, GitHub and others)",
    state: "enforced",
    ops: ["connector.read", "connector.write"],
    where: "src/lib/connectors/runtime.ts (runTool, runAction)",
    note: "Reads can be switched off by an administrator; results have credentials removed and suspicious text flagged. Actions (sending, creating) run only after the user confirms that exact action, and only when the connection allows writing.",
  },
  {
    surface: "Pushing a project to GitHub",
    state: "enforced",
    ops: ["github.push"],
    where: "src/app/api/code/projects/[id]/github-push/route.ts",
    note: "Needs the user's confirmation in the push dialog. Files that hold credentials (.env, keys, files containing a recognised key) are never pushed.",
  },
  {
    surface: "The user's own terminal in Orbis Code",
    state: "enforced",
    ops: ["command.run", "preview.start"],
    where: "src/app/api/code/projects/[id]/exec/route.ts",
    note: "The user typed it, so it counts as approved; lockdown and an administrator switching commands off still apply.",
  },
  {
    surface: "Running chat code blocks",
    state: "enforced",
    ops: ["code.run"],
    where: "src/app/api/code/run/route.ts",
    note: "Runs in an isolated sandbox with no network; Bastion adds the administrator switch and lockdown.",
  },
  {
    surface: "Downloading a project",
    state: "enforced",
    ops: ["data.export"],
    where: "src/app/api/code/projects/[id]/download/route.ts",
    note: "Other exports (research reports, security reports) aren't routed through Bastion yet.",
  },
  {
    surface: "Workforce (operators' multi-agent runs)",
    state: "enforced",
    ops: ["workforce.step"],
    where: "src/app/api/workforce/tasks/[id]/advance/route.ts",
    note: "Checked at every tick. Individual Workforce sandbox commands use the Workforce's own command rules, not Bastion's.",
  },
  {
    surface: "Starting any agent task",
    state: "enforced",
    ops: ["agent.step"],
    where: "src/lib/agent-platform/server.ts (assertAgentAccess), src/lib/code/agent/engine.ts (step)",
    note: "A suspended agent can't start anything, and a running coding task stops at its next step. Five refused actions in one coding run stop that run.",
  },
  {
    surface: "Security scans (Sentinel, coordinated audits)",
    state: "partial",
    ops: ["web.search"],
    where: "src/app/api/security/sentinel/route.ts, src/app/api/security/coordinate/route.ts",
    note: "Checked when a scan starts, not per request; requests are limited to the user's verified sites by the scanners' own guard (src/lib/security/net.ts).",
  },
  {
    surface: "Links opened from chat messages",
    state: "enforced",
    ops: ["web.search"],
    where: "src/app/api/chat/route.ts (links), src/lib/links/read.ts",
    note: "Checked before Orbis opens links a user pasted (the network switch and lockdown apply). Each request, including redirects, goes to public addresses only; page text is passed to the model as untrusted data.",
  },
  {
    surface: "Chat answers, research and code review",
    state: "not_covered",
    ops: [],
    where: "—",
    note: "These produce text and don't act on anything outside Orbis. Their web searches aren't routed through Bastion's network switch yet.",
  },
  {
    surface: "Workspace policies (Bastion Customer Security)",
    state: "enforced",
    ops: ["command.run", "file.write", "preview.start", "connector.read", "agent.step"],
    where: "src/lib/bastion/server.ts (guard), src/lib/code/agent/runs.ts (createRun), src/lib/code/agent/engine.ts (step), src/lib/connectors/runtime.ts (runTool), src/app/api/agents/chat/route.ts, src/lib/agent-platform/server.ts (assertAgentAccess)",
    note: "A workspace's own restrictions are merged into every decision above and can only add to Bastion Core's: paused agents, switched-off capabilities, extra approvals, project boundaries for coding agents, which connected services agents may read, and tools removed from custom agents. When the policy can't be read, protected actions fail closed.",
  },
  {
    surface: "Changing Bastion's controls",
    state: "enforced",
    ops: ["policy.modify"],
    where: "src/app/api/admin/bastion/route.ts",
    note: "Administrators only (checked by the route and the database), with explicit confirmation, a version number and history. Agents can't change policy or approve their own actions.",
  },
];
