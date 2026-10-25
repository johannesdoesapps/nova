import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin } from "../../admin";
import type { AuthContext } from "../../auth";
import { AGENTS, PERMISSION_LABEL } from "../../agent-platform/registry";
import { builtinAgents } from "../../agents/builtins";
import { connector } from "../../connectors/registry";
import { emailConfigured } from "../../email";
import { entitlementFor } from "../../entitlements";
import { ApiError } from "../../http";
import { serviceSupabase } from "../../supabase/admin";
import { bastionMac, loadControls, loadWorkspacePolicy } from "../controls";
import { isSecretPath } from "../guards";
import { recordSigned } from "../server";
import { runChecks, workspaceCoverage, type WorkspaceSnapshot } from "./checks";
import { applyWorkflow, fromAgentFinding, posture, POSTURE_RULES, workspaceFindings, type AgentFindingRow, type AssessmentRecord, type BastionFinding, type WorkflowEvent } from "./findings";
import { buildInventory } from "./inventory";
import { DEFAULT_CUSTOMER_POLICY, type PolicyVersion } from "./policy";
import { integrityOf, type AuditRow } from "./records";
import { can, permissionsOf, ROLE_LABEL, type Permission, type WorkspaceRole } from "./roles";
import { FEATURES, hasFeature, historyDays, TIER_LABEL, tierFor, type Feature, type Tier } from "./tiers";

/**
 * Bastion Customer Security on the server: whose workspace a request may see and with which role, and loading
 * that workspace's data. Every query below filters by the workspace owner's id — with the owner's own session
 * (row-level security applies too) or, for a teammate with a role, with the service client after the grant and
 * the shared team have been checked. Nothing here reads another workspace.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface WorkspaceCtx {
  ownerId: string;
  actorId: string;
  role: WorkspaceRole;
  tier: Tier;
  shared: boolean;
  /** Reads and writes for this workspace (always filtered by ownerId). */
  db: SupabaseClient;
  /** The signed-in person's own session. */
  actorDb: SupabaseClient;
  platformAdmin: boolean;
  /** Correlation id for the records of this request. */
  cid: string;
}

const notFound = () => new ApiError("not_found", "Workspace not found.");

/** Resolve the workspace a request is for: the caller's own, or one whose owner gave them a role. */
export async function resolveWorkspace(auth: Extract<AuthContext, { mode: "authenticated" }>, requested?: string | null): Promise<WorkspaceCtx> {
  const me = auth.user.id;
  const [ent, controls, admin] = await Promise.all([entitlementFor(auth), loadControls(), isAdmin(auth)]);
  const tier = tierFor(ent?.plan ?? "free", { unlimited: ent?.kind === "unlimited", mapping: controls?.planTiers ?? null });
  const base = { actorId: me, tier, actorDb: auth.supabase as unknown as SupabaseClient, platformAdmin: admin, cid: randomUUID() };
  if (!requested || requested === me) return { ...base, ownerId: me, role: "owner", shared: false, db: auth.supabase as unknown as SupabaseClient };
  if (!UUID.test(requested)) throw notFound();
  // The grant must exist (row-level security shows a grant only to its owner and grantee)…
  const { data: grant, error } = await auth.supabase.from("bastion_workspace_roles").select("role").eq("owner_id", requested).eq("user_id", me).maybeSingle();
  if (error || !grant) throw notFound();
  // …both people must still be in the same team…
  const { data: mates } = await auth.supabase.from("team_members").select("user_id").in("user_id", [me, requested]);
  if ((mates ?? []).length < 2) throw notFound();
  // …and team roles must be in the plan.
  if (!hasFeature(tier, "roles")) throw new ApiError("plan_required", `Shared security workspaces are part of Bastion ${TIER_LABEL[FEATURES.roles.tier]}.`);
  const svc = serviceSupabase();
  if (!svc) throw new ApiError("not_configured", "Shared workspaces need the server's Supabase service key, which isn't configured.");
  return { ...base, ownerId: requested, role: (grant as { role: WorkspaceRole }).role, shared: true, db: svc };
}

export function requirePermission(ctx: WorkspaceCtx, p: Permission) {
  if (!can(ctx.role, p)) throw new ApiError("forbidden", `Your role (${ROLE_LABEL[ctx.role]}) can't do that in this workspace.`);
}

export function requireFeature(ctx: WorkspaceCtx, f: Feature) {
  if (!hasFeature(ctx.tier, f)) throw new ApiError("plan_required", `${FEATURES[f].label} is part of Bastion ${TIER_LABEL[FEATURES[f].tier]}. Bastion Core's protections stay on whatever your plan.`);
}

/** Record something that happened in this workspace (signed; the actor and correlation id are kept). */
export function recordEvent(ctx: WorkspaceCtx, action: string, detail: Record<string, unknown>, ref: { runId?: string | null } = {}) {
  return recordSigned(ctx.db, ctx.ownerId, action, { ...detail, actor: ctx.actorId, workspace: ctx.ownerId, cid: ctx.cid }, ref);
}

/** Signed audit records of this workspace, newest first. */
export async function auditRows(
  ctx: WorkspaceCtx,
  opts: { prefix?: string; actions?: string[]; sinceDays?: number; limit?: number } = {},
): Promise<(AuditRow & { integrity: ReturnType<typeof integrityOf> })[]> {
  let q = ctx.db.from("security_audit").select("id,action,detail,created_at,run_id,finding_id").eq("user_id", ctx.ownerId);
  if (opts.prefix) q = q.like("action", `${opts.prefix}%`);
  if (opts.actions) q = q.in("action", opts.actions);
  if (opts.sinceDays) q = q.gte("created_at", new Date(Date.now() - opts.sinceDays * 86_400_000).toISOString());
  const { data, error } = await q.order("created_at", { ascending: false }).limit(opts.limit ?? 1000);
  if (error) throw new ApiError("internal", "The workspace's security records couldn't be read.");
  return ((data ?? []) as AuditRow[]).map((r) => ({ ...r, integrity: integrityOf(bastionMac, ctx.ownerId, r) }));
}

/* ---------------------------------------------------------------- snapshot */

async function safe<T>(key: string, unavailable: string[], p: PromiseLike<{ data: T | null; error: unknown }>): Promise<T | null> {
  try {
    const { data, error } = await p;
    if (error) {
      unavailable.push(key);
      return null;
    }
    return data;
  } catch {
    unavailable.push(key);
    return null;
  }
}

export interface Loaded {
  snapshot: WorkspaceSnapshot;
  agentFindings: AgentFindingRow[];
  runs: { id: string; agent: string; asset: string | null; status: string; started_at: string; stats: Record<string, unknown> }[];
  conversations: { agent_id: string | null; builtin_agent: string | null; updated_at: string }[];
  policy: { current: PolicyVersion; history: PolicyVersion[]; rejected: number } | null;
}

export async function loadWorkspace(ctx: WorkspaceCtx): Promise<Loaded> {
  const o = ctx.ownerId;
  const db = ctx.db;
  const u: string[] = [];
  const now = Date.now();
  const [agents, conversations, connectors, shared, projects, codeRuns, targets, runs, findings, decisions, reviews, ws] = await Promise.all([
    safe<{ id: string; name: string; description: string; capabilities: string[]; instructions: string; updated_at: string }[]>(
      "agents",
      u,
      db.from("agents").select("id,name,description,capabilities,instructions,updated_at").eq("user_id", o).limit(200),
    ),
    safe<{ agent_id: string | null; builtin_agent: string | null; updated_at: string }[]>(
      "agents",
      u,
      db.from("conversations").select("agent_id,builtin_agent,updated_at").eq("user_id", o).order("updated_at", { ascending: false }).limit(500),
    ),
    safe<{ connector_id: string; status: string; scopes: string[]; write_enabled: boolean; ai_mode: string; connected_at: string; last_used_at: string | null; last_error: string | null }[]>(
      "connectors",
      u,
      // Never the sealed credentials: only status and permissions.
      db.from("connector_accounts").select("connector_id,status,scopes,write_enabled,ai_mode,connected_at,last_used_at,last_error").eq("user_id", o),
    ),
    safe<{ id: string; title: string; shared_until: string }[]>("sharing", u, db.from("conversations").select("id,title,shared_until").eq("user_id", o).not("shared_until", "is", null).limit(200)),
    safe<{ id: string; name: string; source_repo: string | null }[]>("projects", u, db.from("code_projects").select("id,name,source_repo").eq("user_id", o).limit(100)),
    safe<{ id: string; project_id: string; options: Record<string, unknown>; created_at: string }[]>(
      "runs",
      u,
      db.from("code_agent_runs").select("id,project_id,options,created_at").eq("user_id", o).order("created_at", { ascending: false }).limit(150),
    ),
    safe<{ hostname: string; verified_at: string | null }[]>("sites", u, db.from("security_targets").select("hostname,verified_at").eq("user_id", o)),
    safe<Loaded["runs"]>("sites", u, db.from("security_runs").select("id,agent,asset,status,started_at,stats").eq("user_id", o).order("started_at", { ascending: false }).limit(200)),
    safe<AgentFindingRow[]>(
      "findings",
      u,
      db
        .from("security_findings")
        .select(
          "id,agent,rule_id,title,description,severity,confidence,status,verification,verification_note,asset,location,evidence,evidence_source,remediation,rationale,related,first_seen,last_seen",
        )
        .eq("user_id", o)
        .is("duplicate_of", null)
        .order("last_seen", { ascending: false })
        .limit(500),
    ),
    safe<AuditRow[]>(
      "decisions",
      u,
      db
        .from("security_audit")
        .select("action,detail,created_at")
        .eq("user_id", o)
        .like("action", "bastion.%")
        .gte("created_at", new Date(now - 30 * 86_400_000).toISOString())
        .order("created_at", { ascending: false })
        .limit(2000),
    ),
    safe<AuditRow[]>("team", u, db.from("security_audit").select("action,detail,created_at").eq("user_id", o).eq("action", "bastion.access_review").order("created_at", { ascending: false }).limit(5)),
    loadWorkspacePolicy(db, o),
  ]);

  // Secret files by path only (contents aren't read here), in this workspace's projects.
  const projectIds = (projects ?? []).map((p) => p.id);
  const files = projectIds.length ? await safe<{ project_id: string; path: string }[]>("projects", u, db.from("code_files").select("project_id,path").in("project_id", projectIds).limit(10000)) : [];
  // Team: members (visible to members) and the roles this owner granted.
  const team = await loadTeam(ctx, u);
  const policy = ws === "unavailable" ? null : ws;
  if (ws === "unavailable") u.push("policy");

  const signed = (rows: AuditRow[] | null) => (rows ?? []).filter((r) => integrityOf(bastionMac, o, r) === "signed");
  const lastAssessed = (id: string) => (runs ?? []).find((r) => r.asset === `orbis:${id}` && r.status === "completed")?.started_at ?? null;
  const snapshot: WorkspaceSnapshot = {
    ownerId: o,
    now,
    team,
    customAgents: (agents ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      capabilities: a.capabilities,
      instructions: a.instructions,
      updatedAt: a.updated_at,
      lastUsedAt: (conversations ?? []).find((c) => c.agent_id === a.id)?.updated_at ?? null,
    })),
    connectors: (connectors ?? [])
      .filter((c) => c.status !== "disconnected")
      .map((c) => ({
        connectorId: c.connector_id,
        name: connector(c.connector_id)?.meta.name ?? c.connector_id,
        status: c.status,
        writeEnabled: c.write_enabled,
        scopes: c.scopes,
        aiMode: c.ai_mode,
        connectedAt: c.connected_at,
        lastUsedAt: c.last_used_at,
        lastError: c.last_error,
      })),
    sharedChats: (shared ?? []).map((c) => ({ id: c.id, title: c.title || "Untitled chat", sharedUntil: c.shared_until })),
    projects: (projects ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      sourceRepo: p.source_repo,
      secretFiles: (files ?? []).filter((f) => f.project_id === p.id && isSecretPath(f.path)).map((f) => f.path),
      lastAssessed: lastAssessed(p.id),
    })),
    codeRuns: (codeRuns ?? []).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      agent: String(r.options.agent ?? (r.options.web ? "website_builder" : "engineer")),
      createdAt: r.created_at,
      approvePlans: r.options.approvePlans !== false,
      reviewEdits: r.options.reviewEdits === true,
      commands: String(r.options.commands ?? "safe"),
      readOnly: r.options.readOnly === true,
    })),
    verifiedSites: (targets ?? [])
      .filter((t) => t.verified_at)
      .map((t) => ({
        hostname: t.hostname,
        verifiedAt: t.verified_at!,
        lastScan: (runs ?? []).find((r) => r.agent === "sentinel" && r.asset === t.hostname && r.status === "completed")?.started_at ?? null,
      })),
    logUploads: (runs ?? []).filter((r) => r.agent === "threat_hunter" && r.status === "completed").length,
    decisions: signed(decisions)
      .filter((r) => /^bastion\.(deny|allow|needs_approval)$/.test(r.action))
      .map((r) => ({ agent: String(r.detail.agent ?? ""), outcome: r.action.slice(8), at: r.created_at, op: String(r.detail.op ?? "") })),
    lastAccessReview: signed(reviews)[0]?.created_at ?? null,
    policyVersion: policy?.current.version ?? 0,
    blockThreshold: (policy?.current.policy ?? DEFAULT_CUSTOMER_POLICY).notifications.blockThreshold,
    unavailable: [...new Set(u)],
  };
  return { snapshot, agentFindings: findings ?? [], runs: runs ?? [], conversations: conversations ?? [], policy };
}

async function loadTeam(ctx: WorkspaceCtx, u: string[]): Promise<WorkspaceSnapshot["team"]> {
  try {
    const { data: m } = await ctx.db.from("team_members").select("team_id").eq("user_id", ctx.ownerId).maybeSingle();
    if (!m?.team_id) return null;
    const [{ data: team }, { data: members }, { data: grants, error: gErr }] = await Promise.all([
      ctx.db.from("teams").select("name,owner_id").eq("id", m.team_id).maybeSingle(),
      ctx.db.from("team_members").select("user_id,role,joined_at").eq("team_id", m.team_id).limit(200),
      ctx.db.from("bastion_workspace_roles").select("user_id,role,granted_at").eq("owner_id", ctx.ownerId).limit(200),
    ]);
    return {
      name: (team as { name: string } | null)?.name ?? "Team",
      ownerIsYou: (team as { owner_id: string } | null)?.owner_id === ctx.ownerId,
      members: ((members ?? []) as { user_id: string; role: string; joined_at: string }[]).map((x) => ({ userId: x.user_id, role: x.role, joinedAt: x.joined_at })),
      // Null when the roles table isn't there yet (migration pending).
      grants: gErr ? null : ((grants ?? []) as { user_id: string; role: string; granted_at: string }[]).map((g) => ({ userId: g.user_id, role: g.role, grantedAt: g.granted_at })),
    };
  } catch {
    u.push("team");
    return null;
  }
}

/* ------------------------------------------------------------------- state */

export async function workspaceState(ctx: WorkspaceCtx, auth: Extract<AuthContext, { mode: "authenticated" }>) {
  const loaded = await loadWorkspace(ctx);
  const { snapshot: s } = loaded;
  const [controls, assessmentRows, workflowRows, sharedWith] = await Promise.all([
    loadControls(),
    auditRows(ctx, { actions: ["bastion.assessment"], limit: 200 }),
    auditRows(ctx, { actions: ["bastion.finding"], limit: 2000 }),
    ctx.shared ? Promise.resolve([]) : listSharedWithMe(auth),
  ]);
  const { findings: raw, checks } = runChecks(s);
  const ranChecks = checks.filter((c) => c.state !== "unavailable").map((c) => c.id);
  const assessments: AssessmentRecord[] = assessmentRows
    .filter((r) => r.integrity === "signed" && r.detail.mode === "workspace")
    .map((r) => ({
      at: r.created_at,
      mode: "workspace",
      present: Array.isArray(r.detail.present) ? (r.detail.present as AssessmentRecord["present"]) : [],
      checked: Array.isArray(r.detail.checked) ? (r.detail.checked as string[]) : [],
    }));
  const nowIso = new Date(s.now).toISOString();
  const lastCheckAt = assessments.length
    ? assessments
        .map((a) => a.at)
        .sort()
        .at(-1)!
    : null;
  const projectName = new Map(s.projects.map((p) => [`orbis:${p.id}`, p.name]));
  let findings: BastionFinding[] = [
    ...workspaceFindings(raw, assessments, ctx.ownerId, nowIso, ranChecks),
    ...loaded.agentFindings.map((f) => fromAgentFinding(f, ctx.ownerId, projectName.get(f.asset))),
  ];
  findings = applyWorkflow(findings, workflowRows.filter((r) => r.integrity === "signed") as unknown as WorkflowEvent[], { now: s.now, lastCheckAt });
  const coverage = workspaceCoverage(s);
  const post = posture(findings, coverage);
  const hiddenByTier = hasFeature(ctx.tier, "all_findings") ? 0 : findings.filter((f) => !["critical", "high"].includes(f.severity)).length;
  const visible = hasFeature(ctx.tier, "all_findings") ? findings : findings.filter((f) => ["critical", "high"].includes(f.severity));

  const policy = loaded.policy?.current.policy ?? DEFAULT_CUSTOMER_POLICY;
  const activity: Record<string, string | null> = {};
  for (const r of s.codeRuns) activity[`task:${r.agent}`] ??= r.createdAt;
  for (const c of loaded.conversations) if (c.builtin_agent) activity[`builtin:${c.builtin_agent}`] ??= c.updated_at;
  const lastConnectorUse =
    s.connectors
      .map((c) => c.lastUsedAt)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
  activity["task:assistant"] = lastConnectorUse;
  for (const r of loaded.runs) if (["sentinel", "code_guardian", "threat_hunter"].includes(r.agent)) activity["task:security"] ??= r.started_at;
  const findingsByAsset: Record<string, number> = {};
  for (const f of findings) if (f.status !== "resolved" && f.status !== "suppressed") findingsByAsset[f.asset] = (findingsByAsset[f.asset] ?? 0) + 1;
  const inventory = buildInventory({
    taskAgents: AGENTS.map((a) => ({
      id: a.id,
      name: a.name,
      tagline: a.tagline,
      permissions: a.permissions,
      permissionLabels: PERMISSION_LABEL,
      approvals: a.approvals,
      href: a.href,
      available: true,
    })),
    chatAgents: builtinAgents().map((a) => ({ id: a.id, name: a.name, description: a.description, capabilities: a.capabilities })),
    customAgents: s.customAgents.map((a) => ({ id: a.id, name: a.name, description: "", capabilities: a.capabilities, lastUsedAt: a.lastUsedAt })),
    connectors: s.connectors,
    activity,
    decisions: s.decisions,
    findingsByAsset,
    policy,
    platformSuspended: controls?.suspendedAgents ?? [],
    now: s.now,
  });

  const day = s.now - 86_400_000;
  const alerts = [
    ...findings
      .filter((f) => f.severity === "critical" && f.status !== "resolved" && f.status !== "suppressed")
      .map((f) => ({ kind: "critical_finding", text: f.title, at: f.detectedAt, href: f.href })),
    ...s.decisions
      .filter((d) => d.outcome === "deny" && Date.parse(d.at) >= day)
      .slice(0, 10)
      .map((d) => ({ kind: "blocked_action", text: `${d.agent.replace("_", " ") || "An agent"}: ${d.op} refused`, at: d.at, href: null })),
    ...(controls ? [] : [{ kind: "enforcement", text: "Bastion Core's controls can't be read — protected actions are paused (fail closed).", at: nowIso, href: null }]),
    ...(loaded.policy ? [] : [{ kind: "enforcement", text: "This workspace's policy can't be read — protected actions are paused (fail closed).", at: nowIso, href: null }]),
  ];

  const health = [
    {
      id: "core",
      label: "Bastion Core enforcement",
      ok: !!controls,
      note: controls ? `Policy version ${controls.version}${controls.lockdown ? " — lockdown is on" : ""}` : "Controls unavailable: failing closed",
    },
    {
      id: "policy",
      label: "Workspace policy",
      ok: !!loaded.policy,
      note: loaded.policy ? `Version ${loaded.policy.current.version}${loaded.policy.rejected ? ` (${loaded.policy.rejected} unverified record(s) ignored)` : ""}` : "Couldn't be read: failing closed",
    },
    {
      id: "signing",
      label: "Record signatures",
      ok: bastionMac("probe") !== null,
      note: bastionMac("probe") ? "Records are signed and checked" : "The server's key isn't configured: records can't be signed, so verifications and policies can't be trusted",
    },
    {
      id: "email",
      label: "Email notifications",
      ok: emailConfigured(),
      note: emailConfigured() ? "Email delivery is configured" : "Email isn't configured on this server: notifications are only shown here",
    },
    { id: "data", label: "Workspace data", ok: !s.unavailable.length, note: s.unavailable.length ? `Couldn't read: ${s.unavailable.join(", ")}` : "All sources read" },
  ];

  const days = historyDays(ctx.tier, policy.retentionDays);
  return {
    workspace: {
      id: ctx.ownerId,
      shared: ctx.shared,
      role: ctx.role,
      roleLabel: ROLE_LABEL[ctx.role],
      permissions: permissionsOf(ctx.role),
      platformAdmin: ctx.platformAdmin,
      sharedWithMe: sharedWith,
    },
    entitlement: { tier: ctx.tier, tierLabel: TIER_LABEL[ctx.tier], features: Object.fromEntries(Object.keys(FEATURES).map((f) => [f, hasFeature(ctx.tier, f as Feature)])), historyDays: days },
    posture: { ...post, rules: POSTURE_RULES },
    lastAssessment: lastCheckAt,
    checks,
    coverage,
    findings: visible.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || b.lastSeen.localeCompare(a.lastSeen)),
    hiddenByTier,
    inventory,
    applications: applications(loaded),
    integrations: s.connectors,
    team: s.team,
    sharing: s.sharedChats,
    policy: loaded.policy ? { current: loaded.policy.current, history: hasFeature(ctx.tier, "policies") ? loaded.policy.history.slice(0, 20) : loaded.policy.history.slice(0, 1) } : null,
    alerts: alerts.slice(0, 20),
    health,
    recentEvents: s.decisions.slice(0, 15),
    unavailable: s.unavailable,
  };
}

const sevRank = (s: string) => ({ critical: 0, high: 1, medium: 2, low: 3, info: 4 })[s] ?? 5;

function applications(l: Loaded) {
  const s = l.snapshot;
  const lastRun = (asset: string) => l.runs.find((r) => r.asset === asset && r.status === "completed") ?? null;
  return [
    ...s.projects.map((p) => {
      const r = lastRun(`orbis:${p.id}`);
      const b = (r?.stats as { bastion?: { mode?: string; gate?: { passed: boolean; reasons: string[] } } } | undefined)?.bastion ?? null;
      return {
        kind: "project" as const,
        id: p.id,
        name: p.name,
        asset: `orbis:${p.id}`,
        lastAssessed: r?.started_at ?? null,
        lastMode: b?.mode ?? null,
        gate: b?.gate ?? null,
        runId: r?.id ?? null,
        open: l.agentFindings.filter((f) => f.asset === `orbis:${p.id}` && !["fixed", "verified", "false_positive", "accepted_risk"].includes(f.status)).length,
      };
    }),
    ...s.verifiedSites.map((v) => ({
      kind: "website" as const,
      id: v.hostname,
      name: v.hostname,
      asset: v.hostname,
      lastAssessed: v.lastScan,
      lastMode: v.lastScan ? "sentinel" : null,
      gate: null,
      runId: lastRun(v.hostname)?.id ?? null,
      open: l.agentFindings.filter((f) => f.asset === v.hostname).length,
    })),
    ...[...new Set(l.runs.filter((r) => r.asset?.startsWith("github:")).map((r) => r.asset!))].map((a) => ({
      kind: "repository" as const,
      id: a,
      name: a.replace(/^github:/, ""),
      asset: a,
      lastAssessed: lastRun(a)?.started_at ?? null,
      lastMode: "code_guardian",
      gate: null,
      runId: lastRun(a)?.id ?? null,
      open: l.agentFindings.filter((f) => f.asset === a).length,
    })),
  ];
}

/** Workspaces other owners shared with the signed-in person (by role). Empty until the roles table exists. */
export async function listSharedWithMe(auth: Extract<AuthContext, { mode: "authenticated" }>): Promise<{ ownerId: string; role: string }[]> {
  const { data, error } = await auth.supabase.from("bastion_workspace_roles").select("owner_id,role").eq("user_id", auth.user.id).limit(50);
  if (error) return [];
  return ((data ?? []) as { owner_id: string; role: string }[]).map((r) => ({ ownerId: r.owner_id, role: r.role }));
}
