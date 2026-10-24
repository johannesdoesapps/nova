/**
 * Fixes from the UI audit that have logic behind them: the Free plan isn't shown as having used an
 * advanced-model allowance it never had, next steps don't point the wrong way, and markup that screen
 * readers depend on (landmarks, the skip link, the agent's status, sidebar headings) stays in place.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { budgetState } from "@/lib/budget";
import { nextActions } from "@/lib/code/agent/verdict";
import type { RunReport } from "@/lib/code/agent/types";

const src = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("monthly budget state", () => {
  it("a plan with no advanced-model share (Free) isn't 'economy' before anything is spent", () => {
    expect(budgetState(0, 0.1, 0, 0)).toBe("ok");
    expect(budgetState(0.05, 0.1, 0, 0)).toBe("ok");
    expect(budgetState(0.1, 0.1, 0, 0)).toBe("exhausted");
  });

  it("a plan with an advanced share is 'economy' once that share is used, 'exhausted' once all of it is", () => {
    expect(budgetState(1, 3.59, 0.5, 2.15)).toBe("ok");
    expect(budgetState(2.2, 3.59, 2.15, 2.15)).toBe("economy");
    expect(budgetState(3.59, 3.59, 2.15, 2.15)).toBe("exhausted");
    expect(budgetState(5, null, 5, null)).toBe("ok");
  });
});

describe("next steps after a task", () => {
  const report: RunReport = {
    outcome: "completed",
    summary: "Done.",
    unresolved: ["complete() fails when ids skip numbers"],
    files: [{ path: "src/todo.js", change: "modified", added: 2, removed: 1 }],
    commands: [],
    tests: {
      command: "node --test",
      framework: "node",
      verdict: "failed",
      exitCode: 1,
      passed: 3,
      failed: 1,
      skipped: 0,
      failures: ["complete"],
      durationMs: 300,
      ranAt: "2026-10-24T10:05:00Z",
      afterLastEdit: true,
    },
    verification: "failed",
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, modelCalls: 1, models: [], steps: 1, activeMs: 1 },
    checkpoints: 0,
    createdAt: "2026-10-24T10:05:00Z",
    testSetup: "node --test",
  };

  it("name the section to look at instead of saying 'below' (it's above them on the page)", () => {
    const steps = nextActions(report, "warnings").join(" ");
    expect(steps).toContain("under Checks");
    expect(steps).toContain("under Still open");
    expect(steps).not.toMatch(/\bbelow\b/);
  });
});

describe("markup that assistive technology relies on", () => {
  it("the app has a skip link to its main region", () => {
    const frame = src("src/components/studio/frame.tsx");
    expect(frame).toContain('href="#studio-main"');
    expect(frame).toContain('<main id="studio-main"');
  });

  it("sign-in, password reset and the 404 page have a main landmark", () => {
    for (const f of ["src/app/login/page.tsx", "src/app/reset-password/page.tsx", "src/app/not-found.tsx"]) expect(src(f)).toMatch(/<main[\s>]/);
  });

  it("the agent's activity isn't one big live region; its state is announced on its own", () => {
    const panel = src("src/components/code/agent-panel.tsx");
    expect(panel).not.toContain('overflow-y-auto" aria-live="polite"');
    expect(panel).toMatch(/role="status" className="sr-only">\s*Task: \{TASK_STATE_INFO/);
  });

  it("sidebar group labels are h2s, so pages don't skip heading levels", () => {
    const sidebar = src("src/components/studio/sidebar.tsx");
    expect(sidebar).not.toMatch(/<h3 className="px-3 pb-1/);
  });

  it("the Code composer doesn't promise a fixed unit cost per step", () => {
    expect(src("src/components/code/agent-panel.tsx")).not.toMatch(/Each step uses \{per\}/);
  });
});

describe("headings inside a reply", () => {
  it("a reply's top heading level is announced as level 2, keeping its look", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Markdown } = await import("@/components/common/markdown");
    const only = renderToStaticMarkup(createElement(Markdown, { text: "## Plan\n\ntext\n\n### Step one\n\nmore" }));
    expect(only).toContain('<h3 aria-level="2">Plan</h3>');
    expect(only).toContain('<h4 aria-level="3">Step one</h4>');
    const full = renderToStaticMarkup(createElement(Markdown, { text: "# Title\n\n## Part\n\ntext" }));
    expect(full).toContain("<h2>Title</h2>");
    expect(full).toContain("<h3>Part</h3>");
  });
});
