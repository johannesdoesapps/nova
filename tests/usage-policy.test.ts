/**
 * Server-side usage policy with a fake Supabase client (mocked; the SQL itself
 * is tested in usage-ledger.test.ts): entitlements, reservations, charging by
 * the model that actually answered, refunds and idempotency.
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODELS } from "@/lib/ai/registry";
import type { AuthContext } from "@/lib/auth";
import { ApiError } from "@/lib/http";
import { enforceLimits, planUsage, recordRun, redactSecrets } from "@/lib/usage";

const haiku = DEFAULT_MODELS.find((m) => m.id === "anthropic:claude-haiku-5-5")!;
const sonnet = DEFAULT_MODELS.find((m) => m.id === "anthropic:claude-sonnet-5-5")!;
const req = () => new Request("http://x/api/chat", { headers: { "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } });

function fakeAuth(opts: { admin?: boolean; plan?: { plan: string; status: string } | null; reserve?: (a: Record<string, unknown>) => unknown } = {}) {
  const rpc: [string, Record<string, unknown>][] = [];
  const inserts: Record<string, unknown>[] = [];
  const supabase = {
    from(table: string) {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: table === "admins" ? (opts.admin ? { user_id: "u" } : null) : (opts.plan ?? null), error: null }),
        insert: async (row: Record<string, unknown>) => {
          inserts.push(row);
          return { error: null };
        },
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpc.push([fn, args]);
      if (fn === "usage_reserve") return { data: opts.reserve ? opts.reserve(args) : { ok: true }, error: null };
      if (fn === "usage_status") return { data: [{ window_used: 3, window_start: "2026-10-19T10:00:00Z", week_used: 40, week_oldest: "2026-10-15T08:00:00Z" }], error: null };
      return { data: null, error: null };
    },
  };
  const auth = { mode: "authenticated", user: { id: "u", email: "u@example.com" }, supabase } as unknown as AuthContext;
  return { auth, rpc, inserts };
}

const run = (model = haiku, extra: Partial<Parameters<typeof recordRun>[1]> = {}) => ({
  model,
  prompt: "hi",
  response: "hello",
  latencyMs: 10,
  usage: { inputTokens: 5, outputTokens: 2, estimated: false },
  status: "success" as const,
  ...extra,
});

afterEach(() => {
  delete process.env.NOVA_ADMINS_UNLIMITED;
});

describe("usage policy", () => {
  it("reserves a Free user's units by model weight against the Free limits", async () => {
    const { auth, rpc } = fakeAuth();
    const t = await enforceLimits(req(), auth, 1, [haiku], { requestId: "00000000-0000-4000-8000-000000000001", purpose: "chat" });
    expect(t).toMatchObject({ units: 1, entitlement: "plan:free", requestId: "00000000-0000-4000-8000-000000000001" });
    expect(rpc[0]).toEqual(["usage_reserve", expect.objectContaining({ p_units: 1, p_window_limit: 15, p_week_limit: 100, p_purpose: "chat" })]);
  });

  it("uses Pro limits only for an active subscription", async () => {
    const pro = fakeAuth({ plan: { plan: "pro", status: "active" } });
    await enforceLimits(req(), pro.auth, 1, [sonnet]);
    expect(pro.rpc[0]![1]).toMatchObject({ p_units: 15, p_window_limit: 150 });
    const lapsed = fakeAuth({ plan: { plan: "pro", status: "canceled" } });
    await enforceLimits(req(), lapsed.auth, 1, [sonnet]);
    expect(lapsed.rpc[0]![1]).toMatchObject({ p_window_limit: 15 });
  });

  it("explains a block, including what a larger model costs", async () => {
    const { auth } = fakeAuth({ reserve: () => ({ ok: false, reason: "limit", scope: "window", used: 3, limit: 15, resets_at: "2026-10-19T15:00:00Z" }) });
    const err = (await enforceLimits(req(), auth, 1, [sonnet]).then(() => null, (e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("quota_exceeded");
    expect(err.message).toMatch(/Claude Sonnet 5\.5 uses 15 units per message and you have 12 left/);
    expect(err.details).toMatchObject({ scope: "window", resetsAt: "2026-10-19T15:00:00.000Z", unitsNeeded: 15, unitsLeft: 12 });
  });

  it("refuses a duplicate submission with 409", async () => {
    const { auth } = fakeAuth({ reserve: () => ({ ok: false, reason: "duplicate" }) });
    const err = (await enforceLimits(req(), auth, 1, [haiku]).then(() => null, (e: unknown) => e)) as ApiError;
    expect(err.code).toBe("conflict");
  });

  it("gives administrators no allowance, enforced on the server, and records it", async () => {
    const { auth, rpc, inserts } = fakeAuth({ admin: true });
    const t = await enforceLimits(req(), auth, 1, [sonnet]);
    expect(t).toMatchObject({ units: 0, entitlement: "admin_unlimited" });
    expect(rpc.some(([fn]) => fn === "usage_reserve")).toBe(false);
    expect(await planUsage(auth)).toBeNull();
    await recordRun(auth, run(sonnet));
    expect(inserts[0]).toMatchObject({ entitlement: "admin_unlimited", units: 15 });
  });

  it("can switch the admin exemption off", async () => {
    process.env.NOVA_ADMINS_UNLIMITED = "false";
    const { auth, rpc } = fakeAuth({ admin: true });
    await enforceLimits(req(), auth, 1, [sonnet]);
    expect(rpc[0]![0]).toBe("usage_reserve");
  });

  it("charges the model that actually answered and settles the reservation", async () => {
    const { auth, rpc, inserts } = fakeAuth();
    const t = await enforceLimits(req(), auth, 1, [sonnet], { requestId: "00000000-0000-4000-8000-000000000002" });
    expect(t.units).toBe(15);
    // Sonnet failed before any text; the fallback (Haiku) answered.
    await recordRun(auth, run(haiku, { routingReason: "Fallback from Claude Sonnet 5.5.", requestedModel: "auto", tools: ["time"] }));
    expect(inserts[0]).toMatchObject({ model_id: haiku.id, units: 1, request_id: "00000000-0000-4000-8000-000000000002", requested_model: "auto", tools: ["time"], entitlement: "plan:free" });
    expect(rpc.at(-1)).toEqual(["usage_finish", { p_request_id: "00000000-0000-4000-8000-000000000002", p_state: "settled" }]);
  });

  it("refunds a failed call that produced no output, but charges a partial reply", async () => {
    const { auth, inserts } = fakeAuth();
    await enforceLimits(req(), auth, 1, [sonnet]);
    await recordRun(auth, run(sonnet, { status: "error", response: "", error: "Upstream 500 with key sk-ant-abcdefghijklmnop" }));
    await recordRun(auth, run(sonnet, { status: "error", response: "partial" }));
    expect(inserts.map((r) => r.units)).toEqual([0, 15]);
    expect(inserts[0]!.error_code).toBe("Upstream 500 with key [redacted]");
  });

  it("reads remaining usage and reset times from the ledger", async () => {
    const { auth } = fakeAuth();
    const u = await planUsage(auth);
    expect(u).toMatchObject({ plan: "free", window: { used: 3, limit: 15, resetsAt: Date.parse("2026-10-19T15:00:00Z") }, week: { used: 40, limit: 100, resetsAt: Date.parse("2026-10-22T08:00:00Z") } });
  });

  it("redacts secrets from stored errors", () => {
    expect(redactSecrets("Bearer abc.def-123 failed for xai-1234567890abcdef")).toBe("Bearer [redacted] failed for [redacted]");
  });
});
