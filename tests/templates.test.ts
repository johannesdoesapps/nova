/**
 * Templates: the library's structure, filling in instructions, input checks,
 * hand-offs, estimates, the step runner (progress events, earlier results,
 * search fallbacks, errors) and saved-prompt editing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { checkInputs, codeHandoff, defaultInputs, findTemplate, handoffHref, renderPrompt, stepInputChars, TEMPLATES } from "@/lib/templates/registry";
import { effectPath, effectRequest, effectUrl, findEffect, WEBSITE_EFFECTS } from "@/lib/templates/website-effects";
import { latestWebsite, openInCode, takeCodePrefill } from "@/lib/code/handoff";
import { templateEstimate } from "@/lib/templates/estimate";
import { templateStepRequest } from "@/lib/templates/schema";
import { patchPrompt } from "@/components/studio/prefs";

const env = vi.hoisted(() => ({
  searchKey: undefined as string | undefined,
  searchProvider: "tavily",
  provider: "anthropic",
  streamed: [] as unknown[],
  searchFails: false,
  webLeft: 5 as number | null,
  recorded: [] as Record<string, unknown>[],
  tracked: [] as [string, Record<string, unknown>][],
  streamFails: false,
}));
vi.mock("@/lib/analytics/server", () => ({ trackEvent: (_a: unknown, event: string, props: Record<string, unknown>) => env.tracked.push([event, props]) }));

vi.mock("@/lib/auth", () => ({ requireUserIfConfigured: async () => ({ mode: "authenticated", user: { id: "u1" }, supabase: {} }) }));
vi.mock("@/lib/usage", () => ({
  planLimits: async () => ({ maxOutputTokens: 8000, historyChars: 1000, tiers: ["standard"], webSearchesLeft: env.webLeft }),
  shouldSaveAllowance: async () => false,
  enforceLimits: async () => ({}),
  recordRunLater: (_a: unknown, run: Record<string, unknown>) => env.recorded.push(run),
}));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ searchKey: env.searchKey, searchProvider: env.searchProvider }) }));
vi.mock("@/lib/search/web", () => ({
  webSearch: async () => {
    if (env.searchFails) throw new Error("boom");
    return { sources: [{ index: 1, url: "https://a.org", title: "A", snippet: "Snippet A", domain: "a.org", publishedAt: null }] };
  },
}));
vi.mock("@/lib/ai", () => ({
  withTimeout: (_ms: number, s?: AbortSignal) => s ?? new AbortController().signal,
  resolveModelChoice: async (requested: string) => ({
    model: { id: "m1", displayName: "Model One", provider: env.provider, inputPrice: 1, outputPrice: 2 },
    routing: { auto: true, mode: requested, reason: "test" },
  }),
  getProvider: () => ({
    async *stream(req: { messages: { role: string; content: string }[] }) {
      env.streamed.push(req);
      yield { type: "delta", text: "Hello " };
      if (env.streamFails) throw new Error("provider down");
      yield { type: "delta", text: "world" };
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20, estimated: false } };
    },
  }),
}));

describe("the library", () => {
  it("has the starting workflows, each complete", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      "research-topic",
      "compare-competitors",
      "summarise-document",
      "write-article",
      "debug-code",
      "review-code",
      "build-website",
      "add-website-effect",
      "weekly-plan",
      "plan-project",
      "compare-responses",
      "review-claims",
    ]);
    for (const t of TEMPLATES) {
      expect(t.name && t.description && t.outcome && t.suggested.why).toBeTruthy();
      expect(t.inputs.some((f) => f.required)).toBe(true);
      expect(!!t.steps !== !!t.handoff).toBe(true);
      expect(new Set(t.inputs.map((f) => f.id)).size).toBe(t.inputs.length);
    }
  });

  it("only refers to its own inputs and to earlier steps", () => {
    for (const t of TEMPLATES) {
      const ids = new Set(t.inputs.map((f) => f.id));
      (t.steps ?? []).forEach((s, i) => {
        const earlier = new Set(t.steps!.slice(0, i).map((x) => x.id));
        for (const [, key] of `${s.prompt} ${s.searchQuery ?? ""}`.matchAll(/\{\{[?!/]?([\w.]+)\}\}/g)) {
          if (key!.startsWith("steps.")) expect(earlier.has(key!.slice(6)), `${t.id}/${s.id} uses ${key}`).toBe(true);
          else expect(ids.has(key!), `${t.id}/${s.id} uses ${key}`).toBe(true);
        }
        if (s.web) expect(s.searchQuery).toBeTruthy();
      });
    }
  });
});

describe("filling in instructions", () => {
  it("inserts inputs and earlier results, and keeps optional passages only when filled in", () => {
    const tpl = "Topic: {{topic}}\n{{?purpose}}For: {{purpose}}\n{{/purpose}}{{!purpose}}No purpose given.{{/purpose}}\n\nBrief: {{steps.brief}}";
    expect(renderPrompt(tpl, { topic: "Heat pumps", purpose: "a decision" }, { brief: "B" })).toBe("Topic: Heat pumps\nFor: a decision\n\nBrief: B");
    expect(renderPrompt(tpl, { topic: "Heat pumps", purpose: "  " }, { brief: "B" })).toBe("Topic: Heat pumps\nNo purpose given.\n\nBrief: B");
    expect(renderPrompt("{{unknown}}x", {})).toBe("x");
  });

  it("checks required fields, lengths and options", () => {
    const t = findTemplate("summarise-document")!;
    expect(checkInputs(t, {})).toMatchObject({ document: "Document is needed." });
    expect(checkInputs(t, { ...defaultInputs(t), document: "Text" })).toEqual({});
    expect(checkInputs(t, { ...defaultInputs(t), document: "Text", audience: "Aliens" }).audience).toMatch(/Choose one/);
    expect(checkInputs(t, { ...defaultInputs(t), document: "x".repeat(40_001) }).document).toMatch(/too long/);
  });

  it("hands off to the tool that already does the job", () => {
    expect(handoffHref(findTemplate("plan-project")!, { goal: "Launch the site", deadline: "March" })).toBe(`/missions?goal=${encodeURIComponent("Launch the site\nDeadline: March.")}`);
    expect(handoffHref(findTemplate("compare-responses")!, { prompt: "What is RAG?" })).toBe("/arena?q=What%20is%20RAG%3F");
    expect(handoffHref(findTemplate("review-claims")!, { text: "x" })).toBe("/verify");
    expect(handoffHref(findTemplate("debug-code")!, {})).toBeNull();
    expect(handoffHref(findTemplate("build-website")!, { idea: "x" })).toBe("/code");
    expect(handoffHref(findTemplate("add-website-effect")!, { effect: "Gooey menu" })).toBe("/code");
  });

  it("builds a website from a prompt: the description and details go to a new website project in Code", () => {
    const t = findTemplate("build-website")!;
    expect(checkInputs(t, {})).toMatchObject({ idea: "Describe your website is needed." });
    expect(codeHandoff(t, { idea: "  A site for my bakery  ", style: "warm" })).toEqual({
      request: "A site for my bakery",
      details: { purpose: "", audience: "", style: "warm", sections: "" },
      target: "new:website",
    });
    expect(codeHandoff(findTemplate("plan-project")!, { goal: "x" })).toBeNull();
  });

  it("adds an effect: a short request pointing at the effect's full instructions, for the latest website", () => {
    const t = findTemplate("add-website-effect")!;
    expect(t.inputs.find((f) => f.id === "effect")!.options).toEqual(WEBSITE_EFFECTS.map((e) => e.name));
    expect(checkInputs(t, { effect: "Sparkles" }).effect).toMatch(/Choose one/);
    const h = codeHandoff(t, { effect: "Animated pricing section", where: "below the hero", notes: "Basic $9, Pro $19" })!;
    expect(h).toMatchObject({ target: "latest-website", effect: "pricing-section" });
    expect(h.request).toContain("orbis-effects/pricing-section.md");
    expect(h.request).toContain("Where to put it: below the hero.");
    expect(h.request).toContain("Basic $9, Pro $19");
    expect(h.request).toMatch(/delete orbis-effects\/pricing-section\.md/);
    expect(t.inputLink!.href("Gooey menu")).toBe("/template-effects/gooey-menu.md");
    expect(t.inputLink!.href("Nope")).toBeNull();
  });

  it("keeps every effect request within the agent's 8,000-character limit", () => {
    for (const e of WEBSITE_EFFECTS) expect(effectRequest(e, "w".repeat(5000), "n".repeat(5000)).length).toBeLessThanOrEqual(8000);
  });

  it("ships each effect's instructions with the original prompt", () => {
    const original: Record<string, string> = {
      "image-generation-loader": "npm install img-fx three",
      "voice-glow": "npm install voice-glow",
      "gooey-menu": "npm install liquid-gooey",
      "pricing-section": "export function PricingSection({",
      "theme-toggle": "export const AnimatedThemeToggler = ({ className }: AnimatedThemeTogglerProps) => {",
    };
    for (const e of WEBSITE_EFFECTS) {
      const md = readFileSync(`public${effectUrl(e.id)}`, "utf8");
      expect(md).toContain(`# Add an effect: ${e.name}`);
      expect(md).toContain("## The original prompt");
      expect(md).toContain(original[e.id]);
      expect(md.split("You are given a task").length, `${e.id} holds one copy of the prompt`).toBeLessThanOrEqual(2);
      expect(Buffer.byteLength(md)).toBeLessThan(200 * 1024);
    }
    expect(findEffect("theme-toggle")?.name).toBe("Animated light/dark switch");
    expect(effectPath("voice-glow")).toBe("orbis-effects/voice-glow.md");
  });

  it("hands the request to Code once, and drops anything that doesn't fit", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k) });
    try {
      openInCode({ request: "Add it", target: "latest-website", effect: "voice-glow" });
      expect(takeCodePrefill()).toEqual({ request: "Add it", details: { purpose: "", audience: "", style: "", sections: "" }, target: "latest-website", effect: "voice-glow" });
      expect(takeCodePrefill()).toBeNull();
      store.set("orbis:code:prefill", JSON.stringify({ request: "x".repeat(9000), target: "elsewhere", effect: "../../etc", details: { style: 5 } }));
      const p = takeCodePrefill()!;
      expect(p.request).toHaveLength(8000);
      expect(p.target).toBe("new:website");
      expect(p.effect).toBeUndefined();
      expect(p.details?.style).toBe("");
      store.set("orbis:code:prefill", "{not json");
      expect(takeCodePrefill()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sends an effect to the most recently edited website, or a new one", () => {
    const p = (id: string, template: string, updatedAt: string) => ({ id, template, updatedAt });
    expect(latestWebsite([p("a", "website", "2026-10-01"), p("b", "node", "2026-10-20"), p("c", "website", "2026-10-10")])?.id).toBe("c");
    expect(latestWebsite([p("b", "node", "2026-10-20")])).toBeUndefined();
  });
});

describe("estimates", () => {
  const t = findTemplate("research-topic")!;
  const inputs = { topic: "Heat pumps", depth: "Quick overview" };
  const models = [
    { id: "cheap", displayName: "Cheap", inputPrice: 0.1, outputPrice: 0.4, units: 1 },
    { id: "big", displayName: "Big", inputPrice: 3, outputPrice: 15, units: 4 },
    { id: "unpriced", displayName: "Mystery", inputPrice: null, outputPrice: null, units: 2, locked: true },
  ];

  it("counts one call per step at the chosen model's units and prices", () => {
    const e = templateEstimate(t, models, "big", inputs)!;
    expect(e.calls).toBe(2);
    expect(e.text).toMatch(/^2 model calls · 8 units of your allowance · up to ≈ \$0\.\d\d at list prices · 1 web search when available$/);
  });

  it("gives a range for Auto across the models it may use, and says when prices are unknown", () => {
    expect(templateEstimate(t, models, "auto:research", inputs, {}, true)!.text).toMatch(/Auto picks the model for each\) · 2–8 units/);
    expect(
      templateEstimate(
        t,
        [models[2]!].map((m) => ({ ...m, locked: false })),
        "unpriced",
        inputs,
      )!.text,
    ).toMatch(/no published price for Mystery/);
    expect(templateEstimate(findTemplate("plan-project")!, models, "big", {})).toBeNull();
  });

  it("grows with the inputs and with custom instructions", () => {
    const step = t.steps![0]!;
    expect(stepInputChars(t, step, { ...inputs, purpose: "x".repeat(1000) })).toBeGreaterThan(stepInputChars(t, step, inputs) + 900);
    expect(stepInputChars(t, t.steps![1]!, inputs)).toBeGreaterThan(t.steps![0]!.maxOutputTokens * 4);
  });
});

describe("the step runner", () => {
  beforeEach(() => {
    env.searchKey = undefined;
    env.provider = "anthropic";
    env.streamed = [];
    env.searchFails = false;
    env.webLeft = 5;
    env.recorded = [];
    env.tracked = [];
    env.streamFails = false;
  });
  const call = async (body: Record<string, unknown>) => {
    const { POST } = await import("@/app/api/templates/step/route");
    const res = await POST(new Request("https://x.test/api/templates/step", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
    if (!res.ok) return { status: res.status, body: (await res.json()) as { error: { message: string } }, events: [] as Record<string, unknown>[] };
    const events = (await res.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    return { status: res.status, body: null, events };
  };
  const research = { templateId: "research-topic", inputs: { topic: "Heat pumps", depth: "Quick overview" } };

  it("streams a step: model, notice when search isn't set up, text, then done with usage", async () => {
    const r = await call({ ...research, stepId: "brief" });
    expect(r.events.map((e) => e.type)).toEqual(["meta", "notice", "delta", "delta", "done"]);
    expect(r.events[1]!.message).toMatch(/Web search isn't set up/);
    expect(r.events.at(-1)).toMatchObject({ type: "done", text: "Hello world", usage: { inputTokens: 100 } });
    expect(env.recorded[0]).toMatchObject({ purpose: "template", status: "success", tools: [] });
    const sent = (env.streamed[0] as { messages: { role: string; content: string }[] }).messages;
    expect(sent.at(-1)!.content).toContain("Write a Quick overview on: Heat pumps");
  });

  it("adds web sources when search is set up, and counts the search", async () => {
    env.searchKey = "k";
    const r = await call({ ...research, stepId: "brief" });
    expect(r.events.find((e) => e.type === "sources")).toMatchObject({ sources: [{ url: "https://a.org" }] });
    expect(env.recorded[0]).toMatchObject({ tools: ["web_search"] });
    const system = (env.streamed[0] as { messages: { role: string; content: string }[] }).messages[0]!.content;
    expect(system).toContain('<source id="1" url="https://a.org">');
  });

  it("carries on without sources when the search fails or the plan's searches are used up", async () => {
    env.searchKey = "k";
    env.searchFails = true;
    expect((await call({ ...research, stepId: "brief" })).events.find((e) => e.type === "notice")!.message).toMatch(/couldn't be retrieved/);
    env.searchFails = false;
    env.webLeft = 0;
    expect((await call({ ...research, stepId: "brief" })).events.find((e) => e.type === "notice")!.message).toMatch(/used up/);
  });

  it("uses earlier results, and refuses a later step without them", async () => {
    const missing = await call({ ...research, stepId: "check" });
    expect(missing.status).toBe(400);
    expect(missing.body!.error.message).toMatch(/Run the earlier steps first/);
    const ok = await call({ ...research, stepId: "check", prior: { brief: "THE BRIEFING" } });
    expect(ok.status).toBe(200);
    expect((env.streamed[0] as { messages: { content: string }[] }).messages.at(-1)!.content).toContain("THE BRIEFING");
  });

  it("records the workflow starting, finishing and failing (template id only)", async () => {
    await call({ ...research, stepId: "brief" });
    expect(env.tracked).toEqual([["workflow_started", { template: "research-topic" }]]);
    env.tracked = [];
    await call({ ...research, stepId: "check", prior: { brief: "B" } });
    expect(env.tracked).toEqual([["workflow_completed", { template: "research-topic", steps: 2 }]]);
    env.tracked = [];
    env.streamFails = true;
    await call({ ...research, stepId: "check", prior: { brief: "B" } });
    expect(env.tracked).toEqual([["workflow_failed", { template: "research-topic", step: "check" }]]);
  });

  it("uses the user's own instructions for a step", async () => {
    await call({ ...research, stepId: "brief", instructions: "Just three bullets about {{topic}}." });
    expect((env.streamed[0] as { messages: { content: string }[] }).messages.at(-1)!.content).toBe("Just three bullets about Heat pumps.");
  });

  it("explains bad requests and missing models plainly", async () => {
    expect((await call({ templateId: "nope", stepId: "x", inputs: {} })).status).toBe(404);
    expect((await call({ templateId: "plan-project", stepId: "plan", inputs: { goal: "x" } })).status).toBe(404);
    const invalid = await call({ templateId: "research-topic", stepId: "brief", inputs: { depth: "Quick overview" } });
    expect(invalid.status).toBe(400);
    expect(invalid.body!.error.message).toBe("Topic or question is needed.");
    env.provider = "demo";
    const demo = await call({ ...research, stepId: "brief" });
    expect(demo.body!.error.message).toMatch(/need a real AI model/);
  });

  it("limits input size", () => {
    expect(templateStepRequest.safeParse({ templateId: "a", stepId: "b", inputs: { a: "x".repeat(40_000), b: "x".repeat(30_000) } }).success).toBe(false);
    expect(templateStepRequest.safeParse({ templateId: "A!", stepId: "b", inputs: {} }).success).toBe(false);
  });
});

describe("saved prompts", () => {
  const p = { id: "1", text: "Summarise this", createdAt: "2026-10-01T00:00:00Z" };
  it("edits the name, folder and text, trimming and dropping empty values", () => {
    expect(patchPrompt(p, { title: "  Summary  ", folder: "Work", text: " Summarise this briefly " }, "2026-10-02T00:00:00Z")).toEqual({
      ...p,
      title: "Summary",
      folder: "Work",
      text: "Summarise this briefly",
      updatedAt: "2026-10-02T00:00:00Z",
    });
    expect(patchPrompt({ ...p, title: "x", folder: "y" }, { title: " ", folder: "" }).title).toBeUndefined();
    expect(patchPrompt(p, { text: "   " }).text).toBe("Summarise this");
  });
});
