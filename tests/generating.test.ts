/**
 * The moving logo shown while Orbis replies: when it says "code", what it
 * renders for each state, and that its motion turns off.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { GeneratingIndicator, inOpenCodeBlock, isCodeRequest, nextStatusIndex, STATUS_MESSAGES, WritingIndicator } from "@/components/studio/generating";
import { InfinityMark } from "@/components/brand/infinity";

describe("code detection", () => {
  it("knows when the reply is in the middle of a code block", () => {
    expect(inOpenCodeBlock("Here you go:\n```ts\nconst a = 1;")).toBe(true);
    expect(inOpenCodeBlock("```ts\nconst a = 1;\n```\nDone.")).toBe(false);
    expect(inOpenCodeBlock("No code here")).toBe(false);
    expect(inOpenCodeBlock("Inline `code` only")).toBe(false);
  });

  it("labels coding requests", () => {
    expect(isCodeRequest("coding", "hi")).toBe(true);
    expect(isCodeRequest(null, "Why does this fail?\n```py\nprint(x)\n```")).toBe(true);
    expect(isCodeRequest("research", "What's the capital of France?")).toBe(false);
    expect(isCodeRequest(undefined, undefined)).toBe(false);
  });
});

describe("status lines", () => {
  it("never shows the same line twice in a row", () => {
    for (let current = 0; current < 5; current++) for (const r of [0, 0.2, 0.5, 0.99]) expect(nextStatusIndex(5, current, () => r)).not.toBe(current);
  });

  it("can reach every other line", () => {
    const seen = new Set<number>();
    for (let k = 0; k < 40; k++) seen.add(nextStatusIndex(5, 2, () => k / 40));
    expect([...seen].sort()).toEqual([0, 1, 3, 4]);
  });

  it("has varied, short lines for each kind of work, and coding gets coding lines", () => {
    for (const [kind, list] of Object.entries(STATUS_MESSAGES)) {
      expect(list.length, kind).toBeGreaterThanOrEqual(6);
      expect(new Set(list).size, kind).toBe(list.length);
      for (const line of list) expect(line.length, line).toBeLessThanOrEqual(30);
    }
    expect(STATUS_MESSAGES.code).toContain("Analyzing the code");
    expect(STATUS_MESSAGES.general).not.toContain("Analyzing the code");
  });

  it("never claims progress it can't know", () => {
    for (const list of Object.values(STATUS_MESSAGES)) for (const line of list) expect(line).not.toMatch(/almost|finaliz|nearly|done/i);
  });

  it("only mentions the web or data when the app says so", () => {
    for (const [kind, list] of Object.entries(STATUS_MESSAGES)) {
      if (kind !== "web") expect(list.join(" ")).not.toMatch(/web/i);
      if (kind !== "data") expect(list.join(" ")).not.toMatch(/data/i);
    }
  });
});

describe("indicators", () => {
  it("waiting: the moving logo, the first status line, and one steady screen-reader message", () => {
    const out = renderToStaticMarkup(createElement(GeneratingIndicator, { kind: "code" }));
    expect(out).toContain('role="status"');
    expect(out).toContain("Orbis is working on a reply.");
    expect(out).toContain("Thinking…");
    expect(out).toContain("loop-trace");
    expect(out).toContain("loop-float");
    expect(out).not.toContain("Still working");
    // The changing text itself is hidden from screen readers so it isn't read out every two seconds.
    expect(out).toMatch(/<span class="inline-grid" aria-hidden="true">/);
  });

  it("waiting starts with what the app knows is happening", () => {
    expect(renderToStaticMarkup(createElement(GeneratingIndicator, { kind: "web" }))).toContain("Searching the web…");
    expect(renderToStaticMarkup(createElement(GeneratingIndicator, { kind: "data" }))).toContain("Analyzing data…");
  });

  it("Compare cards can show it without their own announcement", () => {
    expect(renderToStaticMarkup(createElement(GeneratingIndicator, { announce: false }))).not.toContain('role="status"');
  });

  it("writing: says whether it is writing code or an answer", () => {
    expect(renderToStaticMarkup(createElement(WritingIndicator, { code: true }))).toContain("Writing code…");
    expect(renderToStaticMarkup(createElement(WritingIndicator, { code: false }))).toContain("Writing your answer…");
  });

  it("the logo only moves when asked to", () => {
    expect(renderToStaticMarkup(createElement(InfinityMark, {}))).not.toContain("loop-trace");
    expect(renderToStaticMarkup(createElement(InfinityMark, { animate: true }))).toContain("loop-trace");
  });

  it("the logo's motion stops, and the loop shows whole, when reduced motion is preferred", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(css).toMatch(/^\.loop-trace \{ animation:/m);
    expect(reduced).toMatch(/\.loop-float, \.s-status-in \{ animation: none; \}/);
    expect(reduced).toMatch(/\.loop-trace \{ animation: none; stroke-dasharray: none; \}/);
  });
});
