/**
 * The agent evaluation suite (src/lib/evals/agent-suite.ts) against its baseline (evals/agents/baseline.json).
 * Fails when any suite scores below its baseline. To record a better baseline on purpose:
 *   UPDATE_AGENT_BASELINE=1 npx vitest run tests/agent-evals.test.ts
 * and commit the new baseline with the change that earned it (it's reviewed like any other change).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentSuites } from "@/lib/evals/agent-suite";

const BASELINE = join(process.cwd(), "evals/agents/baseline.json");

describe("agent evaluation suite", () => {
  const results = runAgentSuites();
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as { suites: Record<string, { score: number; total: number }> };

  if (process.env.UPDATE_AGENT_BASELINE === "1") {
    writeFileSync(
      BASELINE,
      `${JSON.stringify({ updated: new Date().toISOString().slice(0, 10), suites: Object.fromEntries(results.map((r) => [r.suite, { score: r.score, total: r.total }])) }, null, 2)}\n`,
    );
  }

  for (const r of results) {
    it(`${r.suite}: ${r.passed}/${r.total} (baseline ${baseline.suites[r.suite]?.score ?? "none"})`, () => {
      if (r.failures.length) console.log(`${r.suite} failures:\n- ${r.failures.join("\n- ")}`);
      const base = baseline.suites[r.suite];
      expect(base, `no baseline for ${r.suite}`).toBeDefined();
      expect(r.score, r.failures.join("\n")).toBeGreaterThanOrEqual(base!.score);
      // Cases are only added: a smaller suite would make the score meaningless.
      expect(r.total).toBeGreaterThanOrEqual(base!.total);
    });
  }
});
