/**
 * Orbis Code's plain-English view of a session: stages appear only for
 * activity that actually happened, in order, with honest summaries; the
 * permission modes map to the run's real options (enforced by the server);
 * and every first-use example is a real task.
 */
import { describe, expect, it, vi } from "vitest";
import { EXAMPLES, groupStages, MODES, modeOf, stageSummary, WEB_EXAMPLES } from "@/components/code/agent-panel";
import { assessReport, checklistOf } from "@/lib/code/agent/verdict";
import { siteName, SITE_EXAMPLES } from "@/components/code/projects-view";
import type { AgentEvent, RunReport } from "@/lib/code/agent/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/code" }));

let seq = 0;
const ev = (kind: AgentEvent["kind"], title: string, detail: Record<string, unknown> | null = null): AgentEvent => ({ id: `e${++seq}`, seq, kind, title, detail, createdAt: "" });

describe("progress stages", () => {
  it("follow the real activity, in order, with the agent's notes attached to what follows them", () => {
    const events = [
      ev("status", "Started with Claude Haiku 5.5"),
      ev("note", "I'll read the project first."),
      ev("inspect", "Inspected the project"),
      ev("inspect", "Read src/calc.js, test/calc.test.js"),
      ev("plan", "Fix add() to add."),
      ev("approval", "You approved the plan"),
      ev("edit", "Edited src/calc.js (+1 −1)", { path: "src/calc.js" }),
      ev("command", "Tests passed (3 passed): npm test", { command: "npm test", exitCode: 0, tests: { verdict: "passed" } }),
      ev("summary", "Finished", { summary: "Fixed." }),
    ];
    const blocks = groupStages(events);
    expect(blocks.map((b) => b.stage)).toEqual(["understand", "explore", "plan", "edit", "check", "review"]);
    expect(blocks[1]!.notes.map((n) => n.title)).toEqual(["I'll read the project first."]);
    expect(blocks[2]!.events.map((e) => e.kind)).toEqual(["plan", "approval"]);
    expect(stageSummary(blocks[1]!)).toBe("read 2 files");
    expect(stageSummary(blocks[3]!)).toBe("1 file changed");
    expect(stageSummary(blocks[4]!)).toBe("Tests passed (3 passed): npm test");
  });

  it("count the agent checking its own diff as reviewing, not exploring", () => {
    const blocks = groupStages([ev("command", "Tests passed: npm test", { command: "npm test", exitCode: 0 }), ev("inspect", "Looked at the diff (1 file)"), ev("summary", "Finished")]);
    expect(blocks.map((b) => b.stage)).toEqual(["check", "review"]);
    expect(stageSummary(blocks[1]!)).toBe("Finished");
    expect(stageSummary(groupStages([ev("inspect", "Checked the run's changes")])[0]!)).toBe("Checked its changes");
    expect(stageSummary(groupStages([ev("inspect", "Inspected the project")])[0]!)).toBe("Inspected the project");
  });

  it("show only what happened: no edit or check stage for a read-only answer", () => {
    const blocks = groupStages([ev("status", "Started with GPT"), ev("inspect", "Inspected the project"), ev("summary", "Finished")]);
    expect(blocks.map((b) => b.stage)).toEqual(["understand", "explore", "review"]);
  });

  it("report blocked commands and failures as such, never as success", () => {
    const blocks = groupStages([
      ev("command", "Blocked: git push", { command: "git push", blocked: "pushes" }),
      ev("command", "Tests failed (1 failed): npm test", { command: "npm test", exitCode: 1, tests: { verdict: "failed" } }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(stageSummary(blocks[0]!)).toBe("Tests failed (1 failed): npm test");
    expect(stageSummary(groupStages([ev("command", "Blocked: rm -rf /", { command: "rm -rf /", blocked: "x" })])[0]!)).toBe("1 blocked");
  });

  it("start a new stage when the agent goes back to an earlier kind of work", () => {
    const blocks = groupStages([
      ev("edit", "Edited a.js", { path: "a.js" }),
      ev("command", "Tests failed: npm test", { command: "npm test", exitCode: 1 }),
      ev("edit", "Edited a.js", { path: "a.js" }),
      ev("command", "Tests passed: npm test", { command: "npm test", exitCode: 0 }),
    ]);
    expect(blocks.map((b) => b.stage)).toEqual(["edit", "check", "edit", "check"]);
  });
});

describe("permission modes", () => {
  it("are presets of the run's real options, recognised back from a run", () => {
    expect(MODES.map((m) => m.id)).toEqual(["plan", "review", "auto", "read"]);
    for (const m of MODES) expect(modeOf(m.options)?.id).toBe(m.id);
    expect(MODES.find((m) => m.id === "read")!.options).toMatchObject({ readOnly: true, commands: "off" });
    expect(modeOf({ approvePlans: true, reviewEdits: false, commands: "off", readOnly: false })).toBeNull();
  });

  it("explain what each allows in plain words", () => {
    for (const m of MODES) expect(m.detail.length).toBeGreaterThan(40);
  });
});

describe("first-use examples", () => {
  it("are real tasks; the explanation runs read-only and the open-ended one asks for details", () => {
    expect(EXAMPLES.map((e) => e.label)).toEqual(["Explain this project to me", "Find and fix a bug", "Run the tests and fix failures", "Improve this page's design", "Build a new feature"]);
    expect(EXAMPLES.find((e) => e.label.startsWith("Explain"))).toMatchObject({ mode: "read", start: true });
    expect(EXAMPLES.find((e) => e.label === "Build a new feature")).toMatchObject({ start: false });
    for (const e of EXAMPLES.filter((x) => x.start)) expect(e.task.length).toBeGreaterThan(30);
  });
});

describe("website building", () => {
  it("shows starting and checking the live preview as its own stage, with the latest check as its summary", () => {
    const blocks = groupStages([
      ev("edit", "Created index.html (220 lines)", { path: "index.html" }),
      ev("status", "Set the project's Run command to python3 -m http.server 3000", { runCommand: "python3 -m http.server 3000" }),
      ev("command", "Started the preview: python3 -m http.server 3000", { command: "python3 -m http.server 3000", preview: true, state: "running", exitCode: null }),
      ev("inspect", "Screenshot: phone, first screen", { screenshot: "QQ", view: "phone" }),
      ev("inspect", "Checked / in a browser: 1 problem found", { preview: true, verdict: "problems", problems: ["Phone: scrolls sideways"] }),
      ev("edit", "Edited styles.css (+3 −1)", { path: "styles.css" }),
      ev("inspect", "Checked / in a browser (desktop and phone): no problems found", { preview: true, verdict: "passed", problems: [] }),
    ]);
    expect(blocks.map((b) => b.stage)).toEqual(["edit", "preview", "edit", "preview"]);
    expect(stageSummary(blocks[1]!)).toBe("Checked / in a browser: 1 problem found");
    expect(stageSummary(blocks[3]!)).toBe("Checked / in a browser (desktop and phone): no problems found");
  });

  it("reports each website check as it really ended, separately from tests", () => {
    const report = (checks: RunReport["checks"], tests: RunReport["tests"] = null): RunReport =>
      ({
        outcome: "completed",
        summary: null,
        unresolved: [],
        files: [],
        commands: [],
        tests,
        verification: tests ? "passed" : "not_run",
        checks,
        usage: {} as never,
        checkpoints: 0,
        createdAt: "",
      }) as RunReport;
    const passed = {
      server: { command: "python3 -m http.server 3000", state: "running" as const, http: 200, at: "", freshness: "current" as const },
      preview: { path: "/", verdict: "passed" as const, problems: [], warnings: [], checkedAt: "", freshness: "current" as const },
      build: null,
    };
    // Each check on its own line as it really ended; the server is a process check, the browser an inspection.
    expect(checklistOf(report(passed)).map((c) => [c.id, c.status, c.kind])).toEqual([
      ["tests", "not_run", "automated"],
      ["build", "not_run", "automated"],
      ["server", "passed", "process"],
      ["browser", "passed", "inspection"],
    ]);
    expect(assessReport(report(passed)).state).toBe("verified");
    const stale = { ...passed, preview: { ...passed.preview, freshness: "stale" as const } };
    expect(checklistOf(report(stale)).find((c) => c.id === "browser")).toMatchObject({ status: "stale", summary: "Checked before the last change" });
    expect(assessReport(report(stale)).state).toBe("warnings");
    const broken = {
      ...passed,
      preview: { ...passed.preview, verdict: "problems" as const, problems: ["JavaScript error: x is not defined"] },
      build: { command: "npm run build", exitCode: 1, passed: false, ranAt: "", freshness: "current" as const },
    };
    const items = checklistOf(report(broken));
    expect(items.find((c) => c.id === "browser")).toMatchObject({ status: "failed", summary: "1 problem found on /", details: ["JavaScript error: x is not defined"] });
    expect(items.find((c) => c.id === "build")).toMatchObject({ status: "failed", summary: "Failed (exit code 1)" });
    expect(assessReport(report(broken)).state).toBe("warnings");
    // No checks at all: not verified.
    expect(assessReport(report(undefined)).state).toBe("unverified");
  });

  it("names a new website project from its request", () => {
    expect(siteName("Build a modern SaaS landing page for an AI productivity platform called Nova. Include a navigation bar")).toBe("Website: Nova");
    expect(siteName("Create an online portfolio for a designer")).toBe("Online portfolio for a designer");
    expect(siteName("")).toBe("New website");
  });

  it("offers website examples that are full, real requests", () => {
    expect(SITE_EXAMPLES.map((x) => x.label)).toEqual(["Premium SaaS landing page", "Designer portfolio", "E-commerce storefront", "Restaurant with reservations", "Dashboard with charts"]);
    for (const x of SITE_EXAMPLES) expect(x.prompt.length).toBeGreaterThan(80);
    expect(WEB_EXAMPLES.filter((x) => x.start).every((x) => x.task.length > 30)).toBe(true);
  });
});
