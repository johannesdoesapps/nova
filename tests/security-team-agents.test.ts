/**
 * Security Team agent cards: eleven agents, each with a summary, responsibilities and permissions, and a status taken
 * only from real runs and logged events — idle when nothing has run, never "working" or "completed" by default.
 */
import { describe, expect, it } from "vitest";
import { TEAM_AGENTS, teamAgents, type EventLike, type RunLike, type TeamInput } from "@/lib/security/team-agents";

const base: TeamInput = { runs: [], events: [], integrations: [], fixesAwaitingApproval: 0, activeSchedules: 0, alertsByEmail: true };
const run = (over: Partial<RunLike>): RunLike => ({ id: "r1", parent_id: null, agent: "code_guardian", action: "audit", status: "completed", asset: "github:acme/app", tools: [], error: null, started_at: "2026-10-25T10:00:00Z", finished_at: "2026-10-25T10:01:00Z", ...over });
const ev = (action: string, at: string, detail: Record<string, unknown> = {}): EventLike => ({ action, run_id: null, finding_id: null, detail, created_at: at });
const byId = (input: TeamInput) => Object.fromEntries(teamAgents(input).map((a) => [a.id, a]));

describe("the eleven agents", () => {
  it("each has a name, a one-paragraph summary, responsibilities and a details link", () => {
    expect(TEAM_AGENTS.map((a) => a.name)).toEqual([
      "Security Auditor Agent",
      "Vulnerability Verification Agent",
      "Application Protection Agent",
      "Identity and Access Security Agent",
      "Security Reporting and Remediation Agent",
      "GitHub Security Agent",
      "Vercel Deployment Security Agent",
      "Cloudflare Security Agent",
      "Security Monitoring Agent",
      "Security Fix Agent",
      "Security Orchestrator Agent",
    ]);
    for (const a of teamAgents(base)) {
      expect(a.summary.length).toBeGreaterThan(60);
      expect(a.summary.length).toBeLessThan(260);
      expect(a.responsibilities.length).toBeGreaterThanOrEqual(3);
      expect(a.permissions.length).toBeGreaterThan(0);
      expect(a.details.href).toMatch(/^\/agents\/security/);
    }
  });

  it("are all idle with no activity when nothing has run", () => {
    for (const a of teamAgents(base)) {
      expect(a.status).toBe("idle");
      expect(a.lastActivity).toBeNull();
    }
  });
});

describe("status from real execution only", () => {
  it("shows working only while a matching run is running", () => {
    const a = byId({ ...base, runs: [run({ status: "running", finished_at: null })] });
    expect(a.auditor!.status).toBe("working");
    expect(a.github!.status).toBe("working");
    expect(a.vercel!.status).toBe("idle");
    expect(a.cloudflare!.status).toBe("idle");
  });

  it("reports errors with the reason, and completion with a link to the run", () => {
    const a = byId({
      ...base,
      runs: [run({ agent: "sentinel", action: "cloudflare", asset: "cloudflare:shop.com", status: "failed", error: "The token can't list zones." }), run({ id: "r2", agent: "sentinel", action: "deployment", asset: "vercel:personal/shop" })],
    });
    expect(a.cloudflare!.status).toBe("error");
    expect(a.cloudflare!.statusNote).toMatch(/can't list zones/);
    expect(a.vercel!.status).toBe("completed");
    expect(a.vercel!.lastActivity).toMatchObject({ label: "Vercel deployment audit · vercel:personal/shop", href: "/agents/security/runs/r2" });
  });

  it("counts verification only when the verification step actually ran", () => {
    const skipped = byId({ ...base, runs: [run({ tools: [{ tool: "Independent verification", status: "skipped" }] })] });
    expect(skipped.verification!.status).toBe("idle");
    const ran = byId({ ...base, runs: [run({ tools: [{ tool: "Independent verification", status: "failed", detail: "Model call failed" }] })] });
    expect(ran.verification!.status).toBe("error");
    expect(ran.verification!.statusNote).toBe("Model call failed");
  });

  it("asks for approval only when proposed fixes are waiting", () => {
    expect(byId({ ...base, fixesAwaitingApproval: 2 }).fix!.status).toBe("needs_approval");
    expect(byId({ ...base, fixesAwaitingApproval: 2 }).fix!.statusNote).toMatch(/2 proposed fixes/);
    expect(byId(base).fix!.status).toBe("idle");
  });

  it("monitoring follows scheduled runs and alerts, including failures", () => {
    expect(byId({ ...base, events: [ev("schedule.ran", "2026-10-25T07:17:00Z", { outcome: "completed" })] }).monitoring!.status).toBe("completed");
    const failed = byId({ ...base, events: [ev("schedule.ran", "2026-10-25T07:17:00Z", { outcome: "failed: token expired" })] }).monitoring!;
    expect(failed.status).toBe("error");
    expect(failed.statusNote).toMatch(/token expired/);
  });

  it("the latest of run and event decides", () => {
    const a = byId({ ...base, runs: [run({ agent: "sentinel", action: "cloudflare", asset: "cloudflare:x.com", finished_at: "2026-10-25T09:00:00Z" })], events: [ev("cloudflare.change_failed", "2026-10-25T11:00:00Z", { error: "permission" })] });
    expect(a.cloudflare!.status).toBe("error");
    expect(a.cloudflare!.lastActivity!.label).toBe("A Cloudflare change failed");
  });

  it("the orchestrator follows coordinated audits only", () => {
    expect(byId({ ...base, runs: [run({})] }).orchestrator!.status).toBe("idle");
    expect(byId({ ...base, runs: [run({ agent: "coordinated", action: "deep", asset: null })] }).orchestrator!.status).toBe("completed");
  });
});

describe("permissions reflect the person's connections", () => {
  it("shows not connected, read-only, or write-after-approval", () => {
    expect(byId(base).github!.permissions[0]).toBe("GitHub: not connected");
    expect(byId({ ...base, integrations: [{ id: "github", status: "connected", writeEnabled: false }] }).github!.permissions[0]).toBe("GitHub: read-only");
    expect(byId({ ...base, integrations: [{ id: "cloudflare", status: "connected", writeEnabled: true }] }).cloudflare!.permissions[0]).toBe("Cloudflare: read, plus TLS setting changes after your approval");
  });
});

describe("orchestrator duplicate guard", () => {
  const fakeDb = (busy: boolean) => {
    const inserted: unknown[] = [];
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      limit: async () => ({ data: busy ? [{ id: "x" }] : [] }),
      insert: (row: unknown) => (inserted.push(row), { select: () => ({ single: async () => ({ data: { id: "new" }, error: null }) }) }),
    };
    return { db: { from: () => chain } as never, inserted };
  };

  it("refuses to start the same check on the same target while one is running", async () => {
    const { startRun } = await import("@/lib/db/security");
    const busy = fakeDb(true);
    await expect(startRun(busy.db, "u1", { agent: "sentinel", action: "cloudflare", asset: "cloudflare:shop.com" })).rejects.toThrow(/already running/);
    expect(busy.inserted).toHaveLength(0);
    const free = fakeDb(false);
    await expect(startRun(free.db, "u1", { agent: "sentinel", action: "cloudflare", asset: "cloudflare:shop.com" })).resolves.toBe("new");
  });
});
