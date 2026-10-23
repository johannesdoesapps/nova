/**
 * Starting, extending and stopping a project's workspace computer, with
 * stand-ins for Supabase and Vercel Sandbox: time is checked before a
 * computer starts, a computer whose time block is refused is stopped at once,
 * a user runs one computer at a time, and a stopped computer is never resumed.
 * tests/code-workspace-db.test.ts covers the SQL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_BILLING } from "@/lib/plans";

vi.mock("server-only", () => ({}));
vi.mock("@vercel/sandbox", () => ({ Sandbox: { create: vi.fn(), get: vi.fn() } }));

const state = {
  plan: "pro" as "free" | "pro" | "max",
  status: { user_minutes: 0, site_minutes: 0, site_live: 0 },
  reserve: { ok: true } as Record<string, unknown>,
  live: [] as { session_id: string; project_id: string; ends_at: string }[],
  rpc: [] as { fn: string; args: Record<string, unknown> }[],
  inserts: [] as { table: string; row: unknown }[],
};

/** Enough of the Supabase query builder for the workspace code. */
function table(name: string) {
  const filters: [string, string, unknown][] = [];
  const rows = () => {
    if (name === "code_workspace_live") return state.live.filter((r) => filters.every(([op, col, v]) => (op === "eq" ? r[col as keyof typeof r] === v : r[col as keyof typeof r] !== v)));
    if (name === "code_files") return [{ path: "index.html", content: "<h1>hi</h1>" }];
    return [];
  };
  const b = {
    select: () => b,
    eq: (col: string, v: unknown) => (filters.push(["eq", col, v]), b),
    neq: (col: string, v: unknown) => (filters.push(["neq", col, v]), b),
    order: () => b,
    limit: () => b,
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    insert: async (row: unknown) => (state.inserts.push({ table: name, row }), { error: null }),
    then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data: rows(), error: null }),
  };
  return b;
}

const auth = {
  mode: "authenticated",
  user: { id: "user-1", email: "pat@example.com" },
  supabase: {
    from: table,
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpc.push({ fn, args });
      if (fn === "code_workspace_status") return { data: state.status, error: null };
      if (fn === "code_workspace_reserve") return { data: state.reserve.ok ? { ok: true, id: args.p_block, session: args.p_session ?? args.p_block, used: 10 } : state.reserve, error: null };
      return { data: null, error: null };
    },
  },
} as never;

vi.mock("@/lib/entitlements", () => ({
  entitlementFor: async () => ({ plan: state.plan, interval: "month", limits: { ...DEFAULT_BILLING.plans[state.plan], id: state.plan }, billing: DEFAULT_BILLING, periodStart: null, kind: "plan", label: `plan:${state.plan}` }),
}));

const { startSession, extendSession, requireBox, stopSession } = await import("@/lib/code/server");

function fakeBackend() {
  const boxes = new Map<string, { stopped: boolean; files: string[]; extended: number }>();
  const backend = {
    create: vi.fn(async (name: string) => {
      const rec = { stopped: false, files: [] as string[], extended: 0 };
      boxes.set(name, rec);
      return {
        writeFiles: async (f: { path: string }[]) => void rec.files.push(...f.map((x) => x.path)),
        runCommand: async () => ({ exitCode: 0, stdout: async () => "" }),
        domain: () => `https://${name}.vercel.run`,
        extendTimeout: async (ms: number) => void (rec.extended += ms),
        stop: async () => void (rec.stopped = true),
      };
    }),
    get: vi.fn(async (name: string) => {
      const rec = boxes.get(name);
      if (!rec || rec.stopped) return null;
      return {
        writeFiles: async () => {},
        runCommand: async () => ({ exitCode: 0, stdout: async () => "" }),
        domain: () => `https://${name}.vercel.run`,
        extendTimeout: async (ms: number) => void (rec.extended += ms),
        stop: async () => void (rec.stopped = true),
      };
    }),
  };
  return { backend, boxes };
}

const project = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Site", description: null, template: "website", runCommand: "", sourceRepo: null, updatedAt: "" };

beforeEach(() => {
  process.env.ORBIS_SANDBOX_TOKEN = "test";
  Object.assign(state, { plan: "pro", status: { user_minutes: 0, site_minutes: 0, site_live: 0 }, reserve: { ok: true }, live: [], rpc: [], inserts: [] });
});

describe("workspace sessions", () => {
  it("starts a computer, copies the project in, reserves a block and records its cost", async () => {
    const { backend, boxes } = fakeBackend();
    const s = await startSession(auth, project, backend);
    const name = `orbis-ws-${s.sessionId}`;
    expect(backend.create).toHaveBeenCalledWith(name, DEFAULT_BILLING.workspaceBlockMinutes);
    expect(boxes.get(name)!.files).toEqual(["/tmp/orbis-jobs/collect.mjs", "/vercel/sandbox/index.html"]);
    const r = state.rpc.find((x) => x.fn === "code_workspace_reserve")!.args;
    expect(r).toMatchObject({ p_block: s.sessionId, p_project: project.id, p_session: null, p_minutes: 10, p_user_limit: DEFAULT_BILLING.plans.pro.workspaceMinutesPerPeriod });
    expect(state.inserts[0]).toMatchObject({ table: "model_runs", row: { tools: ["code_workspace"], latency_ms: 600_000, request_id: s.sessionId, units: 0 } });
    expect(s.previewUrl).toBe(`https://${name}.vercel.run`);
    expect(s.allowance).toMatchObject({ used: 10, left: DEFAULT_BILLING.plans.pro.workspaceMinutesPerPeriod - 10 });
  });

  it("refuses before starting a computer when the plan's minutes are used up", async () => {
    const { backend } = fakeBackend();
    state.status.user_minutes = DEFAULT_BILLING.plans.pro.workspaceMinutesPerPeriod - 5;
    await expect(startSession(auth, project, backend)).rejects.toThrow(/You've used 195 of your 200 workspace minutes/);
    expect(backend.create).not.toHaveBeenCalled();
    state.plan = "free";
    state.status.user_minutes = 0;
    state.status.site_live = DEFAULT_BILLING.workspaceSiteConcurrent;
    await expect(startSession(auth, project, backend)).rejects.toThrow(/All workspace computers are busy/);
  });

  it("stops the new computer at once when the reserve is refused (a concurrent start won)", async () => {
    const { backend, boxes } = fakeBackend();
    state.reserve = { ok: false, reason: "user", used: 200 };
    await expect(startSession(auth, project, backend)).rejects.toThrow(/workspace minutes/);
    expect([...boxes.values()].every((b) => b.stopped)).toBe(true);
    expect(state.inserts).toEqual([]);
  });

  it("runs one computer per user: starting another project stops the first", async () => {
    const { backend, boxes } = fakeBackend();
    const first = await startSession(auth, { ...project, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, backend);
    state.live = [{ session_id: first.sessionId, project_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ends_at: new Date(Date.now() + 600_000).toISOString() }];
    await startSession(auth, project, backend);
    expect(boxes.get(`orbis-ws-${first.sessionId}`)!.stopped).toBe(true);
  });

  it("extends the running computer by a block and refuses once it has stopped", async () => {
    const { backend, boxes } = fakeBackend();
    const s = await startSession(auth, project, backend);
    state.live = [{ session_id: s.sessionId, project_id: project.id, ends_at: s.endsAt }];
    const e = await extendSession(auth, project, backend);
    expect(Date.parse(e.endsAt) - Date.parse(s.endsAt)).toBe(10 * 60_000);
    expect(boxes.get(`orbis-ws-${s.sessionId}`)!.extended).toBe(10 * 60_000);
    expect(state.rpc.filter((x) => x.fn === "code_workspace_reserve").at(-1)!.args.p_session).toBe(s.sessionId);
    await stopSession(auth, project.id, backend);
    await expect(extendSession(auth, project, backend)).rejects.toThrow(/already stopped/);
    await expect(requireBox(auth, project.id, backend)).rejects.toThrow(/isn't running/);
  });

  it("won't use a computer in its last seconds (so it can't be restarted unpaid)", async () => {
    const { backend } = fakeBackend();
    const s = await startSession(auth, project, backend);
    state.live = [{ session_id: s.sessionId, project_id: project.id, ends_at: new Date(Date.now() + 5_000).toISOString() }];
    await expect(requireBox(auth, project.id, backend)).rejects.toThrow(/isn't running/);
  });
});
