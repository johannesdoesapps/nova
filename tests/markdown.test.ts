/**
 * The chat's Markdown renderer: tables become real, scrollable tables (not a
 * line of pipes), wide code blocks can be reached by keyboard, and nothing in
 * the text can inject markup.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/common/markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("Markdown", () => {
  it("renders a table with headers, alignment and inline formatting", () => {
    const out = html("Before\n\n| Plan | Price | Notes |\n|:---|---:|:---:|\n| **Pro** | $20 | `fast` |\n| Max | $100 |\n\nAfter");
    expect(out).toContain('<div class="orbis-table" tabindex="0" role="region" aria-label="Table"><table>');
    expect(out).toContain('<th scope="col" style="text-align:left">Plan</th>');
    expect(out).toContain('<td style="text-align:right">$20</td>');
    expect(out).toContain("<strong>Pro</strong>");
    expect(out).toContain("<code>fast</code>");
    // A short row is padded so columns stay aligned.
    expect(out.match(/<td/g)!.length).toBe(6);
    expect(out).toContain("<p>Before</p>");
    expect(out).toContain("<p>After</p>");
  });

  it("handles tables without outer pipes and escaped pipes in cells", () => {
    const out = html("a | b\n--- | ---\nx \\| y | z");
    expect(out).toContain('<th scope="col">a</th>');
    expect(out).toContain("<td>x | y</td>");
  });

  it("doesn't mistake other text for a table", () => {
    expect(html("a | b\n---")).not.toContain("<table");
    expect(html("one | two\n|---|---|---|\n")).not.toContain("<table");
    expect(html("Plain text\n\n---\n\nMore")).toContain("<hr/>");
  });

  it("makes code blocks keyboard-scrollable", () => {
    expect(html("```ts\nconst x = 1;\n```")).toContain('<pre tabindex="0" aria-label="Code, ts">');
  });

  it("never renders markup from the text", () => {
    const out = html("| <img src=x onerror=alert(1)> | b |\n|---|---|\n| <script>x</script> | [l](javascript:alert(1)) |");
    expect(out).not.toMatch(/<img|<script|href="javascript/);
  });
});
