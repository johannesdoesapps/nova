/**
 * Jarvis Mode: the tool list and proposal checks, the permission rules at each autonomy level, and the mission
 * runner (approvals, rejection, stop, pause, timeouts, retries and honest summaries).
 */
import { describe, expect, it } from "vitest";
import { checkProposal, offeredTools, TOOL_NAMES, TOOLS, toolSpecs } from "@/lib/jarvis/tools";
import { decide, TRUSTED_BATCH_LIMIT, type Autonomy } from "@/lib/jarvis/permissions";
import { MissionRunner, newMission, type Mission, type RunnerDeps, type Step, type StepResult } from "@/lib/jarvis/mission";

describe("tools", () => {
  it("has no tool that deletes, runs commands, sends messages or buys", () => {
    for (const n of TOOL_NAMES) expect(n).not.toMatch(/delete|remove|trash|command|shell|exec|send|email|purchase|buy|pay/);
  });

  it("offers desktop tools only while the Desktop Agent is connected", () => {
    expect(offeredTools(false).every((n) => TOOLS[n].runner !== "desktop")).toBe(true);
    expect(offeredTools(false)).toContain("web_search");
    expect(offeredTools(false, ["web_search"])).not.toContain("web_search");
    expect(offeredTools(true)).toContain("organize_folder");
    expect(toolSpecs(offeredTools(true)).every((s) => s.parameters.type === "object" && !("$schema" in s.parameters))).toBe(true);
  });

  it("checks proposals: known, offered, valid arguments", () => {
    const offered = offeredTools(false);
    expect(checkProposal("open_url", { url: "https://example.com" }, offered)).toMatchObject({ ok: true });
    expect(checkProposal("open_url", { url: "javascript:alert(1)" }, offered)).toMatchObject({ ok: false });
    expect(checkProposal("open_url", { url: "file:///etc/passwd" }, offered)).toMatchObject({ ok: false });
    expect(checkProposal("rm_rf", {}, offered)).toMatchObject({ ok: false, error: "Unknown tool." });
    expect(checkProposal("move_file", { from: "a", to: "b" }, offered)).toMatchObject({ ok: false, error: "That tool isn't available right now." });
    expect(checkProposal("open_application", { name: "Safari; rm -rf ~" }, offeredTools(true))).toMatchObject({ ok: false });
    expect(checkProposal("rename_file", { path: "~/a.txt", new_name: "../b.txt" }, offeredTools(true))).toMatchObject({ ok: false });
    expect(checkProposal("research", { question: "Compare five AI coding tools" }, offered)).toEqual({ ok: true, tool: "research", args: { question: "Compare five AI coding tools", depth: "standard" } });
    expect(checkProposal("__proto__", {}, offered)).toMatchObject({ ok: false });
  });
});

describe("permissions", () => {
  const ctx = (autonomy: Autonomy, extra: Partial<Parameters<typeof decide>[1]> = {}) => ({ autonomy, desktopConnected: true, halted: false, ...extra });

  it("refuses everything while automation is stopped, and desktop tools without the agent", () => {
    for (const n of TOOL_NAMES) expect(decide(n, ctx(4, { halted: true })).kind).toBe("deny");
    expect(decide("list_directory", ctx(4, { desktopConnected: false })).kind).toBe("deny");
    expect(decide("open_url", ctx(4, { desktopConnected: false })).kind).toBe("allow");
  });

  it("applies each autonomy level", () => {
    const table = (n: Parameters<typeof decide>[0]) => ([1, 2, 3, 4] as Autonomy[]).map((a) => decide(n, ctx(a)).kind);
    expect(table("list_directory")).toEqual(["allow", "allow", "allow", "allow"]);
    expect(table("open_application")).toEqual(["deny", "confirm", "allow", "allow"]);
    expect(table("move_file")).toEqual(["deny", "confirm", "confirm", "allow"]);
    expect(table("look_at_screen")).toEqual(["deny", "confirm", "confirm", "allow"]);
    expect(table("research")).toEqual(["deny", "confirm", "confirm", "confirm"]);
    expect(table("remember")).toEqual(["deny", "confirm", "confirm", "confirm"]);
  });

  it("always shows batches for approval unless trusted and small", () => {
    expect(decide("organize_folder", ctx(3, { batchSize: 2 })).kind).toBe("confirm");
    expect(decide("organize_folder", ctx(4)).kind).toBe("confirm");
    expect(decide("organize_folder", ctx(4, { batchSize: TRUSTED_BATCH_LIMIT })).kind).toBe("allow");
    expect(decide("organize_folder", ctx(4, { batchSize: TRUSTED_BATCH_LIMIT + 1 })).kind).toBe("confirm");
  });
});

const ok = (summary: string): StepResult => ({ outcome: "success", summary, verified: true });

function deps(over: Partial<RunnerDeps> & { autonomy?: Autonomy } = {}): RunnerDeps & { updates: Mission[]; executed: string[] } {
  const updates: Mission[] = [];
  const executed: string[] = [];
  return {
    updates,
    executed,
    decide: (s: Step, batchSize?: number) => decide(s.tool, { autonomy: over.autonomy ?? 3, desktopConnected: true, halted: false, batchSize }),
    execute: async (s: Step) => {
      executed.push(s.tool);
      return ok(`Did ${s.tool}.`);
    },
    approve: async () => true,
    update: (m) => updates.push(m),
    ...over,
  };
}

describe("missions", () => {
  it("runs the steps in order and reports what was done", async () => {
    const d = deps();
    const m = await new MissionRunner(newMission("open things", "Open things", [{ tool: "open_application", args: { name: "Notes" } }, { tool: "list_directory", args: { path: "~/Downloads" } }]), d).run();
    expect(d.executed).toEqual(["open_application", "list_directory"]);
    expect(m.status).toBe("completed");
    expect(m.summary).toBe("Done. Did open_application. Did list_directory.");
    expect(d.updates.some((u) => u.status === "running")).toBe(true);
  });

  it("waits for approval, and a rejection runs nothing further", async () => {
    let asked: Step | null = null;
    const d = deps({
      approve: async (s) => {
        asked = s;
        return false;
      },
    });
    const m = await new MissionRunner(newMission("move", "Move", [{ tool: "move_file", args: { from: "~/a", to: "~/b" } }, { tool: "open_application", args: { name: "Notes" } }]), d).run();
    expect(asked!.status).toBe("waiting_approval");
    expect(asked!.preview?.lines[0]).toBe("Move ~/a to ~/b");
    expect(d.executed).toEqual([]);
    expect(m.status).toBe("cancelled");
    expect(m.steps.map((s) => s.status)).toEqual(["rejected", "planned"]);
    expect(m.summary).toMatch(/^Cancelled: you didn't approve a step\..*Nothing was changed/);
  });

  it("approves the exact list a batch step will apply", async () => {
    let applied: unknown = null;
    const moves = [{ from: "~/Downloads/a.pdf", to: "~/Downloads/PDFs/a.pdf" }];
    const d = deps({
      prepare: async () => ({ preview: { title: "Sort", lines: moves.map((x) => `${x.from} → ${x.to}`) }, batchSize: moves.length, data: moves }),
      execute: async (_s, _sig, prepared) => {
        applied = prepared;
        return ok("Moved 1 file; nothing was deleted.");
      },
    });
    const m = await new MissionRunner(newMission("sort", "Sort", [{ tool: "organize_folder", args: { path: "~/Downloads" } }]), d).run();
    expect(applied).toEqual(moves);
    expect(m.steps[0]!.preview!.lines).toEqual(["~/Downloads/a.pdf → ~/Downloads/PDFs/a.pdf"]);
    expect(m.status).toBe("completed");
  });

  it("stops at a denied step without running it", async () => {
    const d = deps({ autonomy: 1 });
    const m = await new MissionRunner(newMission("x", "x", [{ tool: "list_directory", args: { path: "~" } }, { tool: "move_file", args: { from: "~/a", to: "~/b" } }]), d).run();
    expect(d.executed).toEqual(["list_directory"]);
    expect(m.status).toBe("failed");
    expect(m.summary).toMatch(/^Blocked by your permission settings\. It stopped at step 2 of 2 .*Observe/);
  });

  it("reports a partial failure accurately", async () => {
    const d = deps({ execute: async (s) => (s.tool === "copy_file" ? { outcome: "failure", summary: "Something already exists at ~/b.", verified: null } : ok("Opened Notes.")) });
    const m = await new MissionRunner(newMission("x", "x", [{ tool: "open_application", args: { name: "Notes" } }, { tool: "copy_file", args: { from: "~/a", to: "~/b" } }, { tool: "system_info", args: {} }]), { ...d, decide: () => ({ kind: "allow", reason: "" }) }).run();
    expect(m.status).toBe("failed");
    expect(m.steps.map((s) => s.status)).toEqual(["completed", "failed", "planned"]);
    expect(m.summary).toBe("That didn't fully work. It stopped at step 2 of 3 (copy a file): Something already exists at ~/b. Completed before that: Opened Notes.");
  });

  it("retries a failed read once, and never a change", async () => {
    let reads = 0;
    let writes = 0;
    const flaky = deps({
      autonomy: 4,
      execute: async (s) => {
        if (s.tool === "list_directory") return ++reads === 1 ? { outcome: "failure", summary: "Connection dropped.", verified: null, retryable: true } : ok("Listed.");
        writes++;
        return { outcome: "failure", summary: "Connection dropped.", verified: null, retryable: true };
      },
    });
    const m = await new MissionRunner(newMission("x", "x", [{ tool: "list_directory", args: { path: "~" } }, { tool: "move_file", args: { from: "~/a", to: "~/b" } }]), flaky).run();
    expect(reads).toBe(2);
    expect(writes).toBe(1);
    expect(m.steps.map((s) => s.status)).toEqual(["completed", "failed"]);
  });

  it("treats a change that timed out as unknown, not done", async () => {
    const d = deps({ autonomy: 4, timeoutMs: 20, execute: () => new Promise(() => {}) });
    const m = await new MissionRunner(newMission("x", "x", [{ tool: "move_file", args: { from: "~/a", to: "~/b" } }]), d).run();
    expect(m.steps[0]!.result).toMatchObject({ outcome: "timeout", verified: null });
    expect(m.steps[0]!.result!.summary).toMatch(/may or may not have finished/);
    expect(m.status).toBe("failed");
  });

  it("stops: nothing new starts, the running step is cancelled and the mission marked interrupted", async () => {
    let release: () => void = () => {};
    const d = deps({ autonomy: 4, execute: (s) => (s.tool === "list_directory" ? new Promise((r) => (release = () => r(ok("Listed.")))) : Promise.resolve(ok("Moved."))) });
    const runner = new MissionRunner(newMission("x", "x", [{ tool: "list_directory", args: { path: "~" } }, { tool: "move_file", args: { from: "~/a", to: "~/b" } }]), d);
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 5));
    runner.stop("interrupted");
    release();
    const m = await done;
    expect(m.status).toBe("interrupted");
    expect(m.steps.map((s) => s.status)).toEqual(["cancelled", "planned"]);
    expect(m.steps[0]!.result!.summary).toMatch(/may already have taken effect/);
    expect(m.summary).toMatch(/^Stopped by the emergency stop\./);
  });

  it("stops while waiting for approval", async () => {
    const d = deps({ approve: () => new Promise(() => {}) });
    const runner = new MissionRunner(newMission("x", "x", [{ tool: "move_file", args: { from: "~/a", to: "~/b" } }]), d);
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 5));
    runner.stop();
    const m = await done;
    expect(m.status).toBe("cancelled");
    expect(m.steps[0]!.status).toBe("cancelled");
    expect(d.executed).toEqual([]);
  });

  it("pauses between steps and resumes", async () => {
    const d = deps({ autonomy: 4 });
    const runner = new MissionRunner(newMission("x", "x", [{ tool: "list_directory", args: { path: "~" } }, { tool: "system_info", args: {} }]), d);
    runner.pause();
    const done = runner.run();
    await new Promise((r) => setTimeout(r, 10));
    expect(d.executed).toEqual([]);
    runner.resume();
    const m = await done;
    expect(d.executed).toEqual(["list_directory", "system_info"]);
    expect(m.status).toBe("completed");
  });
});

describe("settings and history", async () => {
  const { parseSettings, trimHistory, matchesShortcut, shortcutConflict, shortcutLabel, DEFAULT_SETTINGS } = await import("@/lib/jarvis/store");

  it("falls back to safe defaults for anything invalid", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ autonomy: 9, mode: "god", voice: "x", speak: "yes", keepDays: 5, shortcut: { key: "" } })).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ autonomy: 1, mode: "research", keepDays: 0 })).toMatchObject({ autonomy: 1, mode: "research", keepDays: 0 });
  });

  it("keeps history within the retention period and without private content", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    const m = (id: string, days: number) => ({
      ...newMission("x", "x", [{ tool: "look_at_screen", args: { question: "?" } }]),
      id,
      createdAt: new Date(now - days * 86_400_000).toISOString(),
      steps: [{ id: "s", tool: "look_at_screen" as const, args: { question: "?" }, status: "completed" as const, result: { outcome: "success" as const, summary: "Your bank balance is…", verified: null, details: { kind: "text" as const, text: "Your bank balance is…" } } }],
    });
    const kept = trimHistory([m("new", 1), m("old", 40)], 30, now);
    expect(kept.map((x) => x.id)).toEqual(["new"]);
    expect(JSON.stringify(kept)).not.toContain("bank balance");
    expect(trimHistory([m("new", 1)], 0, now)).toEqual([]);
  });

  it("matches push-to-talk keys by their physical key, and warns about clashes", () => {
    const s = { key: "j", ctrl: false, alt: true, shift: false, meta: false };
    expect(matchesShortcut({ key: "∆", code: "KeyJ", ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }, s)).toBe(true);
    expect(matchesShortcut({ key: "j", code: "KeyJ", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, s)).toBe(false);
    expect(shortcutLabel(s, true)).toBe("⌥J");
    expect(shortcutLabel(s, false)).toBe("Alt+J");
    expect(shortcutConflict(s)).toBeNull();
    expect(shortcutConflict({ ...s, alt: false, ctrl: true, key: "w" })).toMatch(/common commands/);
    expect(shortcutConflict({ ...s, alt: false })).toMatch(/while typing/);
  });
});
