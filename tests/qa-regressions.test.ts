import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Regressions found in the 25 Oct 2026 QA sweep (docs/QA_SWEEP_2026-10-25.md). */

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : n.endsWith(".tsx") ? [p] : [];
  });
}

describe("QA sweep regressions", () => {
  it("QA-04: every table that scrolls sideways can be reached and scrolled with the keyboard, and is named", () => {
    const offenders: string[] = [];
    for (const f of files("src/components")) {
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(/<div([^>]*overflow-x-auto[^>]*)>\s*<table/g)) {
        if (!/tabIndex=\{0\}/.test(m[1]!) || !/aria-label=/.test(m[1]!)) offenders.push(`${f}:${s.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("QA-01: the vulnerable zod pulled in by @vercel/sandbox is overridden to a fixed version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { overrides?: Record<string, Record<string, string>> };
    expect(pkg.overrides?.["@vercel/cli-config"]?.zod).toMatch(/^\^4\.(6\.([6-9]|\d{2,})|[7-9]|\d{2,})/);
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as { packages: Record<string, { version?: string }> };
    const nested = lock.packages["node_modules/@vercel/cli-config/node_modules/zod"];
    expect(nested === undefined || !/^4\.[0-5]\./.test(nested.version ?? "")).toBe(true);
  });

  it("QA-05: the template browser bar's address text has enough contrast", () => {
    const s = readFileSync("src/components/code/site-templates-view.tsx", "utf8");
    expect(s).not.toMatch(/text-\[10\.5px\] text-black\/45/);
  });

  it("QA-06: suggested-fix diffs in a review get a unique name per finding", () => {
    const s = readFileSync("src/components/review/review-view.tsx", "utf8");
    expect(s).toMatch(/path: `\$\{f\.file\}:\$\{f\.line\} \(suggested, not applied\)`/);
  });
});
