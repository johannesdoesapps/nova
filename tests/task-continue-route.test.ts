/**
 * Starting a task that continues an earlier one (POST /api/code/projects/[id]/agent with continueFrom):
 * the earlier task must be the user's, in the same project and finished, and only one task may be open
 * in a project at a time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";

const PID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PRIOR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const state = {
  open: null as null | { id: string },
  prior: null as null | { id: string; project_id: string; status: string },
  created: [] as Record<string, unknown>[],
  access: [] as string[],
  refuse: false,
};

vi.mock("server-only", () => ({}));
vi.mock("@/lib/code/server", () => ({
  codeContext: async () => ({ mode: "authenticated", user: { id: "u1" }, supabase: {} }),
  getProjectRow: async (_a: unknown, id: string) => ({ id, name: "Shop", description: null, template: "website", runCommand: "", sourceRepo: null, updatedAt: "" }),
  getFiles: async () => [],
}));
vi.mock("@/lib/agent-platform/server", () => ({
  assertAgentAccess: async (_a: unknown, id: string) => {
    state.access.push(id);
    if (state.refuse) throw new ApiError("forbidden", "The Software Engineer is part of the Pro plan.");
  },
}));
vi.mock("@/lib/code/attachments-store", () => ({ linkAttachments: async () => [], pendingAttachments: async () => [] }));
vi.mock("@/lib/code/agent/runs", () => ({
  openRun: async () => state.open,
  getRun: async () => {
    if (!state.prior) throw new ApiError("not_found", "Agent run not found.");
    return state.prior;
  },
  createRun: async (_a: unknown, input: Record<string, unknown>) => {
    state.created.push(input);
    return { id: "new", project_id: PID, request: input.request, status: "planning", options: input.options, created_at: "", updated_at: "" };
  },
  toRunView: (r: { id: string }) => ({ id: r.id }),
  listRuns: async () => [],
  changeCounts: async () => ({}),
}));

const { POST } = await import("@/app/api/code/projects/[id]/agent/route");
const call = (body: Record<string, unknown>) =>
  POST(new Request(`https://tryorbis.app/api/code/projects/${PID}/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: PID }),
  } as never);

beforeEach(() => {
  state.open = null;
  state.prior = { id: PRIOR, project_id: PID, status: "completed" };
  state.created = [];
  state.access = [];
  state.refuse = false;
});

describe("continuing a task", () => {
  it("starts a new task linked to a finished one in the same project", async () => {
    const r = await call({ request: "Add a gallery", continueFrom: PRIOR });
    expect(r.status).toBe(201);
    expect(state.created[0]).toMatchObject({ options: { continueFrom: PRIOR } });
    expect(state.access).toEqual(["engineer"]);
  });

  it("starts nothing when the user may not use the Software Engineer", async () => {
    state.refuse = true;
    expect((await call({ request: "Add a gallery" })).status).toBe(403);
    expect(state.created).toEqual([]);
  });

  it("refuses a task from another project, an open one, and one that's gone or not the user's", async () => {
    state.prior = { id: PRIOR, project_id: OTHER, status: "completed" };
    expect((await call({ request: "x", continueFrom: PRIOR })).status).toBe(400);
    state.prior = { id: PRIOR, project_id: PID, status: "awaiting_approval" };
    const open = await call({ request: "x", continueFrom: PRIOR });
    expect(open.status).toBe(409);
    expect((await open.json()).error.message).toContain("resume it instead");
    state.prior = null;
    expect((await call({ request: "x", continueFrom: PRIOR })).status).toBe(404);
    expect((await call({ request: "x", continueFrom: "not-an-id" })).status).toBe(400);
    expect(state.created).toEqual([]);
  });

  it("doesn't start a second task while one is open in the project (two tabs, a double click)", async () => {
    state.open = { id: "running-one" };
    const r = await call({ request: "Add a gallery", continueFrom: PRIOR });
    expect(r.status).toBe(409);
    expect(state.created).toEqual([]);
  });
});
