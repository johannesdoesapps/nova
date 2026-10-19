/**
 * POST /api/code/run: sign-in, language and allowance checks, and that a run
 * that can't happen gives its hold back. The database and the sandbox are
 * stand-ins; tests/code-run.test.ts covers the SQL and the runner script.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";
import { DEFAULT_BILLING } from "@/lib/plans";

vi.mock("server-only", () => ({}));

const state = {
  signedIn: true,
  plan: "pro" as "free" | "pro" | "max",
  unlimited: false,
  status: { user_runs: 0, user_in_flight: 1, site_runs: 1 },
  rpc: [] as { fn: string; args: Record<string, unknown> }[],
  inserts: [] as Record<string, unknown>[],
  run: vi.fn(),
};

vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  requireUser: async () => {
    if (!state.signedIn) throw new ApiError("unauthorized", "Please sign in to continue.");
    return {
      mode: "authenticated",
      user: { id: "user-1", email: "pat@example.com" },
      supabase: {
        rpc: async (fn: string, args: Record<string, unknown>) => {
          state.rpc.push({ fn, args });
          return fn === "code_run_status" ? { data: state.status, error: null } : { data: null, error: null };
        },
        from: () => ({ insert: async (row: Record<string, unknown>) => (state.inserts.push(row), { error: null }) }),
      },
    };
  },
}));
vi.mock("@/lib/entitlements", () => ({
  entitlementFor: async () => ({
    plan: state.plan,
    interval: "month",
    limits: { ...DEFAULT_BILLING.plans[state.plan], id: state.plan },
    billing: DEFAULT_BILLING,
    periodStart: null,
    ...(state.unlimited ? { kind: "unlimited", reason: "admin", label: "admin_unlimited" } : { kind: "plan", label: `plan:${state.plan}` }),
  }),
}));
vi.mock("@/lib/usage", () => ({
  enforceLimits: vi.fn(async (_req: Request, _auth: unknown, _cost: number, _models: unknown, opts: { requestId?: string }) => ({ requestId: opts.requestId ?? "req-1", units: 0, entitlement: "plan:pro", estCostUsd: 0.0016 })),
}));
vi.mock("@/lib/code/run", () => ({ codeRunsAvailable: () => true, runCode: (...a: unknown[]) => state.run(...a) }));

const { POST } = await import("@/app/api/code/run/route");
const { enforceLimits } = await import("@/lib/usage");
const RID = "00000000-0000-4000-8000-000000000001";
const post = (body: unknown) => POST(new Request("http://x/api/code/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  Object.assign(state, { signedIn: true, plan: "pro", unlimited: false, status: { user_runs: 0, user_in_flight: 1, site_runs: 1 }, rpc: [], inserts: [] });
  state.run.mockReset();
  state.run.mockResolvedValue({ language: "python", stdout: "5\n", stderr: "", exitCode: 0, timedOut: false, truncated: false, durationMs: 1200 });
});
afterEach(() => vi.clearAllMocks());

describe("POST /api/code/run", () => {
  it("runs the code, records its sandbox cost without the code itself, and says how many runs are left", async () => {
    const res = await post({ language: "py", code: "print(2 + 3)", requestId: RID });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stdout: "5\n", exitCode: 0, runsLeft: DEFAULT_BILLING.plans.pro.codeRunsPerPeriod - 1, timeLimitSeconds: 30 });
    // A run isn't a chat message: Free's daily message cap doesn't apply to it.
    expect(vi.mocked(enforceLimits).mock.calls[0]![4]).toMatchObject({ requestId: RID, purpose: "code_run", extraCostUsd: expect.any(Number), countsAsMessage: false });
    expect(state.run).toHaveBeenCalledWith(expect.objectContaining({ language: "python", code: "print(2 + 3)", seconds: 30 }));
    expect(state.inserts[0]).toMatchObject({ model_id: "vercel:sandbox", purpose: "code_run", tools: ["code_run"], units: 0, request_id: RID, prompt: "Python code run" });
    expect(Number(state.inserts[0]!.estimated_cost)).toBeGreaterThan(0);
    expect(JSON.stringify(state.inserts[0])).not.toContain("print(2 + 3)");
    expect(state.rpc.find((c) => c.fn === "usage_finish")?.args).toEqual({ p_request_id: RID, p_state: "settled" });
  });

  it("needs a signed-in user", async () => {
    state.signedIn = false;
    expect((await post({ language: "python", code: "print(1)" })).status).toBe(401);
    expect(state.run).not.toHaveBeenCalled();
  });

  it("refuses languages it can't run before reserving anything", async () => {
    const res = await post({ language: "rust", code: "fn main() {}" });
    expect(res.status).toBe(400);
    expect(enforceLimits).not.toHaveBeenCalled();
  });

  it("refuses once the plan's runs are used, releasing the hold, and suggests the next plan", async () => {
    state.status = { user_runs: 300, user_in_flight: 1, site_runs: 400 };
    const res = await post({ language: "python", code: "print(1)", requestId: RID });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.message).toMatch(/used this month's 300 code runs/);
    expect(body.error.details).toMatchObject({ scope: "code_runs", upgradeTo: "max" });
    expect(state.rpc.find((c) => c.fn === "usage_finish")?.args).toEqual({ p_request_id: RID, p_state: "released" });
    expect(state.run).not.toHaveBeenCalled();
  });

  it("stops everyone, administrators too, at the site-wide monthly limit", async () => {
    state.unlimited = true;
    state.status = { user_runs: 0, user_in_flight: 1, site_runs: DEFAULT_BILLING.codeRunsSiteMonthly + 1 };
    const res = await post({ language: "python", code: "print(1)" });
    expect(res.status).toBe(429);
    expect((await res.json()).error.details).toMatchObject({ scope: "code_site" });
  });

  it("doesn't count a run the sandbox couldn't start", async () => {
    state.run.mockRejectedValue(new Error("sandbox unavailable"));
    const res = await post({ language: "python", code: "print(1)", requestId: RID });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toMatch(/wasn't counted/);
    expect(state.rpc.find((c) => c.fn === "usage_finish")?.args).toEqual({ p_request_id: RID, p_state: "released" });
    expect(state.inserts).toHaveLength(0);
  });

  it("limits the size of the code", async () => {
    expect((await post({ language: "python", code: "x".repeat(100_001) })).status).toBe(400);
  });
});
