/**
 * The agent platform's endpoints: listing agents with their availability, and
 * starting a Bug Fixing / QA Testing task — sign-in, input validation, the
 * server-side configuration check, project ownership (someone else's project
 * is "not found", as row-level security makes it), one open task per
 * project, and what the created task carries. The database is a stand-in;
 * tests/agent-platform.test.ts covers the profiles themselves.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";
import { DEFAULT_BILLING } from "@/lib/plans";

// Bastion's controls and an empty workspace policy, as stored when nobody has changed anything (tests/bastion*.test.ts cover the rest).
vi.mock("@/lib/bastion/controls", async () => (await import("./stubs/bastion-controls")).defaultBastionControls());
vi.mock("server-only", () => ({}));

const OWN = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const state = { signedIn: true, plan: "free" as "free" | "pro" | "max", sandbox: true, openRun: null as null | { id: string }, created: [] as Record<string, unknown>[] };

const authed = () => ({ mode: "authenticated", user: { id: "user-1", email: "pat@example.com" }, supabase: {} });
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
  return { ...real, isSupabaseConfigured: () => true, serverEnv: () => ({ ...real.serverEnv(), anthropicKey: "set", openaiKey: undefined }) };
});
vi.mock("@/lib/code/workspace", () => ({ workspacesAvailable: () => state.sandbox }));
vi.mock("@/lib/code/server", () => ({
  codeContext: async () => {
    if (!state.signedIn) throw new ApiError("unauthorized", "Please sign in to continue.");
    return authed();
  },
  // Row-level security: another user's project reads as missing.
  getProjectRow: async (_auth: unknown, id: string) => {
    if (id !== OWN) throw new ApiError("not_found", "Project not found.");
    return { id: OWN, name: "Shop" };
  },
}));
vi.mock("@/lib/code/agent/runs", () => ({
  openRun: async () => state.openRun,
  createRun: async (_auth: unknown, input: Record<string, unknown>) => {
    state.created.push(input);
    return { id: "00000000-0000-4000-8000-0000000000c3", project_id: OWN, ...input };
  },
  toRunView: (row: { id: string }) => ({ id: row.id }),
}));

const tasks = await import("@/app/api/agent-platform/tasks/route");
const list = await import("@/app/api/agent-platform/route");
const post = (body: unknown) => tasks.POST(new Request("http://x/api/agent-platform/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const bug = { agent: "bug_fixer", projectId: OWN, input: { summary: "Discount total is wrong", logs: "TypeError: boom\n".repeat(1000) } };

beforeEach(() => Object.assign(state, { signedIn: true, plan: "free", sandbox: true, openRun: null, created: [] }));

describe("GET /api/agent-platform", () => {
  it("lists every agent with whether this user can run it", async () => {
    const j = (await (await list.GET()).json()) as { agents: { agent: { id: string }; availability: { state: string } }[]; plan: string };
    const by = Object.fromEntries(j.agents.map((a) => [a.agent.id, a.availability.state]));
    expect(j.plan).toBe("free");
    expect(by.bug_fixer).toBe("available");
    expect(by.deep_research).toBe("upgrade");
  });

  it("tells a signed-out visitor to sign in, and says when the computer isn't set up", async () => {
    state.signedIn = false;
    let j = (await (await list.GET()).json()) as { agents: { agent: { id: string }; availability: { state: string } }[] };
    expect(j.agents.find((a) => a.agent.id === "qa_tester")!.availability.state).toBe("sign_in");
    state.signedIn = true;
    state.sandbox = false;
    j = (await (await list.GET()).json()) as typeof j;
    expect(j.agents.find((a) => a.agent.id === "qa_tester")!.availability.state).toBe("setup");
  });
});

describe("POST /api/agent-platform/tasks", () => {
  it("requires a signed-in user", async () => {
    state.signedIn = false;
    expect((await post(bug)).status).toBe(401);
    expect(state.created).toHaveLength(0);
  });

  it("validates the form, and only accepts agents built on the coding engine", async () => {
    expect((await post({ ...bug, input: { summary: "" } })).status).toBe(400);
    expect((await post({ ...bug, agent: "deep_research" })).status).toBe(400);
    expect((await post({ agent: "qa_tester", projectId: OWN, input: { scope: "cart", kinds: ["browser"] } })).status).toBe(400);
    expect(state.created).toHaveLength(0);
  });

  it("refuses with a clear reason when the isolated computer isn't configured", async () => {
    state.sandbox = false;
    const r = await post(bug);
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: { message: string } }).error.message).toMatch(/Bug Fixing: Isolated computers aren't available/);
    expect(state.created).toHaveLength(0);
  });

  it("can't start a task on someone else's project", async () => {
    expect((await post({ ...bug, projectId: OTHER })).status).toBe(404);
    expect(state.created).toHaveLength(0);
  });

  it("allows one open task per project", async () => {
    state.openRun = { id: "busy" };
    expect((await post(bug)).status).toBe(409);
  });

  it("creates a task with the agent's profile, plan approval on by default, and logs clipped as the agent sees them", async () => {
    const r = await post(bug);
    expect(r.status).toBe(201);
    const j = (await r.json()) as { href: string };
    expect(j.href).toMatch(new RegExp(`^/code/${OWN}\\?run=.+&from=bug-fixer$`));
    const c = state.created[0] as { request: string; options: Record<string, unknown>; stepLimit: number };
    expect(c.options).toMatchObject({ agent: "bug_fixer", approvePlans: true, reviewEdits: false, commands: "safe", readOnly: false });
    expect(c.request).toMatch(/^Fix this bug: Discount total is wrong/);
    expect(c.request).toContain("<untrusted_log>");
    expect(c.request.length).toBeLessThanOrEqual(8000);
    expect((c.options.agentInput as { logs: string }).logs).toMatch(/characters cut/);
  });

  it("starts a QA task with its own request", async () => {
    const r = await post({ agent: "qa_tester", projectId: OWN, input: { scope: "src/cart.js totals", kinds: ["unit", "integration"] }, options: { approvePlans: false, commands: "ask" } });
    expect(r.status).toBe(201);
    const c = state.created[0] as { request: string; options: Record<string, unknown> };
    expect(c.request).toBe("Write and run unit tests, integration tests for: src/cart.js totals");
    expect(c.options).toMatchObject({ agent: "qa_tester", approvePlans: false, commands: "ask" });
  });
});
