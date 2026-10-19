/**
 * Every endpoint that calls an AI model must hand the model(s) it will run to
 * enforceLimits, so plan access (no premium models on Free), the premium
 * budget and the cost estimate apply. A call without them only meters units.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTES = [
  "src/app/api/chat/route.ts",
  "src/app/api/agents/chat/route.ts",
  "src/app/api/compare/route.ts",
  "src/app/api/search/route.ts",
  "src/app/api/verify/route.ts",
  "src/app/api/claims/analyze/route.ts",
  "src/app/api/claims/hypotheses/route.ts",
  "src/app/api/intel/route/route.ts",
  "src/app/api/intel/trials/route.ts",
  "src/app/api/intel/benchmarks/route.ts",
  "src/app/api/missions/plan/route.ts",
  "src/app/api/missions/tasks/[taskId]/run/route.ts",
  "src/lib/council/run.ts",
  "src/lib/security/runners.ts",
];

describe("AI endpoints pass their models to the usage guard", () => {
  for (const f of ROUTES) {
    it(f, () => {
      const src = readFileSync(join(__dirname, "..", f), "utf8");
      const calls = [...src.matchAll(/enforceLimits\(([^;]*?)\);/gs)].map((m) => m[1]!);
      expect(calls.length, "no enforceLimits call").toBeGreaterThan(0);
      for (const c of calls) {
        const args = c.split(",").map((a) => a.trim());
        // req, auth, cost, models[, opts]
        expect(args.length, `enforceLimits(${c.slice(0, 80)}) has no model list`).toBeGreaterThanOrEqual(4);
      }
    });
  }

  it("the web-search endpoint meters the search", () => {
    const src = readFileSync(join(__dirname, "..", "src/app/api/council/sources/route.ts"), "utf8");
    expect(src).toMatch(/enforceLimits\(/);
    expect(src).toMatch(/tools: \["web_search"\]/);
    expect(src).toMatch(/webSearchesLeft/);
  });

  it("the engine proxy requires an account for changes and an admin for model calls", () => {
    const src = readFileSync(join(__dirname, "..", "src/app/api/engine/[...path]/route.ts"), "utf8");
    expect(src).toMatch(/Sign in to make changes/);
    expect(src).toMatch(/use_model/);
    expect(src).toMatch(/p === "\.\."/);
  });
});
