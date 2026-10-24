import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Monthly } from "@/components/studio/usage-page";
import type { PlanInfo } from "@/components/studio/usage";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const plan: PlanInfo = { id: "pro", label: "Pro", interval: "month", unlimited: false, webSearchesLeft: 10, webSearches: 50, upgradeTo: { id: "max", label: "Max", priceUsd: 100 } };

describe("monthly allowances on the Usage page", () => {
  it("shows each allowance against its limit, warns at 80% and says when it's used up", () => {
    const html = renderToStaticMarkup(
      createElement(Monthly, {
        a: { resetsAt: "2026-11-01T00:00:00Z", codeRuns: { used: 85, limit: 100 }, workspaceMinutes: { used: 600, limit: 600, blockMinutes: 10 }, codeProjects: { used: 2, limit: 10 } },
        plan,
      }),
    );
    expect(html).toContain("Monthly allowances");
    expect(html).toContain("Workspace computer");
    expect(html).toContain("10-minute blocks");
    expect(html).toContain("Over 80% used.");
    expect(html).toContain("Used up for this month.");
    expect(html).toContain("Web searches");
    expect(html).toMatch(/40[^0-9]+50/);
  });

  it("says when a figure can't be read, and when it isn't in the plan, instead of showing zero", () => {
    const html = renderToStaticMarkup(
      createElement(Monthly, { a: { resetsAt: "2026-11-01T00:00:00Z", codeRuns: null, workspaceMinutes: { used: 0, limit: 0, blockMinutes: 10 }, codeProjects: null }, plan: null }),
    );
    expect(html).toContain("Couldn&#x27;t be read right now");
    expect(html).toContain("Not included in your plan");
  });
});

describe("pricing copy matches how usage is charged", () => {
  const pricing = src("src/app/(marketing)/pricing/page.tsx");
  const site = src("src/content/site.ts");

  it("doesn't claim an agent step costs one message, since steps are charged by size", () => {
    for (const s of [pricing, site]) expect(s).not.toMatch(/counts? as (a|one) message|each counted like a message/i);
    expect(pricing).toContain("charged like a message of its size");
  });

  it("lists who each plan is for, Pair Coding, extra usage and what happens to stopped or failed work", () => {
    expect(pricing).toContain("Who it's for");
    expect(pricing).toContain("Pair Coding (two models)");
    expect(pricing).toContain("Extra usage");
    expect(pricing).toMatch(/failed before replying/);
  });
});
