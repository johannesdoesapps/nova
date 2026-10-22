/**
 * The animated mascot shown while Orbis replies: when it says "code", what it
 * renders for each state, and that its motion is decoration that turns off.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { GeneratingIndicator, inOpenCodeBlock, isCodeRequest, WritingIndicator } from "@/components/studio/generating";
import { ChipMascot } from "@/components/brand/chip";

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
  it("waiting: an animated Chip and a status announced to screen readers", () => {
    const out = renderToStaticMarkup(createElement(GeneratingIndicator, { label: "Generating code" }));
    expect(out).toContain('role="status"');
    expect(out).toContain("Generating code…");
    expect(out).toContain("chip-float");
    expect(out).toContain("chip-blink");
    expect(out).not.toContain("Still working");
  });

  it("writing: says whether it is writing code or an answer", () => {
    expect(renderToStaticMarkup(createElement(WritingIndicator, { code: true }))).toContain("Writing code…");
    expect(renderToStaticMarkup(createElement(WritingIndicator, { code: false }))).toContain("Writing your answer…");
  });

  it("Chip only moves when asked to", () => {
    const still = renderToStaticMarkup(createElement(ChipMascot, { mood: "oops" }));
    expect(still).not.toMatch(/chip-(float|blink|wave|glow)/);
    expect(renderToStaticMarkup(createElement(ChipMascot, { mood: "hello", animate: true }))).toContain("chip-wave");
  });

  it("all of Chip's motion stops when reduced motion is preferred", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const classes = [...css.matchAll(/^\.(chip-[a-z-]+) \{ [^}]*animation:/gm)].map((m) => m[1]);
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(classes.length).toBeGreaterThan(5);
    for (const c of classes) if (!/-\d$/.test(c)) expect(reduced, c).toContain(`.${c}`);
  });
});
