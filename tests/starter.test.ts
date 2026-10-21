import { describe, expect, it } from "vitest";
import { CHAT_MODES } from "@/lib/ai/modes";
import { exampleAction, readPendingStart, STARTER_TASKS, starterModelId, starterTask, PENDING_START_TTL_MS } from "@/lib/starter";

const env = { search: true, autoOn: true };

describe("the first-run starter", () => {
  it("offers the six tasks, each with a reason and three usable examples", () => {
    expect(STARTER_TASKS.map((t) => t.id)).toEqual(["research", "writing", "coding", "planning", "compare", "chat"]);
    for (const t of STARTER_TASKS) {
      expect(t.why.length).toBeGreaterThan(40);
      expect(t.examples).toHaveLength(3);
      if (t.setup) expect(CHAT_MODES).toContain(t.setup.mode);
      for (const ex of t.examples) {
        if (ex.action === "link") expect(ex.href).toMatch(/^\/[a-z]/);
        else expect(ex.prompt?.trim().length).toBeGreaterThan(5);
      }
    }
  });

  it("suggests Auto with the right routing preference", () => {
    expect(starterModelId(starterTask("research")!)).toBe("auto:research");
    expect(starterModelId(starterTask("coding")!)).toBe("auto:coding");
    expect(starterModelId(starterTask("writing")!)).toBe("auto");
    expect(starterModelId(starterTask("compare")!)).toBeNull();
  });

  it("examples start a chat with the task's setup, fill the box, or open a page", () => {
    const research = starterTask("research")!;
    expect(exampleAction(research, research.examples[0]!, env)).toEqual({ kind: "send", prompt: research.examples[0]!.prompt, mode: "research", web: true, modelId: "auto:research" });
    // Web sources only when search is set up; the model stays the user's when Auto is off.
    expect(exampleAction(research, research.examples[0]!, { search: false, autoOn: false })).toEqual({ kind: "send", prompt: research.examples[0]!.prompt, mode: "research", web: false });
    expect(exampleAction(research, research.examples[2]!, env)).toMatchObject({ kind: "draft", attach: true });
    const writing = starterTask("writing")!;
    expect(exampleAction(writing, writing.examples[2]!, env)).toMatchObject({ kind: "draft", mode: "critic" });
    const compare = starterTask("compare")!;
    expect(exampleAction(compare, compare.examples[0]!, env)).toEqual({ kind: "link", href: compare.examples[0]!.href });
    expect(compare.examples[0]!.href).toMatch(/^\/arena\?q=/);
  });

  it("“Plan my day” is planned from the day on Home, and a draft elsewhere", () => {
    const planning = starterTask("planning")!;
    const plan = planning.examples[0]!;
    expect(exampleAction(planning, plan, { ...env, home: true })).toEqual({ kind: "send", prompt: "", mode: "analyst" });
    expect(exampleAction(planning, plan, env)).toMatchObject({ kind: "draft", prompt: plan.prompt });
  });

  it("a request made before signing up is kept for an hour, and only if it's sound", () => {
    const now = 1_000_000_000;
    const ok = JSON.stringify({ prompt: "Plan my week", task: "planning", at: now - 1000 });
    expect(readPendingStart(ok, now)).toEqual({ prompt: "Plan my week", task: "planning", at: now - 1000 });
    expect(readPendingStart(JSON.stringify({ prompt: "x", task: "nope", at: now }), now)?.task).toBeNull();
    expect(readPendingStart(JSON.stringify({ prompt: "old", task: null, at: now - PENDING_START_TTL_MS - 1 }), now)).toBeNull();
    expect(readPendingStart(JSON.stringify({ prompt: "  ", at: now }), now)).toBeNull();
    expect(readPendingStart("{bad json", now)).toBeNull();
    expect(readPendingStart(null, now)).toBeNull();
  });
});
