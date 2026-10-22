/**
 * The moving logo shown while Orbis replies: when it says "code", what it
 * renders for each state, and that its motion turns off.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { GeneratingIndicator, inOpenCodeBlock, isCodeRequest, WritingIndicator } from "@/components/studio/generating";
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

describe("indicators", () => {
  it("waiting: the moving Orbis logo and a status announced to screen readers", () => {
    const out = renderToStaticMarkup(createElement(GeneratingIndicator, { label: "Generating code" }));
    expect(out).toContain('role="status"');
    expect(out).toContain("Generating code…");
    expect(out).toContain("loop-trace");
    expect(out).toContain("M32 32C38 22 52 20 54 32");
    expect(out).not.toContain("Still working");
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
    expect(reduced).toMatch(/\.loop-trace \{ animation: none; stroke-dasharray: none; \}/);
  });
});
