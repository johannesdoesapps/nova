/**
 * Orbis Code's plain-English view of a session: stages appear only for
 * activity that actually happened, in order, with honest summaries; the
 * permission modes map to the run's real options (enforced by the server);
 * and every first-use example is a real task.
 */
import { describe, expect, it } from "vitest";
import { EXAMPLES, groupStages, MODES, modeOf, stageSummary } from "@/components/code/agent-panel";
import type { AgentEvent } from "@/lib/code/agent/types";

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
