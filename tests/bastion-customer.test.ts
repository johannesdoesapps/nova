import { describe, expect, it } from "vitest";
import { findingId, runChecks, workspaceCoverage, type WorkspaceSnapshot } from "@/lib/bastion/customer/checks";
import { applyWorkflow, fromAgentFinding, posture, workspaceFindings, type AssessmentRecord, type BastionFinding } from "@/lib/bastion/customer/findings";
import { evaluateGate, recheckDepth } from "@/lib/bastion/customer/gate";
import { buildInventory } from "@/lib/bastion/customer/inventory";
import {
  agentPaused,
  customAgentTools,
  customerPolicySchema,
  decideWithWorkspace,
  DEFAULT_CUSTOMER_POLICY,
  effectiveControls,
  integrationAllowed,
  policyImpact,
  projectAllowed,
  validateCustomerPolicy,
  type CustomerPolicy,
} from "@/lib/bastion/customer/policy";
import { integrityOf, latestPolicy, signDetail, type Mac } from "@/lib/bastion/customer/records";
import { ASSIGNABLE_ROLES, can, PERMISSIONS, WORKSPACE_ROLES } from "@/lib/bastion/customer/roles";
import { DEFAULT_PLAN_TIERS, FEATURES, hasFeature, historyDays, tierFor } from "@/lib/bastion/customer/tiers";
import { actionHash, DEFAULT_CONTROLS, OPERATIONS, RISKS, type BastionControls, type GuardRequest, type OperationId } from "@/lib/bastion/policy";

/**
 * Bastion Customer Security: workspace policies can only add restrictions; records are signed and checked;
 * roles and plan tiers; workspace checks; the finding workflow (resolved only by evidence); posture; the gate.
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AG = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const policy = (p: Partial<CustomerPolicy>): CustomerPolicy => ({ ...DEFAULT_CUSTOMER_POLICY, ...p });

describe("workspace policies only add restrictions", () => {
  const strict = policy({
    requireApproval: ["command.run", "file.write", "preview.start"],
    blockedCapabilities: ["commands", "connector_writes", "github_push", "exports", "network"],
    pausedAgents: ["task:engineer", "task:qa_tester", `custom:${AG}`],
    agentProjects: { "task:bug_fixer": [P1] },
    allowedIntegrations: ["gmail"],
  });
  const platforms: BastionControls[] = [
    DEFAULT_CONTROLS,
    { ...DEFAULT_CONTROLS, lockdown: true },
    { ...DEFAULT_CONTROLS, suspendedAgents: ["engineer"] },
    { ...DEFAULT_CONTROLS, blockedCapabilities: ["file_writes"], riskOverrides: { "command.run": "critical" } },
  ];
  const rank = { allow: 0, needs_approval: 1, deny: 2 } as const;

  it("never makes any decision less strict than Bastion Core's, for every operation, actor, approval and platform state", () => {
    let compared = 0;
    for (const platform of [...platforms, null])
      for (const customer of [DEFAULT_CUSTOMER_POLICY, strict])
        for (const op of Object.keys(OPERATIONS) as OperationId[])
          for (const kind of ["agent", "user"] as const)
            for (const approved of [false, true]) {
              const req: GuardRequest = { actor: { kind, agent: kind === "agent" ? "engineer" : "terminal", userId: A }, op, resource: "r" };
              if (approved) req.approval = { actionHash: actionHash(req) };
              const core = decideWithWorkspace(req, platform, null);
              const both = decideWithWorkspace(req, platform, customer);
              expect(rank[both.outcome], `${op} ${kind} ${approved}`).toBeGreaterThanOrEqual(rank[core.outcome]);
              compared++;
            }
    expect(compared).toBe(5 * 2 * Object.keys(OPERATIONS).length * 2 * 2);
  });

  it("merges by union and maximum only; unreadable Core controls stay unreadable (fail closed)", () => {
    for (const platform of platforms) {
      const e = effectiveControls(platform, strict)!;
      expect(e.lockdown).toBe(platform.lockdown);
      for (const a of platform.suspendedAgents) expect(e.suspendedAgents).toContain(a);
      for (const c of platform.blockedCapabilities) expect(e.blockedCapabilities).toContain(c);
      for (const [op, r] of Object.entries(platform.riskOverrides)) expect(RISKS.indexOf(e.riskOverrides[op]!)).toBeGreaterThanOrEqual(RISKS.indexOf(r));
    }
    expect(effectiveControls(null, strict)).toBeNull();
    expect(effectiveControls(DEFAULT_CONTROLS, strict)!.riskOverrides["command.run"]).toBe("high");
    expect(effectiveControls({ ...DEFAULT_CONTROLS, riskOverrides: { "command.run": "critical" } }, strict)!.riskOverrides["command.run"]).toBe("critical");
  });

  it("has no field that could weaken Core: lockdown, overrides, suspensions and unknown keys are rejected", () => {
    for (const extra of [{ lockdown: false }, { riskOverrides: { "command.destructive": "low" } }, { suspendedAgents: [] }, { allowDestructive: true }])
      expect(customerPolicySchema.safeParse({ ...DEFAULT_CUSTOMER_POLICY, ...extra }).success).toBe(false);
    // Only operations with an approval step can be raised, and "workforce" isn't a customer capability.
    expect(customerPolicySchema.safeParse({ ...DEFAULT_CUSTOMER_POLICY, requireApproval: ["policy.modify"] }).success).toBe(false);
    expect(customerPolicySchema.safeParse({ ...DEFAULT_CUSTOMER_POLICY, blockedCapabilities: ["workforce"] }).success).toBe(false);
  });

  it("says when the workspace, not Core, made the decision", () => {
    const d = decideWithWorkspace({ actor: { kind: "agent", agent: "engineer", userId: A }, op: "file.write", resource: "a.ts" }, DEFAULT_CONTROLS, strict);
    expect(d).toMatchObject({ outcome: "deny", source: "workspace" });
    expect(d.reason).toMatch(/workspace policy has paused the engineer/);
    const r = decideWithWorkspace(
      { actor: { kind: "agent", agent: "bug_fixer", userId: A }, op: "preview.start", resource: "npm run dev" },
      DEFAULT_CONTROLS,
      policy({ requireApproval: ["preview.start"] }),
    );
    expect(r).toMatchObject({ outcome: "needs_approval", source: "workspace" });
  });

  it("applies boundaries, integration limits, pauses and tool limits", () => {
    expect(projectAllowed(strict, "bug_fixer", P1)).toBe(true);
    expect(projectAllowed(strict, "bug_fixer", P2)).toBe(false);
    expect(projectAllowed(strict, "engineer", P2)).toBe(true);
    expect(integrationAllowed(strict, "gmail")).toBe(true);
    expect(integrationAllowed(strict, "google_drive")).toBe(false);
    expect(integrationAllowed(DEFAULT_CUSTOMER_POLICY, "google_drive")).toBe(true);
    expect(agentPaused(strict, `custom:${AG}`)).toBe(true);
    expect(customAgentTools(policy({ customAgentLimits: { [`custom:${AG}`]: ["web_search"] } }), AG, ["web_search", "file_analysis"])).toEqual(["file_analysis"]);
  });

  it("refuses policies that name another workspace's agents, projects or services", () => {
    const own = { customAgents: [AG], projects: [P1], connectors: ["gmail"] };
    expect(validateCustomerPolicy(strict, own)).toBeNull();
    expect(validateCustomerPolicy(policy({ pausedAgents: [`custom:${B}`] }), own)).toMatch(/isn't in this workspace/);
    expect(validateCustomerPolicy(policy({ agentProjects: { "task:engineer": [P2] } }), own)).toMatch(/isn't in this workspace/);
    expect(validateCustomerPolicy(policy({ allowedIntegrations: ["slack"] }), own)).toMatch(/isn't a connected service/);
    expect(validateCustomerPolicy(policy({ agentProjects: { "task:engineer": [] } }), own)).toMatch(/no project/);
  });

  it("explains a change before it's made", () => {
    expect(policyImpact(DEFAULT_CUSTOMER_POLICY, strict).join(" ")).toMatch(/stop and ask before.*Switched off.*paused/s);
  });
});

describe("signed records", () => {
  const mac: Mac = (d) => `sig${[...d].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`;
  const row = (detail: Record<string, unknown>, at: string, owner = A) => ({ action: "bastion.policy", detail: signDetail(mac, owner, "bastion.policy", detail), created_at: at });

  it("accepts records Orbis signed, and flags unsigned, edited and other workspaces' records", () => {
    const ok = row({ version: 1, policy: DEFAULT_CUSTOMER_POLICY }, "2026-10-01");
    expect(integrityOf(mac, A, ok)).toBe("signed");
    expect(integrityOf(mac, A, { ...ok, detail: { version: 1, policy: DEFAULT_CUSTOMER_POLICY } })).toBe("unsigned");
    expect(integrityOf(mac, A, { ...ok, detail: { ...ok.detail, version: 2 } })).toBe("invalid");
    // A record signed for workspace B can't be replayed into workspace A.
    expect(integrityOf(mac, A, row({ version: 1, policy: DEFAULT_CUSTOMER_POLICY }, "2026-10-01", B))).toBe("invalid");
    expect(integrityOf(() => null, A, ok)).toBe("invalid");
  });

  it("uses the newest signed, valid policy and ignores the rest", () => {
    const strict = policy({ blockedCapabilities: ["exports"] });
    const rows = [
      row({ version: 1, policy: DEFAULT_CUSTOMER_POLICY }, "2026-10-01"),
      row({ version: 2, policy: strict, summary: "blocked exports" }, "2026-10-02"),
      { action: "bastion.policy", detail: { version: 3, policy: DEFAULT_CUSTOMER_POLICY }, created_at: "2026-10-03" },
      row({ version: 4, policy: { ...DEFAULT_CUSTOMER_POLICY, lockdown: false } }, "2026-10-04"),
    ];
    const l = latestPolicy(mac, A, rows);
    expect(l.current.version).toBe(2);
    expect(l.current.policy).toEqual(strict);
    expect(l.rejected).toBe(2);
    expect(latestPolicy(mac, A, []).current).toMatchObject({ version: 0, policy: DEFAULT_CUSTOMER_POLICY });
  });
});

describe("roles and plan tiers", () => {
  it("gives each role only its permissions, and never a platform role", () => {
    expect(PERMISSIONS.every((p) => can("owner", p))).toBe(true);
    expect(can("viewer", "view") && can("viewer", "audit_view")).toBe(true);
    for (const p of ["assess", "findings_triage", "policies_manage", "agents_manage", "roles_manage", "integrations_revoke"] as const) expect(can("viewer", p)).toBe(false);
    expect(can("developer", "audit_view")).toBe(false);
    expect(can("developer", "findings_triage") && !can("developer", "findings_manage")).toBe(true);
    expect(can("security_admin", "policies_manage") && !can("security_admin", "roles_manage") && !can("security_admin", "integrations_revoke")).toBe(true);
    expect(can(null, "view")).toBe(false);
    expect(ASSIGNABLE_ROLES).not.toContain("owner");
    expect(WORKSPACE_ROLES.join(" ")).not.toMatch(/platform|admin_unlimited/);
  });

  it("maps plans to tiers (configurable) and gates features by tier", () => {
    expect(tierFor("free")).toBe("basic");
    expect(tierFor("pro")).toBe("advanced");
    expect(tierFor("max")).toBe("business");
    expect(tierFor("free", { unlimited: true })).toBe("business");
    expect(tierFor("pro", { mapping: { ...DEFAULT_PLAN_TIERS, pro: "business" } })).toBe("business");
    expect(tierFor("unknown")).toBe("basic");
    expect(hasFeature("basic", "pause_agents") && hasFeature("basic", "quick_check")).toBe(true);
    expect(hasFeature("basic", "policies") || hasFeature("basic", "deep_assessment")).toBe(false);
    expect(hasFeature("advanced", "deep_assessment") && !hasFeature("advanced", "roles")).toBe(true);
    expect(Object.keys(FEATURES).every((f) => hasFeature("business", f as keyof typeof FEATURES))).toBe(true);
    expect(historyDays("basic", 3650)).toBe(7);
    expect(historyDays("business", 3650)).toBe(3650);
  });
});

/* ---------------------------------------------------------------- checks */

const NOW = Date.parse("2026-10-25T00:00:00Z");
const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
function snap(p: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    ownerId: A,
    now: NOW,
    team: null,
    customAgents: [],
    connectors: [],
    sharedChats: [],
    projects: [],
    codeRuns: [],
    verifiedSites: [],
    logUploads: 0,
    decisions: [],
    lastAccessReview: null,
    policyVersion: 0,
    blockThreshold: 5,
    unavailable: [],
    ...p,
  };
}

describe("workspace checks", () => {
  it("finds credentials in agent instructions, idle write access, failing connections, public chats, unreviewed automation and repeated refusals", () => {
    const s = snap({
      customAgents: [{ id: AG, name: "Helper", capabilities: [], instructions: `Use this key ${AWS} for the API.`, updatedAt: "2026-10-01", lastUsedAt: null }],
      connectors: [
        {
          connectorId: "gmail",
          name: "Gmail",
          status: "connected",
          writeEnabled: true,
          scopes: ["gmail.compose"],
          aiMode: "auto",
          connectedAt: "2026-08-01T00:00:00Z",
          lastUsedAt: "2026-08-02T00:00:00Z",
          lastError: null,
        },
        {
          connectorId: "notion",
          name: "Notion",
          status: "reauth_required",
          writeEnabled: false,
          scopes: [],
          aiMode: "auto",
          connectedAt: "2026-10-01T00:00:00Z",
          lastUsedAt: null,
          lastError: "token expired",
        },
      ],
      sharedChats: [{ id: "c1", title: "Launch plan", sharedUntil: "2026-05-01T00:00:00Z" }],
      codeRuns: [{ id: "r1", projectId: P1, agent: "engineer", createdAt: "2026-10-20T00:00:00Z", approvePlans: false, reviewEdits: false, commands: "safe", readOnly: false }],
      decisions: Array.from({ length: 6 }, (_, i) => ({ agent: "engineer", outcome: "deny", at: `2026-10-2${i % 4}T00:00:00Z`, op: "command.destructive" })),
      projects: [{ id: P1, name: "Shop", sourceRepo: null, secretFiles: [".env"], lastAssessed: null }],
    });
    const { findings, checks } = runChecks(s);
    const by = Object.fromEntries(findings.map((f) => [f.checkId, f]));
    expect(by["agents.secret-in-instructions"]).toMatchObject({ kind: "verified", severity: "high", asset: `agent:${AG}` });
    expect(JSON.stringify(by["agents.secret-in-instructions"])).not.toContain(AWS);
    expect(by["integrations.write-unused"]).toMatchObject({ kind: "suspected", severity: "medium" });
    expect(by["integrations.needs-reauth"]).toMatchObject({ severity: "low" });
    expect(by["sharing.public-chats"]).toMatchObject({ severity: "medium" });
    expect(by["automation.unreviewed-runs"]).toBeDefined();
    expect(by["bastion.repeated-blocks"]).toMatchObject({ kind: "suspected" });
    expect(by["secrets.project-files"]).toMatchObject({ kind: "informational" });
    expect(checks.every((c) => c.state !== "unavailable")).toBe(true);
    // Stable ids: the same issue keeps its id.
    expect(by["sharing.public-chats"]!.id).toBe(findingId("sharing.public-chats", A));
  });

  it("reports a check whose data couldn't be read as unavailable, never as passed", () => {
    const { checks, findings } = runChecks(snap({ unavailable: ["connectors"] }));
    expect(checks.filter((c) => c.area === "Connected services").every((c) => c.state === "unavailable")).toBe(true);
    expect(findings).toEqual([]);
  });

  it("is quiet on a clean workspace, and coverage says what isn't covered", () => {
    expect(runChecks(snap()).findings).toEqual([]);
    const cov = Object.fromEntries(workspaceCoverage(snap()).map((c) => [c.id, c.state]));
    expect(cov).toMatchObject({ identity: "unavailable", cloud: "unavailable", telemetry: "not_assessed", sites: "not_assessed", projects: "not_applicable" });
  });
});

/* -------------------------------------------------------------- findings */

describe("findings are resolved only by evidence", () => {
  const raw = runChecks(snap({ sharedChats: [{ id: "c1", title: "Plan", sharedUntil: "2026-10-01T00:00:00Z" }] })).findings;
  const id = raw[0]!.id;
  const ran = ["sharing.public-chats"];
  const rec = (at: string, present = raw): AssessmentRecord => ({
    at,
    mode: "workspace",
    present: present.map((f) => ({ id: f.id, title: f.title, severity: f.severity, checkId: f.checkId, assetLabel: f.assetLabel })),
    checked: ran,
  });
  const ev = (action: string, at: string, extra: Record<string, unknown> = {}) => ({ detail: { findingId: id, action, actor: A, ...extra }, created_at: at });

  it("keeps a finding open after a fix is reported, until a re-check stops finding it", () => {
    let fs = workspaceFindings(raw, [rec("2026-10-20")], A, "2026-10-25", ran);
    fs = applyWorkflow(fs, [ev("resolve_requested", "2026-10-21")], { now: NOW, lastCheckAt: "2026-10-20" });
    expect(fs[0]).toMatchObject({ status: "pending_verification", verification: "awaiting_recheck" });
    // The re-check after the request still found it.
    fs = applyWorkflow(workspaceFindings(raw, [rec("2026-10-20"), rec("2026-10-22")], A, "2026-10-25", ran), [ev("resolve_requested", "2026-10-21")], { now: NOW, lastCheckAt: "2026-10-22" });
    expect(fs[0]).toMatchObject({ status: "open", verification: "still_present" });
    // Now it's gone from the current run: resolved, with the evidence.
    const gone = applyWorkflow(workspaceFindings([], [rec("2026-10-20")], A, "2026-10-25", ran), [ev("resolve_requested", "2026-10-21")], { now: NOW, lastCheckAt: "2026-10-22" });
    expect(gone[0]).toMatchObject({ id, status: "resolved", verification: "verified_resolved", title: raw[0]!.title });
  });

  it("doesn't call something resolved when the check that would vouch for it couldn't run", () => {
    expect(workspaceFindings([], [rec("2026-10-20")], A, "2026-10-25", [])).toEqual([]);
  });

  it("needs a reason to suppress, and a suppression with an end date expires", () => {
    const fs = workspaceFindings(raw, [rec("2026-10-20")], A, "2026-10-25", ran);
    expect(applyWorkflow(fs, [ev("suppress", "2026-10-21", { note: "Shared on purpose with a partner.", until: "2026-12-01" })], { now: NOW, lastCheckAt: null })[0]!.status).toBe("suppressed");
    const expired = applyWorkflow(fs, [ev("suppress", "2026-10-21", { note: "Shared on purpose.", until: "2026-10-23" })], { now: NOW, lastCheckAt: null })[0]!;
    expect(expired.status).toBe("open");
    expect(expired.history.at(-1)!.action).toBe("suppression_expired");
  });

  it("keeps the agents' own verification for their findings", () => {
    const base = {
      id: P1,
      agent: "code_guardian",
      rule_id: "secret.aws-key",
      title: "AWS key",
      description: "",
      severity: "critical",
      confidence: "confirmed",
      status: "fixed",
      verification: "not_verified",
      verification_note: null,
      asset: `orbis:${P1}`,
      location: "a.ts:1",
      evidence: [],
      evidence_source: "orbis:code-rules",
      remediation: "Rotate",
      related: [],
      first_seen: "2026-10-01",
      last_seen: "2026-10-01",
    };
    expect(fromAgentFinding(base, A)).toMatchObject({ status: "pending_verification", verification: "awaiting_recheck", kind: "verified" });
    expect(fromAgentFinding({ ...base, verification: "not_detected" }, A)).toMatchObject({ status: "resolved", verification: "verified_resolved" });
    expect(fromAgentFinding({ ...base, status: "false_positive" }, A).status).toBe("suppressed");
  });
});

describe("posture never claims a workspace is secure", () => {
  const f = (severity: BastionFinding["severity"], kind: BastionFinding["kind"] = "verified", status: BastionFinding["status"] = "open") =>
    ({ severity, kind, status, checkId: "x" }) as BastionFinding;
  const cov = workspaceCoverage(snap());
  it("follows its published rules", () => {
    expect(posture([f("critical", "suspected")], cov).level).toBe("at_risk");
    expect(posture([f("high", "verified")], cov).level).toBe("at_risk");
    expect(posture([f("high", "suspected")], cov).level).toBe("needs_attention");
    expect(posture([f("medium"), f("medium"), f("medium")], cov).level).toBe("needs_attention");
    expect(posture([f("critical", "verified", "resolved")], cov).level).not.toBe("at_risk");
    const none = posture([], cov);
    expect(none.level).toBe("no_known_serious");
    expect(none.headline).toMatch(/in what Bastion can see/);
    expect(none.headline).not.toMatch(/secure/i);
    const thin = posture(
      [],
      [
        { id: "a", label: "a", state: "not_assessed", note: "" },
        { id: "b", label: "b", state: "not_assessed", note: "" },
        { id: "c", label: "c", state: "assessed", note: "" },
      ],
    );
    expect(thin.level).toBe("insufficient_coverage");
  });
});

describe("the pre-deployment gate", () => {
  const g = (rule_id: string, severity: string, confidence = "firm", status = "open") => ({ rule_id, severity, confidence, status, title: rule_id });
  it("fails on critical, credible high and any credential; passes otherwise; is incomplete without dependencies", () => {
    expect(evaluateGate([g("code.eval", "critical", "tentative")], { depsChecked: true }).passed).toBe(false);
    expect(evaluateGate([g("code.sql", "high")], { depsChecked: true }).passed).toBe(false);
    expect(evaluateGate([g("secret.generic", "low")], { depsChecked: true }).passed).toBe(false);
    expect(evaluateGate([g("code.sql", "high", "tentative"), g("headers.x", "medium")], { depsChecked: true }).passed).toBe(true);
    expect(evaluateGate([g("code.eval", "critical", "firm", "false_positive")], { depsChecked: true }).passed).toBe(true);
    const nodeps = evaluateGate([], { depsChecked: false });
    expect(nodeps.passed).toBe(false);
    expect(nodeps.reasons.join(" ")).toMatch(/incomplete/);
    expect(recheckDepth(["secret.aws"])).toBe("quick");
    expect(recheckDepth(["secret.aws", "deps.osv"])).toBe("deep");
  });
});

describe("agent inventory", () => {
  it("lists customer agents with their reach, never Orbis's internal ones, and shows pauses and limits", () => {
    const inv = buildInventory({
      taskAgents: [
        {
          id: "engineer",
          name: "Software Engineer",
          tagline: "Builds",
          permissions: ["edit_files", "run_commands"],
          permissionLabels: { edit_files: "Edit files", run_commands: "Run commands" },
          approvals: ["The plan"],
          href: "/code",
          available: true,
        },
      ],
      chatAgents: [{ id: "research", name: "Research", description: "Finds things", capabilities: ["web_search"] }],
      customAgents: [{ id: AG, name: "Helper", description: "", capabilities: ["web_search", "file_analysis"], lastUsedAt: null }],
      connectors: [{ connectorId: "gmail", name: "Gmail", status: "connected", writeEnabled: true }],
      activity: {},
      decisions: [{ agent: "engineer", outcome: "deny", at: "2026-10-24T00:00:00Z" }],
      findingsByAsset: {},
      policy: policy({ pausedAgents: ["task:engineer"], customAgentLimits: { [`custom:${AG}`]: ["web_search"] }, allowedIntegrations: [] }),
      platformSuspended: [],
      now: NOW,
    });
    expect(inv.map((a) => a.ref)).toEqual(["task:engineer", "builtin:research", `custom:${AG}`, "task:assistant"]);
    expect(inv.some((a) => /workforce/i.test(a.ref))).toBe(false);
    expect(inv[0]).toMatchObject({ paused: { by: "workspace" }, blocked7d: 1, compliance: "paused" });
    expect(inv[2]!.tools).toEqual(["Reads files you attach"]);
    expect(inv[3]!.dataSources).toEqual(["No connected services it may read"]);
  });
});
