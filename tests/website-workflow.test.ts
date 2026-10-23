/**
 * The website workflow's pure parts: optional details added to a request,
 * the likely cause of a failed command, the browser check at three sizes,
 * a follow-up's view of the last session's checks, and the report as
 * rendered for a site checked only in a browser and for one with failures.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VerificationPanel } from "@/components/code/verification-panel";
import { diagnoseOutput } from "@/lib/code/agent/diagnose";
import type { RunReport, RunView } from "@/lib/code/agent/types";
import { checksSummary, fixRequest, TASK_STATE_INFO } from "@/lib/code/agent/verdict";
import { CHECK_SCRIPT, summarizeCheck, type CheckViewport } from "@/lib/code/preview-check";
import { withSiteDetails } from "@/lib/code/site-examples";

describe("optional details for a new site", () => {
  it("adds only the details that were filled in, and nothing when none were", () => {
    expect(withSiteDetails("  Build a site for my bakery ", {})).toBe("Build a site for my bakery");
    expect(withSiteDetails("Build a site for my bakery", { purpose: "", audience: "  ", style: "warm,\n rustic" })).toBe("Build a site for my bakery\n\nDetails:\n- Look and feel: warm, rustic");
    expect(withSiteDetails("Build it", { purpose: "orders", audience: "locals", style: "warm", sections: "menu, hours" })).toBe(
      "Build it\n\nDetails:\n- Purpose: orders\n- Who it's for: locals\n- Look and feel: warm\n- Key sections: menu, hours",
    );
    expect(withSiteDetails("x", { purpose: "a".repeat(1000) }).length).toBeLessThan(330);
  });
});

describe("why a command failed", () => {
  it("names a missing dependency from Node, bundler, shell and Python output", () => {
    expect(diagnoseOutput("Error: Cannot find module 'express'\nRequire stack:")).toMatchObject({ kind: "missing_dependency", name: "express" });
    expect(diagnoseOutput('[vite] Failed to resolve import "react-router-dom" from "src/App.jsx"')).toMatchObject({ kind: "missing_dependency", name: "react-router-dom" });
    expect(diagnoseOutput("Module not found: Error: Can't resolve 'lodash' in '/app/src'")).toMatchObject({ name: "lodash" });
    expect(diagnoseOutput("> dev\n> vite\n\nsh: 1: vite: not found")).toMatchObject({ kind: "missing_dependency", name: "vite", hint: expect.stringContaining("npm install") });
    expect(diagnoseOutput("Traceback...\nModuleNotFoundError: No module named 'flask'")).toMatchObject({ name: "flask", hint: expect.stringContaining("pip install") });
  });

  it("tells a blocked download and a busy port apart, and guesses nothing else", () => {
    expect(diagnoseOutput("fetch failed: getaddrinfo ENOTFOUND fonts.googleapis.com")).toMatchObject({ kind: "network_blocked" });
    expect(diagnoseOutput("Error: listen EADDRINUSE: address already in use 0.0.0.0:3000")).toMatchObject({ kind: "port_in_use" });
    expect(diagnoseOutput("src/App.tsx(3,1): error TS2304: Cannot find name 'foo'.")).toBeNull();
    expect(diagnoseOutput("")).toBeNull();
    expect(diagnoseOutput(null)).toBeNull();
  });
});

describe("the browser check at three sizes", () => {
  const vp = (name: CheckViewport["name"], width: number, overflowX = 0): CheckViewport => ({
    name,
    width,
    height: 800,
    status: 200,
    title: "Site",
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    external: [],
    overflowX,
    wide: overflowX ? ["div.grid"] : [],
    page: {
      headings: ["h1: Site"],
      nav: [],
      buttons: [],
      images: 0,
      imagesWithoutAlt: 0,
      brokenImages: [],
      brokenAnchors: [],
      placeholders: [],
      forms: [],
      height: 900,
      textLength: 500,
      viewportMeta: true,
      lang: "en",
    },
  });

  it("opens the page at desktop, tablet and phone widths", () => {
    expect(CHECK_SCRIPT).toContain('{ name: "tablet", width: 768, height: 1024');
    expect(CHECK_SCRIPT).toContain('{ name: "phone", width: 390');
  });

  it("names the sizes it checked and reports a problem at tablet width on its own", () => {
    const ok = summarizeCheck({ url: "/", viewports: [vp("desktop", 1280), vp("tablet", 768), vp("phone", 390)], links: [], error: null });
    expect(ok).toMatchObject({ verdict: "passed", sizes: ["desktop 1280px", "tablet 768px", "phone 390px"] });
    const tablet = summarizeCheck({ url: "/", viewports: [vp("desktop", 1280), vp("tablet", 768, 64), vp("phone", 390)], links: [], error: null });
    expect(tablet.problems).toEqual(["Tablet 768×800: the page scrolls sideways by 64px (too wide: div.grid)."]);
  });

  it("fails honestly when the browser can't run", () => {
    expect(summarizeCheck({ url: "/", viewports: [], links: [], error: "Failed to launch the browser process!" })).toMatchObject({
      verdict: "failed",
      problems: ["The check couldn't run: Failed to launch the browser process!"],
      sizes: [],
    });
  });
});

const AT = "2026-10-23T10:00:00.000Z";
function report(o: Partial<RunReport> = {}): RunReport {
  return {
    outcome: "completed",
    summary: "Built the page.",
    unresolved: [],
    files: [{ path: "index.html", change: "modified", added: 40, removed: 1 }],
    commands: [],
    tests: null,
    verification: "not_run",
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, modelCalls: 1, models: [], steps: 3, activeMs: 1000 },
    checkpoints: 0,
    createdAt: AT,
    testSetup: null,
    web: true,
    checks: {
      server: { command: "python3 -m http.server 3000", state: "running", http: 200, at: AT, freshness: "current" },
      preview: { path: "/", verdict: "passed", problems: [], warnings: [], checkedAt: AT, freshness: "current", sizes: ["desktop 1280px", "tablet 768px", "phone 390px"] },
      build: null,
    },
    ...o,
  };
}
const view = (r: RunReport): RunView =>
  ({
    id: "r1",
    projectId: "p1",
    request: "Build a landing page",
    status: "completed",
    options: { modelId: null, approvePlans: false, reviewEdits: false, commands: "safe", web: true },
    plan: null,
    pending: null,
    summary: r.summary,
    error: null,
    steps: 3,
    stepLimit: 20,
    busy: false,
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, modelCalls: 1, models: [] },
    tokenBudget: 600_000,
    activeMs: 1000,
    timeLimitMs: 1_800_000,
    tests: null,
    checks: { server: null, preview: null, build: null },
    report: r,
    createdAt: AT,
    updatedAt: AT,
    version: `${AT}|`,
    stepStartedAt: null,
    pair: null,
  }) as RunView;
const props = { onShowChanges: () => {}, onOpenFile: () => {}, onRerun: async () => {}, onUndo: async () => {} };

describe("the report for a website", () => {
  it("says a site that only loaded in a browser is checked, not verified, and why", () => {
    const html = renderToStaticMarkup(createElement(VerificationPanel, { ...props, run: view(report()), onAskFix: () => {} }));
    expect(html).toContain(TASK_STATE_INFO.checked.label);
    expect(html).not.toContain(TASK_STATE_INFO.verified.label);
    expect(html).toContain("/ loaded at desktop 1280px, tablet 768px, phone 390px with no problems found");
    expect(html).toContain("not that its features work");
    // Nothing failed, so there's nothing to ask the agent to fix.
    expect(html).not.toContain("Ask the agent to fix these");
  });

  it("lists build, server and browser results separately and offers to ask for a fix quoting what failed", () => {
    const r = report({
      checks: {
        server: { command: "npm run dev", state: "exited", http: 0, at: AT, freshness: "current", note: "A dependency is missing (vite): install the project's dependencies (npm install)." },
        preview: null,
        build: { command: "npm run build", exitCode: 1, passed: false, ranAt: AT, freshness: "current" },
      },
    });
    const html = renderToStaticMarkup(createElement(VerificationPanel, { ...props, run: view(r), onAskFix: () => {} }));
    for (const label of ["Production build", "Development server", "Browser inspection"]) expect(html).toContain(label);
    expect(html).toContain("Ask the agent to fix these");
    const fix = fixRequest(r)!;
    expect(fix).toContain("- Production build (npm run build): Failed (exit code 1)");
    expect(fix).toContain("- Development server (npm run dev): Didn't start: the command exited. A dependency is missing (vite)");
    expect(fix).not.toContain("Browser inspection");
  });

  it("tells the next session how the last one's checks ended", () => {
    expect(checksSummary(report())).toBe("Checks: Done, checked in a browser");
    const broken = report({
      checks: { ...report().checks!, preview: { path: "/", verdict: "problems", problems: ["Phone 390×844: the page scrolls sideways by 120px."], warnings: [], checkedAt: AT, freshness: "current" } },
    });
    expect(checksSummary(broken)).toBe("Checks: Done, with warnings. Not passing: Browser inspection: 1 problem found on / (Phone 390×844: the page scrolls sideways by 120px.)");
  });
});
