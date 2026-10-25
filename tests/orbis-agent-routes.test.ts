/**
 * POST /api/agent-platform/delegate (the Start button on a task the Orbis
 * Agent proposed) and GET /api/activity: sign-in, the agent's access for the
 * user's plan, project ownership (another user's project reads as missing),
 * input checked again on the server, and the card's outcome kept with the
 * saved reply. The database and the task runtimes are stand-ins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";
import { DEFAULT_BILLING } from "@/lib/plans";

// Bastion's controls as stored when an administrator hasn't changed anything (tests/bastion.test.ts covers the rest).
vi.mock("@/lib/bastion/controls", async () => ({ loadControls: async () => (await import("@/lib/bastion/policy")).DEFAULT_CONTROLS, invalidateControls: () => {} }));
vi.mock("server-only", () => ({}));

const OWN = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const MSG = "00000000-0000-4000-8000-0000000000d4";
const PROPOSAL = "00000000-0000-4000-8000-0000000000e5";
const state = {
  signedIn: true,
  plan: "free" as "free" | "pro" | "max",
  runs: [] as Record<string, unknown>[],
  reviews: [] as unknown[],
  research: [] as unknown[],
  message: { usage_metadata: { tasks: [{ id: PROPOSAL, agent: "engineer", status: "proposed", input: {} }] } } as { usage_metadata: { tasks: Record<string, unknown>[] } },
};

function fakeSupabase() {
  const q = (table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => ({ data: table === "code_agent_runs" ? [] : [], error: null }),
      maybeSingle: async () => ({ data: table === "messages" ? state.message : null, error: null }),
      update: (patch: { usage_metadata: { tasks: Record<string, unknown>[] } }) => {
        if (table === "messages") state.message = patch;
        return { eq: async () => ({ error: null }) };
      },
    };
    return chain;
  };
  return { from: q };
}

const authed = () => ({ mode: "authenticated", user: { id: "user-1", email: "pat@example.com" }, supabase: fakeSupabase() });
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), getAuth: async () => (state.signedIn ? authed() : { mode: "guest", user: null, supabase: null }) }));
vi.mock("@/lib/admin", () => ({ isAdmin: async () => false }));
vi.mock("@/lib/entitlements", () => ({
  entitlementFor: async () => ({
    plan: state.plan,
    interval: "month",
    limits: { ...DEFAULT_BILLING.plans[state.plan], id: state.plan },
    billing: DEFAULT_BILLING,
    periodStart: null,
    paymentIssue: null,
    kind: "plan",
    label: `plan:${state.plan}`,
  }),
}));
vi.mock("@/lib/env", async (orig) => {
  const real = await orig<typeof import("@/lib/env")>();
  return { ...real, isSupabaseConfigured: () => true, serverEnv: () => ({ ...real.serverEnv(), anthropicKey: "set" }) };
});
vi.mock("@/lib/code/workspace", () => ({ workspacesAvailable: () => true }));
vi.mock("@/lib/code/server", () => ({
  codeContext: async () => {
    if (!state.signedIn) throw new ApiError("unauthorized", "Please sign in to continue.");
    return authed();
  },
  getProjectRow: async (_a: unknown, id: string) => {
    if (id !== OWN) throw new ApiError("not_found", "Project not found.");
    return { id: OWN, name: "Shop" };
  },
}));
vi.mock("@/lib/code/agent/runs", () => ({
  openRun: async () => null,
  createRun: async (_a: unknown, input: Record<string, unknown>) => (state.runs.push(input), { id: "00000000-0000-4000-8000-0000000000c3", ...input }),
  toRunView: (r: { id: string }) => ({ id: r.id }),
}));
vi.mock("@/lib/review/server", () => ({ createReview: async (_r: unknown, _a: unknown, input: unknown) => (state.reviews.push(input), { id: "rev-1", title: "Shop" }) }));
vi.mock("@/lib/research/server", () => ({ createResearch: async (_a: unknown, input: unknown) => (state.research.push(input), { id: "res-1" }) }));

const { POST } = await import("@/app/api/agent-platform/delegate/route");
const activity = await import("@/app/api/activity/route");
const post = (body: unknown) => POST(new Request("http://x/api/agent-platform/delegate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeEach(() => {
  Object.assign(state, { signedIn: true, plan: "free", runs: [], reviews: [], research: [] });
  state.message = { usage_metadata: { tasks: [{ id: PROPOSAL, agent: "engineer", status: "proposed", input: {} }] } };
});

describe("starting a proposed task", () => {
  it("requires a signed-in user", async () => {
    state.signedIn = false;
    expect((await post({ agent: "engineer", projectId: OWN, input: { request: "Add a footer" } })).status).toBe(401);
    expect(state.runs).toHaveLength(0);
  });

  it("checks the agent's plan access on the server (Deep Research isn't on Free)", async () => {
    const r = await post({ agent: "deep_research", input: { question: "Compare Neon and Supabase free tiers" } });
    expect(r.status).toBe(403);
    expect(state.research).toHaveLength(0);
    state.plan = "pro";
    expect((await post({ agent: "deep_research", input: { question: "Compare Neon and Supabase free tiers", depth: "quick" } })).status).toBe(201);
    expect(state.research).toEqual([{ question: "Compare Neon and Supabase free tiers", depth: "quick", context: null }]);
  });

  it("can't start a task on someone else's project, or without one", async () => {
    expect((await post({ agent: "bug_fixer", projectId: OTHER, input: { summary: "Total wrong" } })).status).toBe(404);
    expect((await post({ agent: "engineer", projectId: null, input: { request: "Add a footer" } })).status).toBe(400);
    expect(state.runs).toHaveLength(0);
  });

  it("checks the (possibly edited) input again", async () => {
    expect((await post({ agent: "engineer", projectId: OWN, input: { request: "" } })).status).toBe(400);
    expect((await post({ agent: "code_review", input: { focus: "auth" } })).status).toBe(400);
  });

  it("starts the task, keeps approvals on, and marks the card started on the saved reply", async () => {
    const r = await post({ agent: "engineer", projectId: OWN, input: { request: "Add a footer" }, messageId: MSG, proposalId: PROPOSAL });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ ok: true, href: `/code/${OWN}?run=00000000-0000-4000-8000-0000000000c3` });
    expect(state.runs[0]).toMatchObject({ projectId: OWN, request: "Add a footer", options: { approvePlans: true, commands: "safe", readOnly: false } });
    expect(state.message.usage_metadata.tasks[0]).toMatchObject({ status: "started", result: { href: `/code/${OWN}?run=00000000-0000-4000-8000-0000000000c3` } });
  });

  it("a read-only engineer task can't edit or run anything", async () => {
    await post({ agent: "engineer", projectId: OWN, input: { request: "Explain the checkout flow", readOnly: true } });
    expect(state.runs[0]).toMatchObject({ options: { readOnly: true, commands: "off", approvePlans: false } });
  });

  it("a failure is recorded on the card too", async () => {
    await post({ agent: "bug_fixer", projectId: OTHER, input: { summary: "Total wrong" }, messageId: MSG, proposalId: PROPOSAL });
    expect(state.message.usage_metadata.tasks[0]).toMatchObject({ status: "failed", result: { summary: "Project not found." } });
  });

  it("reviews a project or a GitHub link", async () => {
    await post({ agent: "code_review", projectId: OWN, input: { focus: "auth" } });
    await post({ agent: "code_review", input: { url: "https://github.com/a/b/pull/3" } });
    expect(state.reviews).toEqual([
      { source: { kind: "project", projectId: OWN }, focus: "auth" },
      { source: { kind: "github", url: "https://github.com/a/b/pull/3" }, focus: null },
    ]);
  });
});

describe("GET /api/activity", () => {
  it("requires a signed-in user", async () => {
    state.signedIn = false;
    expect((await activity.GET()).status).toBe(401);
  });
});
