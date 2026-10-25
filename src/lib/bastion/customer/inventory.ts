import type { CustomerPolicy } from "./policy";

/**
 * The workspace's agents as Bastion sees them: what each may do, what it can reach, what needs approval, what
 * Bastion refused recently, and whether a policy pauses or limits it. Pure. Only agents a customer can use are
 * listed — Orbis's internal agents and operator tools never appear here.
 */

export interface InventoryAgent {
  ref: string;
  kind: "task" | "chat" | "custom";
  name: string;
  purpose: string;
  owner: "Orbis" | "You";
  tools: string[];
  dataSources: string[];
  execution: string[];
  approvals: string[];
  lastActivity: string | null;
  paused: { by: "administrator" | "workspace" } | null;
  limits: string[];
  blocked7d: number;
  needsApproval7d: number;
  findings: number;
  compliance: "compliant" | "paused" | "attention";
  href: string | null;
}

export interface InventoryInput {
  taskAgents: { id: string; name: string; tagline: string; permissions: string[]; permissionLabels: Record<string, string>; approvals: string[]; href: string; available: boolean }[];
  chatAgents: { id: string; name: string; description: string; capabilities: string[] }[];
  customAgents: { id: string; name: string; description: string; capabilities: string[]; lastUsedAt: string | null }[];
  connectors: { connectorId: string; name: string; status: string; writeEnabled: boolean }[];
  activity: Record<string, string | null>;
  decisions: { agent: string; outcome: string; at: string }[];
  findingsByAsset: Record<string, number>;
  policy: CustomerPolicy;
  platformSuspended: string[];
  now: number;
}

const CAP_LABEL: Record<string, string> = { web_search: "Web search", file_analysis: "Reads files you attach", data_analysis: "Analyses data files", code_execution: "Runs code (sandbox)" };
const CODE_AGENTS = new Set(["engineer", "bug_fixer", "qa_tester", "website_builder"]);

export function buildInventory(i: InventoryInput): InventoryAgent[] {
  const week = i.now - 7 * 86_400_000;
  const counts = (agent: string, outcome: string) => i.decisions.filter((d) => d.agent === agent && d.outcome === outcome && Date.parse(d.at) >= week).length;
  const readable = i.connectors.filter((c) => c.status === "connected" && (!i.policy.allowedIntegrations || i.policy.allowedIntegrations.includes(c.connectorId)));
  const out: InventoryAgent[] = [];

  for (const a of i.taskAgents.filter((x) => x.available)) {
    const ref = `task:${a.id}`;
    const paused = i.platformSuspended.includes(a.id) ? { by: "administrator" as const } : i.policy.pausedAgents.includes(ref) ? { by: "workspace" as const } : null;
    const projects = CODE_AGENTS.has(a.id) ? i.policy.agentProjects[ref as keyof CustomerPolicy["agentProjects"]] : undefined;
    const limits = [
      ...(projects ? [`Only in ${projects.length} chosen project${projects.length === 1 ? "" : "s"}`] : []),
      ...(CODE_AGENTS.has(a.id)
        ? i.policy.requireApproval.map((op) => (op === "command.run" ? "Every command needs approval" : op === "file.write" ? "Every file change is reviewed" : "Preview starts need approval"))
        : []),
      ...i.policy.blockedCapabilities.map((c) => `${c.replace("_", " ")} switched off`),
    ];
    const blocked = counts(a.id, "deny");
    out.push({
      ref,
      kind: "task",
      name: a.name,
      purpose: a.tagline,
      owner: "Orbis",
      tools: a.permissions.map((p) => a.permissionLabels[p] ?? p),
      dataSources: a.permissions.includes("github_read")
        ? ["Your GitHub repositories (read-only)", "Your Orbis Code projects"]
        : a.permissions.includes("read_code")
          ? ["Your Orbis Code projects"]
          : [],
      execution: a.permissions.filter((p) => p === "run_commands" || p === "run_tests" || p === "edit_files" || p === "edit_tests_only").map((p) => a.permissionLabels[p] ?? p),
      approvals: a.approvals,
      lastActivity: i.activity[ref] ?? null,
      paused,
      limits,
      blocked7d: blocked,
      needsApproval7d: counts(a.id, "needs_approval"),
      findings: i.findingsByAsset[`agent:${a.id}`] ?? 0,
      compliance: paused ? "paused" : blocked >= i.policy.notifications.blockThreshold || (i.findingsByAsset[`agent:${a.id}`] ?? 0) > 0 ? "attention" : "compliant",
      href: a.href,
    });
  }

  for (const a of i.chatAgents) {
    const ref = `builtin:${a.id}`;
    const paused = i.policy.pausedAgents.includes(ref) ? { by: "workspace" as const } : null;
    out.push({
      ref,
      kind: "chat",
      name: a.name,
      purpose: a.description,
      owner: "Orbis",
      tools: a.capabilities.map((c) => CAP_LABEL[c] ?? c),
      dataSources: ["What you write or attach in the chat"],
      execution: [],
      approvals: [],
      lastActivity: i.activity[ref] ?? null,
      paused,
      limits: [],
      blocked7d: 0,
      needsApproval7d: 0,
      findings: 0,
      compliance: paused ? "paused" : "compliant",
      href: null,
    });
  }

  for (const a of i.customAgents) {
    const ref = `custom:${a.id}`;
    const removed = i.policy.customAgentLimits[ref] ?? [];
    const paused = i.policy.pausedAgents.includes(ref) ? { by: "workspace" as const } : null;
    const findings = i.findingsByAsset[`agent:${a.id}`] ?? 0;
    out.push({
      ref,
      kind: "custom",
      name: a.name,
      purpose: a.description || "Custom agent",
      owner: "You",
      tools: a.capabilities.filter((c) => !(removed as string[]).includes(c)).map((c) => CAP_LABEL[c] ?? c),
      dataSources: ["What you write or attach in the chat", ...(a.capabilities.includes("web_search") && !(removed as string[]).includes("web_search") ? ["The web"] : [])],
      execution: a.capabilities.includes("code_execution") && !(removed as string[]).includes("code_execution") ? ["Code in an isolated sandbox"] : [],
      approvals: [],
      lastActivity: a.lastUsedAt,
      paused,
      limits: removed.map((c) => `${CAP_LABEL[c] ?? c} removed by policy`),
      blocked7d: 0,
      needsApproval7d: 0,
      findings,
      compliance: paused ? "paused" : findings ? "attention" : "compliant",
      href: `/agents/${a.id}`,
    });
  }

  // The chat assistant reads connected services for you; it's listed so its reach is visible.
  out.push({
    ref: "task:assistant",
    kind: "chat",
    name: "Orbis assistant (connected services)",
    purpose: "Reads your connected services when a chat needs them, and proposes actions you confirm.",
    owner: "Orbis",
    tools: ["Reads connected services", "Proposes drafts, events and messages (you confirm each one)"],
    dataSources: readable.length ? readable.map((c) => `${c.name}${c.writeEnabled ? " (read + write with confirmation)" : " (read)"}`) : ["No connected services it may read"],
    execution: [],
    approvals: ["Every action in a connected service"],
    lastActivity: i.activity["task:assistant"] ?? null,
    paused: i.platformSuspended.includes("assistant") ? { by: "administrator" } : null,
    limits: i.policy.allowedIntegrations ? [`Limited to ${i.policy.allowedIntegrations.length} chosen service${i.policy.allowedIntegrations.length === 1 ? "" : "s"}`] : [],
    blocked7d: counts("assistant", "deny"),
    needsApproval7d: 0,
    findings: 0,
    compliance: "compliant",
    href: "/connectors",
  });
  return out;
}
