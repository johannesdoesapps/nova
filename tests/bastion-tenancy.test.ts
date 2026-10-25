import { beforeEach, describe, expect, it, vi } from "vitest";
import { tenantDb, type Tables } from "./stubs/tenant-db";

/**
 * Tenant isolation for Bastion Customer Security, through the real API routes over a database that applies the
 * same row rules as production. Three people: A (no team), B (team owner) and C (B's teammate). Every attempt to
 * reach another workspace — by changing an id, calling the API directly, or holding a grant without the team —
 * must fail, and every query made for a shared workspace must be filtered to that workspace.
 */

const env = vi.hoisted(() => {
  process.env.ORBIS_CONNECTOR_KEY = Buffer.alloc(32, 7).toString("base64");
  return { db: null as unknown as ReturnType<typeof import("./stubs/tenant-db").tenantDb>, who: "", plans: {} as Record<string, string> };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  requireUser: async () => ({ mode: "authenticated", user: { id: env.who, email: `${env.who}@x.test` }, supabase: env.db.user(env.who) }),
}));
vi.mock("@/lib/entitlements", () => ({ entitlementFor: async (a: { user: { id: string } }) => ({ plan: env.plans[a.user.id] ?? "free", kind: "plan" }) }));
vi.mock("@/lib/admin", () => ({ isAdmin: async () => false }));
vi.mock("@/lib/supabase/admin", () => ({ serviceSupabase: () => env.db.service }));
vi.mock("@/lib/rate-limit", () => ({ limiter: () => ({ check: () => ({ ok: true }) }) }));
vi.mock("@/lib/email", async (orig) => ({ ...(await orig<typeof import("@/lib/email")>()), sendSecurityEmail: async () => false, emailConfigured: () => false }));
vi.mock("@/lib/observability", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/bastion/controls", async (orig) => ({ ...(await orig<typeof import("@/lib/bastion/controls")>()), loadControls: async () => (await import("@/lib/bastion/policy")).DEFAULT_CONTROLS }));

const { GET, POST } = await import("@/app/api/bastion/workspace/route");
const { GET: AUDIT } = await import("@/app/api/bastion/workspace/audit/route");
const { invalidateWorkspacePolicy, loadWorkspacePolicy } = await import("@/lib/bastion/controls");
const { guard } = await import("@/lib/bastion/server");

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const PA = "aaaaaaaa-1111-4111-8111-000000000001";
const PB = "bbbbbbbb-1111-4111-8111-000000000002";
const FA = "aaaaaaaa-2222-4222-8222-000000000001";
const FB = "bbbbbbbb-2222-4222-8222-000000000002";
const AWS = "AKIA" + "ZZZZZZZZZZZZZZZZ";

const finding = (id: string, user: string, asset: string, title: string) => ({
  id,
  user_id: user,
  agent: "code_guardian",
  rule_id: "secret.aws-key",
  title,
  description: "d",
  severity: "high",
  confidence: "confirmed",
  status: "open",
  verification: "not_verified",
  verification_note: null,
  asset,
  location: "a.ts:1",
  evidence: [],
  evidence_source: "orbis:code-rules",
  remediation: "r",
  rationale: "",
  related: [],
  first_seen: "2026-10-20",
  last_seen: "2026-10-20",
  duplicate_of: null,
});

function seed(): Tables {
  return {
    teams: [{ id: "t1", name: "B's team", owner_id: B }],
    team_members: [
      { team_id: "t1", user_id: B, role: "owner", joined_at: "2026-09-01" },
      { team_id: "t1", user_id: C, role: "member", joined_at: "2026-09-02" },
    ],
    bastion_workspace_roles: [
      { owner_id: B, user_id: C, role: "viewer", granted_at: "2026-10-01" },
      // A grant that row rules would never allow (A isn't in B's team) — e.g. left over or inserted out of band.
      { owner_id: B, user_id: A, role: "security_admin", granted_at: "2026-10-01" },
    ],
    agents: [
      { id: "aaaaaaaa-3333-4333-8333-000000000001", user_id: A, name: "A-agent", description: "", capabilities: [], instructions: "Be helpful and kind to everyone.", updated_at: "2026-10-01" },
      {
        id: "bbbbbbbb-3333-4333-8333-000000000002",
        user_id: B,
        name: "B-private-agent",
        description: "",
        capabilities: ["web_search"],
        instructions: `Call the API with ${AWS} please.`,
        updated_at: "2026-10-01",
      },
    ],
    conversations: [],
    connector_accounts: [
      {
        user_id: B,
        connector_id: "gmail",
        status: "connected",
        scopes: ["gmail.compose"],
        write_enabled: true,
        ai_mode: "auto",
        connected_at: "2026-07-01T00:00:00Z",
        last_used_at: null,
        last_error: null,
        secret: "v1.sealed",
      },
    ],
    code_projects: [
      { id: PA, user_id: A, name: "A-shop", source_repo: null },
      { id: PB, user_id: B, name: "B-shop", source_repo: null },
    ],
    code_files: [
      { project_id: PA, path: "index.js", content: "console.log(1)" },
      { project_id: PB, path: ".env", content: "X=1" },
      { project_id: PB, path: "server.js", content: `const k = "${AWS}";` },
    ],
    code_agent_runs: [],
    security_targets: [],
    security_runs: [],
    security_findings: [finding(FA, A, `orbis:${PA}`, "A-finding"), finding(FB, B, `orbis:${PB}`, "B-finding")],
    security_audit: [],
  };
}

const call = async (as: string, path = "", init?: RequestInit) => {
  env.who = as;
  const res = init
    ? await POST(new Request(`https://x.test/api/bastion/workspace${path}`, { ...init, headers: { "content-type": "application/json" } }))
    : await GET(new Request(`https://x.test/api/bastion/workspace${path}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { code: string; message: string } } };
};
const post = (as: string, body: Record<string, unknown>) => call(as, "", { method: "POST", body: JSON.stringify(body) });
const audit = async (as: string, qs = "") => {
  env.who = as;
  const res = await AUDIT(new Request(`https://x.test/api/bastion/workspace/audit${qs}`));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  env.db = tenantDb(seed());
  env.plans = { [A]: "free", [B]: "max", [C]: "max" };
  for (const u of [A, B, C]) invalidateWorkspacePolicy(u);
});

describe("a workspace only ever shows its own data", () => {
  it("serves the caller's own workspace, with none of anyone else's agents, projects or findings", async () => {
    const r = await call(A);
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).toContain("A-agent");
    expect(text).toContain("A-finding");
    for (const other of ["B-private-agent", "B-finding", "B-shop", FB, PB]) expect(text).not.toContain(other);
    expect(text).not.toContain(AWS);
    expect(text).not.toContain("v1.sealed");
  });

  it("refuses another workspace by id — a bad id, an unknown id, or a grant without the shared team — all alike", async () => {
    for (const ws of ["not-a-uuid", "dddddddd-0000-4000-8000-000000000009", B]) {
      const r = await call(A, `?workspace=${ws}`);
      expect(r.status, ws).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain("B-");
    }
  });

  it("lets a teammate with a role see the owner's workspace — only that one, and only through owner-filtered queries", async () => {
    const r = await call(C, `?workspace=${B}`);
    expect(r.status).toBe(200);
    expect(r.body.workspace).toMatchObject({ id: B, shared: true, role: "viewer" });
    const text = JSON.stringify(r.body);
    expect(text).toContain("B-private-agent");
    expect(text).not.toContain("A-agent");
    expect(text).not.toContain(AWS);
    // Every query the service client ran for this request was scoped to B (by owner, or by B's own project ids).
    expect(env.db.log.length).toBeGreaterThan(5);
    for (const q of env.db.log) {
      const scoped =
        q.filters.some(([c, o, v]) => (c === "user_id" || c === "owner_id") && o === "eq" && v === B) ||
        q.filters.some(([c, o, v]) => c === "project_id" && o === "in" && (v as string[]).every((id) => id === PB)) ||
        q.table === "team_members" ||
        q.table === "teams";
      expect(scoped, `${q.table} ${JSON.stringify(q.filters)}`).toBe(true);
    }
  });

  it("keeps shared workspaces to the plan that includes them", async () => {
    env.plans[C] = "pro";
    const r = await call(C, `?workspace=${B}`);
    expect(r.status).toBe(403);
    expect(r.body.error!.code).toBe("plan_required");
  });
});

describe("roles are enforced on the server", () => {
  it("a viewer can read, and audit, but not change anything", async () => {
    expect((await audit(C, `?workspace=${B}`)).status).toBe(200);
    for (const body of [
      { kind: "policy", workspace: B, policy: (await import("@/lib/bastion/customer/policy")).DEFAULT_CUSTOMER_POLICY, expectedVersion: 0, confirm: true },
      { kind: "finding", workspace: B, findingId: FB, action: "acknowledge" },
      { kind: "agent", workspace: B, ref: "task:engineer", action: "pause", confirm: true },
      { kind: "revoke_integration", workspace: B, connectorId: "gmail", confirm: true },
      { kind: "role", workspace: B, userId: C, role: "security_admin", confirm: true },
    ]) {
      const r = await post(C, body);
      expect(r.status, body.kind).toBe(403);
    }
    expect(env.db.tables.connector_accounts![0]!.status).toBe("connected");
  });

  it("a developer works findings but can't read the audit log; the record is the owner's and names who did it", async () => {
    env.db.tables.bastion_workspace_roles![0]!.role = "developer";
    expect((await audit(C, `?workspace=${B}`)).status).toBe(403);
    const r = await post(C, { kind: "finding", workspace: B, findingId: FB, action: "acknowledge" });
    expect(r.status).toBe(200);
    const rec = env.db.tables.security_audit!.find((x) => x.action === "bastion.finding")!;
    expect(rec).toMatchObject({ user_id: B, detail: { findingId: FB, action: "acknowledge", actor: C, workspace: B } });
    expect(typeof (rec.detail as { cid: string }).cid).toBe("string");
  });

  it("a security administrator can't revoke connected services or change roles", async () => {
    env.db.tables.bastion_workspace_roles![0]!.role = "security_admin";
    expect((await post(C, { kind: "revoke_integration", workspace: B, connectorId: "gmail", confirm: true })).status).toBe(403);
    expect((await post(C, { kind: "role", workspace: B, userId: C, role: "viewer", confirm: true })).status).toBe(403);
  });

  it("only the owner grants roles, and only to people in their team", async () => {
    expect((await post(B, { kind: "role", userId: C, role: "security_admin", confirm: true })).status).toBe(200);
    expect(env.db.tables.bastion_workspace_roles!.find((g) => g.owner_id === B && g.user_id === C)!.role).toBe("security_admin");
    expect((await post(B, { kind: "role", userId: A, role: "viewer", confirm: true })).status).toBe(403);
    env.plans[A] = "max";
    expect((await post(A, { kind: "role", userId: B, role: "viewer", confirm: true })).status).toBe(403);
  });
});

describe("ids from another workspace are refused in every action", () => {
  it("findings, projects and policies can't name another workspace's resources", async () => {
    expect((await post(A, { kind: "finding", findingId: FB, action: "acknowledge" })).status).toBe(404);
    expect((await post(A, { kind: "assess_app", projectId: PB, mode: "quick" })).status).toBe(404);
    env.plans[A] = "pro";
    const { DEFAULT_CUSTOMER_POLICY } = await import("@/lib/bastion/customer/policy");
    const r = await post(A, { kind: "policy", policy: { ...DEFAULT_CUSTOMER_POLICY, agentProjects: { "task:engineer": [PB] } }, expectedVersion: 0, confirm: true });
    expect(r.status).toBe(400);
    expect(env.db.tables.security_audit!.some((x) => x.action === "bastion.policy")).toBe(false);
  });

  it("checks the plan on the server", async () => {
    const r = await post(A, { kind: "assess_app", projectId: PA, mode: "deep" });
    expect(r.status).toBe(403);
    expect(r.body.error!.code).toBe("plan_required");
  });
});

describe("workspace policies take effect for that workspace only", () => {
  it("previews, then activates a signed version; another workspace and forged records are unaffected", async () => {
    env.plans[A] = "pro";
    const { DEFAULT_CUSTOMER_POLICY } = await import("@/lib/bastion/customer/policy");
    const next = { ...DEFAULT_CUSTOMER_POLICY, pausedAgents: ["task:engineer"] };
    const preview = await post(A, { kind: "policy", policy: next, expectedVersion: 0, confirm: false });
    expect(preview.body).toMatchObject({ preview: true, version: 1 });
    expect((preview.body.impact as string[]).join(" ")).toMatch(/Software Engineer is paused/);
    expect(env.db.tables.security_audit!.some((x) => x.action === "bastion.policy")).toBe(false);
    expect((await post(A, { kind: "policy", policy: next, expectedVersion: 0, confirm: true })).body).toMatchObject({ preview: false, version: 1 });
    // A stale version is refused.
    expect((await post(A, { kind: "policy", policy: DEFAULT_CUSTOMER_POLICY, expectedVersion: 0, confirm: true })).status).toBe(409);

    // A record added directly with A's own session (not through Orbis) doesn't count.
    await env.db
      .user(A)
      .from("security_audit")
      .insert({ user_id: A, action: "bastion.policy", detail: { version: 9, policy: DEFAULT_CUSTOMER_POLICY } });
    invalidateWorkspacePolicy(A);
    const wsA = await loadWorkspacePolicy(env.db.user(A) as never, A);
    expect(wsA !== "unavailable" && wsA.current.version).toBe(1);

    // Enforcement: A's engineer is refused; B's isn't.
    const req = (user: string) => guard({ db: env.db.user(user) as never, userId: user, kind: "agent", agent: "engineer" }, "file.write", "a.js");
    expect(await req(A)).toMatchObject({ outcome: "deny", source: "workspace" });
    expect((await req(B)).outcome).toBe("allow");
    // And A can't write into B's records at all.
    const { error } = await env.db.user(A).from("security_audit").insert({ user_id: B, action: "bastion.policy", detail: {} });
    expect(error).not.toBeNull();
  });

  it("only the owner revokes a connected service, and the result is confirmed before it's reported", async () => {
    const r = await post(B, { kind: "revoke_integration", connectorId: "gmail", confirm: true });
    expect(r.body).toMatchObject({ ok: true, confirmed: true });
    expect(env.db.tables.connector_accounts![0]).toMatchObject({ status: "disconnected", secret: null });
    expect(env.db.tables.security_audit!.find((x) => x.action === "bastion.integration")).toMatchObject({ user_id: B, detail: { outcome: "confirmed" } });
  });
});

describe("assessments and audit stay inside the workspace", () => {
  it("a quick check of B's project finds B's credential, stores it as B's, and A sees none of it", async () => {
    const r = await post(B, { kind: "assess_app", projectId: PB, mode: "quick" });
    expect(r.status).toBe(200);
    const mine = env.db.tables.security_findings!.filter((f) => f.asset === `orbis:${PB}`);
    expect(mine.length).toBeGreaterThan(1);
    expect(mine.every((f) => f.user_id === B)).toBe(true);
    expect(JSON.stringify(env.db.tables.security_findings)).not.toContain(AWS);
    const a = await call(A);
    expect(JSON.stringify(a.body)).not.toContain("B-shop");
    const log = await audit(A);
    expect(JSON.stringify(log.body)).not.toContain(B);
  });

  it("runs the workspace checks and records them as signed evidence", async () => {
    const r = await post(B, { kind: "run_checks" });
    expect(r.status).toBe(200);
    const rec = env.db.tables.security_audit!.find((x) => x.action === "bastion.assessment")!;
    expect(rec.user_id).toBe(B);
    expect(typeof (rec.detail as { sig?: string }).sig).toBe("string");
    const state = await call(B);
    const f = (state.body.findings as { checkId: string; title: string }[]).find((x) => x.checkId === "agents.secret-in-instructions");
    expect(f?.title).toMatch(/B-private-agent/);
    const l = await audit(B, "?area=findings");
    expect((l.body.rows as { integrity: string }[]).every((x) => x.integrity === "signed")).toBe(true);
  });
});
