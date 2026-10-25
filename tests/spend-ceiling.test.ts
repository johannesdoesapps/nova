import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const env: Record<string, unknown> = {};
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));

let rows: { estimated_cost: number | null; input_tokens: number | null; output_tokens: number | null }[] = [];
const filters: string[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  serviceSupabase: () => ({
    from: () => {
      const q = { select: () => q, gte: (c: string) => (filters.push(`gte:${c}`), q), gt: (c: string) => (filters.push(`gt:${c}`), q), limit: async () => ({ data: rows, error: null }) };
      return q;
    },
  }),
}));
const alerts: string[] = [];
vi.mock("@/lib/alerts", () => ({ alertOwner: (key: string) => (alerts.push(key), true) }));

const model = { id: "anthropic:claude-haiku-5-5", inputPrice: 0.1, outputPrice: 0.5 } as never;

describe("hard monthly AI spending ceiling", () => {
  beforeEach(() => {
    for (const k of Object.keys(env)) delete env[k];
    rows = [];
    filters.length = 0;
    alerts.length = 0;
    vi.resetModules();
  });

  it("does nothing when no ceiling is set", async () => {
    rows = [{ estimated_cost: 1000, input_tokens: 1, output_tokens: 1 }];
    const { checkSiteCap } = await import("@/lib/budget");
    await expect(checkSiteCap([model], Date.now(), true)).resolves.toBeUndefined();
  });

  it("lets requests through below the ceiling", async () => {
    env.monthlyAiBudgetUsd = 75;
    rows = [
      { estimated_cost: 40, input_tokens: 1, output_tokens: 1 },
      { estimated_cost: 34.5, input_tokens: 1, output_tokens: 1 },
    ];
    const { checkSiteCap } = await import("@/lib/budget");
    await expect(checkSiteCap([model])).resolves.toBeUndefined();
    expect(alerts).toEqual([]);
  });

  it("refuses everyone at the ceiling, administrators included, tells an administrator how to raise it, and alerts the owner", async () => {
    env.monthlyAiBudgetUsd = 75;
    rows = [{ estimated_cost: 75.2, input_tokens: 1, output_tokens: 1 }];
    const { checkSiteCap } = await import("@/lib/budget");
    await expect(checkSiteCap([model], Date.now(), true)).rejects.toMatchObject({ code: "quota_exceeded", message: expect.stringMatching(/ORBIS_MONTHLY_AI_BUDGET_USD/) });
    await expect(checkSiteCap([model], Date.now(), false)).rejects.toMatchObject({ code: "quota_exceeded", message: expect.not.stringMatching(/ORBIS_MONTHLY/) });
    expect(alerts).toContain("site_ceiling");
  });

  it("counts every recorded run (failed calls and helper steps too), not only charged ones", async () => {
    env.monthlyAiBudgetUsd = 10;
    rows = [{ estimated_cost: null, input_tokens: 200_000_000, output_tokens: 0 }];
    const { checkSiteCap } = await import("@/lib/budget");
    await expect(checkSiteCap([model])).rejects.toMatchObject({ code: "quota_exceeded" });
    expect(filters).not.toContain("gt:units");
  });
});
