/**
 * Jarvis's own tools and skills: the calculator (exact, never evaluated as code), the skills library (ids, the user's
 * skills, the catalog the model sees), skills kept in the browser, and how a mission's results are fed back to the
 * model for the next round of the tool loop.
 */
import { describe, expect, it } from "vitest";
import { evaluate, formatNumber } from "@/lib/jarvis/calc";
import { briefSummary, newMission, stepFeedback, wantsFollowUp, type Mission, type Step } from "@/lib/jarvis/mission";
import { systemPrompt, turnRequest } from "@/lib/jarvis/planner";
import { offeredTools } from "@/lib/jarvis/tools";
import { allSkills, BUILTIN_SKILLS, findSkill, MAX_USER_SKILLS, skillCatalog, skillId, skillText } from "@/lib/jarvis/skills";
import { parseSkills } from "@/lib/jarvis/store";

const value = (e: string) => {
  const r = evaluate(e);
  if (!r.ok) throw new Error(`${e}: ${r.error}`);
  return r.value;
};
const error = (e: string) => {
  const r = evaluate(e);
  return r.ok ? null : r.error;
};

describe("calculator", () => {
  it("follows the usual precedence, with ^ binding right and tighter than unary minus's operand", () => {
    expect(value("2 + 3 * 4")).toBe(14);
    expect(value("(2 + 3) * 4")).toBe(20);
    expect(value("2 ^ 3 ^ 2")).toBe(512);
    expect(value("-2 ^ 2")).toBe(4);
    expect(value("10 - 4 - 3")).toBe(3);
    expect(value("100 / 8 / 5")).toBe(2.5);
    expect(value("17 % 5")).toBe(2);
    expect(value("6 × 7 ÷ 2")).toBe(21);
  });

  it("reads thousands separators and exponents, and keeps commas between arguments", () => {
    expect(value("1,234.5 * 2")).toBe(2469);
    expect(value("1.5e3 + 1")).toBe(1501);
    expect(value("max(1,2,3)")).toBe(3);
    expect(value("max(1, 234)")).toBe(234);
  });

  it("has the documented functions and constants", () => {
    expect(value("sqrt(144)")).toBe(12);
    expect(value("round(2 / 3, 2)")).toBe(0.67);
    expect(value("floor(2.7) + ceil(2.1) + abs(-1)")).toBe(6);
    expect(value("log(1000)")).toBe(3);
    expect(value("ln(e)")).toBe(1);
    expect(value("cos(pi)")).toBe(-1);
    expect(value("PI")).toBe(Math.PI);
  });

  it("refuses anything that isn't arithmetic, with a reason", () => {
    expect(error("1 / 0")).toBe("Division by zero.");
    expect(error("5 % 0")).toBe("Division by zero.");
    expect(error("constructor")).toBe('Unknown name "constructor".');
    expect(error("toString(1)")).toBe('Unknown name "tostring".');
    expect(error("process.exit(1)")).toMatch(/Unexpected|Unknown/);
    expect(error("alert`1`")).toMatch(/Unexpected|Unknown/);
    expect(error("sqrt(1, 2)")).toBe("sqrt takes 1 value.");
    expect(error("(1 + 2")).toBe('Expected ")".');
    expect(error("1 2")).toBe('Unexpected "2".');
    expect(error("")).toBe("Empty expression.");
    expect(error("1+".repeat(200))).toMatch(/too long/);
    expect(error(`${"(".repeat(70)}1${")".repeat(70)}`)).toMatch(/nested too deeply/);
    expect(error("10 ^ 400")).toMatch(/finite/);
  });

  it("formats results without floating-point noise", () => {
    expect(evaluate("0.1 + 0.2")).toMatchObject({ ok: true, text: "0.3" });
    expect(formatNumber(2024)).toBe("2024");
    expect(formatNumber(1234567.891)).toBe("1,234,567.891");
    expect(formatNumber(-0)).toBe("0");
    expect(formatNumber(1e21)).toBe("1e+21");
  });
});

describe("skills", () => {
  const mine = { id: "weekly-report", name: "Weekly report", description: "When I ask for my weekly report.", instructions: "1. Search the news.\n2. Summarise it." };

  it("makes ids from names that never clash with built-ins or each other", () => {
    expect(skillId("Weekly Report!")).toBe("weekly-report");
    expect(skillId("Café menu")).toBe("cafe-menu");
    expect(skillId("Weekly report", ["weekly-report"])).toBe("weekly-report-2");
    expect(skillId("Research brief")).toBe("my-research-brief");
    expect(skillId("Research brief", ["my-research-brief"])).toBe("my-research-brief-2");
    expect(skillId("!!!")).toBe("skill");
    expect(skillId("x".repeat(80))).toHaveLength(34);
  });

  it("adds the user's valid skills after the built-ins, never replacing one, up to the limit", () => {
    const all = allSkills([mine, { ...mine, name: "Duplicate" }, { ...mine, id: "research-brief" }, { id: "BAD", name: "x" }, null]);
    expect(all.map((s) => s.id)).toEqual([...BUILTIN_SKILLS.map((s) => s.id), "weekly-report"]);
    expect(all.find((s) => s.id === "research-brief")!.builtin).toBe(true);
    const many = Array.from({ length: 30 }, (_, i) => ({ ...mine, id: `s-${i}` }));
    expect(allSkills(many)).toHaveLength(BUILTIN_SKILLS.length + MAX_USER_SKILLS);
  });

  it("finds a skill by id or by name, loosely", () => {
    const all = allSkills([mine]);
    expect(findSkill("weekly-report", all)?.name).toBe("Weekly report");
    expect(findSkill("Weekly Report", all)?.id).toBe("weekly-report");
    expect(findSkill("quick maths", all)?.id).toBe("quick-math");
    expect(findSkill("nope", all)).toBeNull();
  });

  it("shows the model one line per skill, desktop skills only when connected", () => {
    const off = skillCatalog(allSkills([mine]), false);
    expect(off).toContain("- weekly-report: Weekly report. When I ask for my weekly report.");
    expect(off).not.toContain("tidy-folder");
    expect(off).not.toContain("Search the news");
    expect(skillCatalog(BUILTIN_SKILLS, true)).toContain("- tidy-folder: Tidy a folder.");
    expect(skillText(allSkills([mine]).at(-1)!)).toBe('Skill "Weekly report" (written by the user). Follow these steps for this task:\n1. Search the news.\n2. Summarise it.');
  });

  it("built-in skills only name tools that exist", async () => {
    const { TOOL_NAMES } = await import("@/lib/jarvis/tools");
    for (const s of BUILTIN_SKILLS) {
      const named = s.instructions.match(/\b[a-z]+_[a-z_]+\b/g) ?? [];
      for (const n of named) expect(TOOL_NAMES, `${s.id} mentions ${n}`).toContain(n);
    }
  });

  it("keeps only valid skills from browser storage", () => {
    expect(parseSkills(null)).toEqual([]);
    expect(parseSkills("nope")).toEqual([]);
    expect(parseSkills([mine, { ...mine }, { ...mine, id: "quick-math" }, { ...mine, id: "ok-2", instructions: "short" }])).toEqual([mine]);
  });
});

describe("feeding a mission's results back to the model", () => {
  const mission = (steps: Partial<Step>[], status: Mission["status"] = "completed"): Mission => {
    const m = newMission("x", "x", steps.map((s) => ({ tool: s.tool ?? "list_directory", args: {} })));
    return { ...m, status, steps: m.steps.map((s, i) => ({ ...s, ...steps[i] })) };
  };

  it("continues only when a finished step found something", () => {
    const listed = { tool: "list_directory" as const, status: "completed" as const, result: { outcome: "success" as const, summary: "Listed 1 item.", verified: true, details: { kind: "files" as const, items: [{ name: "a.pdf", kind: "file" as const }] } } };
    const opened = { tool: "open_url" as const, status: "completed" as const, result: { outcome: "success" as const, summary: "Opened a.com.", verified: null } };
    expect(wantsFollowUp(mission([listed]))).toBe(true);
    expect(wantsFollowUp(mission([opened]))).toBe(false);
    expect(wantsFollowUp(mission([listed], "cancelled"))).toBe(false);
    expect(wantsFollowUp(mission([listed], "interrupted"))).toBe(false);
    expect(wantsFollowUp(mission([{ ...listed, status: "failed" }], "failed"))).toBe(false);
  });

  it("describes each step's result in plain text, clipped", () => {
    const [files, info, text, declined, denied] = mission([
      { status: "completed", result: { outcome: "success", summary: "Listed 2 items.", verified: true, details: { kind: "files", folder: "~/Downloads", items: [{ name: "a.pdf", kind: "file", size: 1200 }, { name: "pics", kind: "folder" }], truncated: true } } },
      { status: "completed", result: { outcome: "partial", summary: "Checked the computer.", verified: null, details: { kind: "info", rows: [{ label: "Memory", value: "16 GB" }] } } },
      { tool: "read_clipboard", status: "completed", result: { outcome: "success", summary: "Read the clipboard.", verified: null, details: { kind: "text", text: "x".repeat(5000) } } },
      { status: "rejected" },
      { status: "denied", decision: { kind: "deny", reason: "Autonomy is set to Observe." } },
    ]).steps;
    expect(stepFeedback(files!)).toEqual({ ok: true, text: "Listed 2 items.\nFolder: ~/Downloads\na.pdf (1200 bytes)\n[folder] pics\n(list truncated)" });
    expect(stepFeedback(info!)).toEqual({ ok: true, text: "Checked the computer.\nMemory: 16 GB" });
    const clipped = stepFeedback(text!);
    expect(clipped.text).toHaveLength(3501);
    expect(clipped.text.endsWith("…")).toBe(true);
    expect(stepFeedback(declined!)).toEqual({ ok: false, text: "The user declined this step." });
    expect(stepFeedback(denied!)).toEqual({ ok: false, text: "Not allowed: Autonomy is set to Observe." });
    const failed = mission([{ status: "failed", result: { outcome: "failure", summary: "The folder isn't allowed.", verified: null } }]).steps[0]!;
    expect(stepFeedback(failed)).toEqual({ ok: false, text: "The folder isn't allowed." });
  });
});

describe("keeping Jarvis brief", () => {
  const mk = (steps: Partial<Step>[], status: Mission["status"]): Mission => {
    const m = newMission("x", "x", steps.map((st) => ({ tool: st.tool ?? "open_url", args: {} })));
    return { ...m, status, steps: m.steps.map((st, i) => ({ ...st, ...steps[i] })) };
  };
  const did = (summary: string) => ({ status: "completed" as const, result: { outcome: "success" as const, summary, verified: true } });

  it("says a mission's outcome in a sentence or two", () => {
    expect(briefSummary(mk([did("Opened a.com.")], "completed"))).toBe("Done. Opened a.com.");
    expect(briefSummary(mk([did("Made the folder."), did("Moved 3 files."), did("Opened it.")], "completed"))).toBe("Done: 3 steps. Opened it.");
    expect(briefSummary(mk([did("Opened a.com."), { status: "cancelled" }], "cancelled"))).toBe("Stopped.");
    expect(briefSummary(mk([{ status: "rejected" }], "cancelled"))).toBe("Cancelled: you didn't approve a step.");
    expect(briefSummary(mk([did("Listed it."), { status: "failed", result: { outcome: "failure", summary: "The folder isn't allowed.", verified: null } }], "failed"))).toBe(
      "That didn't fully work. The folder isn't allowed. 1 step was done first.",
    );
    expect(briefSummary(mk([{ status: "denied", decision: { kind: "deny", reason: "Autonomy is set to Observe." } }], "failed"))).toBe("Blocked by your permission settings. Autonomy is set to Observe.");
    expect(briefSummary(mk([did("x")], "interrupted"))).toBe("Stopped by the emergency stop.");
  });

  it("tells the model to be brief and not to narrate its steps", () => {
    const p = systemPrompt(turnRequest.parse({ message: "x" }), offeredTools(false), false);
    expect(p).toMatch(/Be brief: this is spoken aloud\. Lead with the answer\./);
    expect(p).toMatch(/say a few words at most/);
    expect(p).toMatch(/one or two short sentences, then act/);
    expect(p).not.toMatch(/say briefly what you are about to do/);
  });
});
