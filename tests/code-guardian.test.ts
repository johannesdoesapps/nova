/**
 * Code Guardian engineering analysis: source handling, module graph, defect rules (their own cases plus a
 * seeded-defect project and its correct twin), semver, dependency compatibility, maintainability, change impact,
 * regression memory, the repair task and storage sizing. All fixtures are synthetic.
 */
import { describe, expect, it } from "vitest";
import { jsonBytes } from "@/lib/security/hunt/investigate";
import { analyseEngineering, fitGuardianSummary } from "@/lib/security/guardian/analyse";
import { isEngineering } from "@/lib/security/guardian/categories";
import { checkCompatibility } from "@/lib/security/guardian/compat";
import { DEFECT_RULES, runDefectRuleTests, scanDefects } from "@/lib/security/guardian/defects";
import { brokenImports, buildGraph, dependentsOf, findCycles, orphans, unusedExports } from "@/lib/security/guardian/graph";
import { analyseImpact } from "@/lib/security/guardian/impact";
import { analyseMaintainability, duplicateBlocks } from "@/lib/security/guardian/maintain";
import { buildMemory } from "@/lib/security/guardian/memory";
import { buildProfile } from "@/lib/security/guardian/profile";
import { approvalNeeded, repairTask } from "@/lib/security/guardian/repair";
import { satisfies } from "@/lib/security/guardian/semver";
import { codeOnly, isTestPath, stripComments } from "@/lib/security/guardian/source";

const F = (path: string, content: string) => ({ path, content });

describe("source handling", () => {
  it("removes comments and blanks strings without moving lines", () => {
    const src = 'const a = "x // not a comment"; // real comment\n/* block\ncomment */ import b from "./b";';
    const s = stripComments(src, "ts");
    expect(s.split("\n")).toHaveLength(3);
    expect(s).toContain('"x // not a comment"');
    expect(s).not.toContain("real comment");
    const c = codeOnly(src, "ts");
    expect(c).not.toContain("not a comment");
    expect(c).toContain('"./b"');
  });
  it("classifies tests, but not a Next.js route in a folder called test", () => {
    expect(isTestPath("src/a.test.ts")).toBe(true);
    expect(isTestPath("tests/a.ts")).toBe(true);
    expect(isTestPath("src/app/api/connectors/[id]/test/route.ts")).toBe(false);
  });
});

describe("module graph", () => {
  const files = [
    F("tsconfig.json", '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./src/*"] } } }'),
    F("src/a.ts", 'import { b } from "./b";\nexport const a = () => b();\nexport const neverUsed = 1;'),
    F("src/b.ts", 'import { a } from "@/a";\nimport type { T } from "./types";\nexport function b() { return a; }'),
    F("src/types.ts", 'import type { B } from "./b";\nexport type T = B;'),
    F("src/c.ts", 'import x from "./missing";\nimport Btn from "./Button";\nconst sample = `import y from "./also-missing"`;\nexport default x;'),
    F("src/button.tsx", "export default function Button() { return null; }"),
    F("src/lonely.ts", "export const lonely = 1;"),
    F("src/app/page.tsx", 'import c from "@/c";\nexport default function Page() { return c; }'),
    F("pkg/svc.py", "from .executor import run\n"),
    F("pkg/executor.py", "def run():\n    from .svc import x\n    return x\n"),
  ];
  const g = buildGraph(files);
  it("resolves relative and alias imports and finds runtime cycles only", () => {
    expect([...g.nodes.get("src/b.ts")!.imports.map((i) => i.to)]).toContain("src/a.ts");
    const cycles = findCycles(g);
    expect(cycles).toEqual([["src/a.ts", "src/b.ts"]]); // type-only and lazy Python imports don't count
  });
  it("reports imports that point at nothing, ignoring code inside strings", () => {
    const broken = brokenImports(g).map((b) => b.spec);
    expect(broken).toContain("./missing");
    expect(broken).toContain("./Button");
    expect(broken).not.toContain("./also-missing");
  });
  it("finds unused files and exports, but not framework entry points", () => {
    expect(orphans(g)).toContain("src/lonely.ts");
    expect(orphans(g)).not.toContain("src/app/page.tsx");
    const dead = unusedExports(g).map((u) => `${u.file}:${u.name}:${u.localUses}`);
    expect(dead).toContain("src/a.ts:neverUsed:0");
  });
  it("walks dependents transitively", () => {
    const d = dependentsOf(g, ["src/c.ts"]);
    expect(d.get("src/app/page.tsx")).toBe(1);
  });
  it("broken imports become findings only for complete snapshots, and case-only mismatches are confirmed", () => {
    const upload = analyseEngineering(files, "upload", { completeSnapshot: false });
    expect(upload.findings.some((f) => f.ruleId === "quality.broken-import")).toBe(false);
    const repo = analyseEngineering(files, "github:o/r", { completeSnapshot: true });
    const caseOnly = repo.findings.find((f) => f.ruleId === "quality.broken-import" && f.title.includes("./Button"));
    expect(caseOnly?.confidence).toBe("confirmed");
  });
});

describe("defect rules", () => {
  it("pass every rule's own positive and negative cases", () => {
    const failed = DEFECT_RULES.flatMap((r) =>
      runDefectRuleTests(r)
        .filter((t) => !t.passed)
        .map((t) => `${r.id}: ${t.name}`),
    );
    expect(failed).toEqual([]);
    for (const r of DEFECT_RULES) {
      expect(
        r.tests.some((t) => t.expect > 0),
        r.id,
      ).toBe(true);
      expect(
        r.tests.some((t) => t.expect === 0),
        r.id,
      ).toBe(true);
      expect(r.scenario && r.impact && r.fix && r.test, r.id).toBeTruthy();
    }
  });

  // A small project with one planted defect per pattern, and its corrected twin.
  const seeded = [
    F("src/sync.ts", "export async function syncAll(items: string[]) {\n  items.forEach(async (i) => { await save(i); });\n}"),
    F("src/check.ts", 'export function valid(n: number, v: unknown) {\n  if (n === NaN) return false;\n  if (typeof v === "array") return true;\n  return true;\n}'),
    F(
      "src/list.tsx",
      '"use client";\nexport function L() {\n  useEffect(async () => { setX(await load()); }, []);\n  useEffect(() => { setInterval(tick, 1000); }, []);\n  items.push(item);\n  setItems(items);\n}',
    ),
    F("src/api.ts", "export async function get(u: string) {\n  const res = await fetch(u);\n  const data = res.json();\n  return data.id;\n}"),
    F("src/app/api/x/route.ts", 'export async function POST() {\n  return NextResponse.json({ error: "bad input" });\n}'),
    F("src/parse.ts", 'export const nums = (s: string) => s.split(",").map(parseInt);\nexport const year = (d: Date) => d.getYear();'),
    F("src/store.ts", 'export const prefs = () => JSON.parse(localStorage.getItem("prefs") ?? "{}");'),
    F("app/util.py", 'def add(x, items=[]):\n    items.append(x)\n    return items\n\ndef kind(s):\n    if s is "done":\n        return 1\n'),
  ];
  const fixed = [
    F("src/sync.ts", "export async function syncAll(items: string[]) {\n  for (const i of items) await save(i);\n}"),
    F("src/check.ts", "export function valid(n: number, v: unknown) {\n  if (Number.isNaN(n)) return false;\n  if (Array.isArray(v)) return true;\n  return true;\n}"),
    F(
      "src/list.tsx",
      '"use client";\nexport function L() {\n  useEffect(() => { let off = false; void load().then((d) => !off && setX(d)).catch(report); return () => { off = true; }; }, []);\n  useEffect(() => { const id = setInterval(tick, 1000); return () => clearInterval(id); }, []);\n  setItems([...items, item]);\n}',
    ),
    F(
      "src/api.ts",
      "export async function get(u: string) {\n  const res = await fetch(u);\n  if (!res.ok) throw new Error(String(res.status));\n  const data = await res.json();\n  return data.id;\n}",
    ),
    F("src/app/api/x/route.ts", 'export async function POST() {\n  return NextResponse.json({ error: "bad input" }, { status: 400 });\n}'),
    F("src/parse.ts", 'export const nums = (s: string) => s.split(",").map(Number);\nexport const year = (d: Date) => d.getFullYear();'),
    F("src/store.ts", 'export const prefs = () => {\n  try {\n    return JSON.parse(localStorage.getItem("prefs") ?? "{}");\n  } catch {\n    return {};\n  }\n};'),
    F("app/util.py", 'def add(x, items=None):\n    items = items or []\n    items.append(x)\n    return items\n\ndef kind(s):\n    if s == "done":\n        return 1\n'),
  ];
  const planted = [
    "async-foreach",
    "nan-compare",
    "typeof-impossible",
    "useeffect-async",
    "interval-not-cleared",
    "mutate-then-set-state",
    "json-unawaited",
    "error-with-200",
    "map-parseint",
    "get-year",
    "json-parse-storage",
    "py-mutable-default",
    "py-is-literal",
  ];

  it("finds every planted defect in the seeded project", () => {
    const found = new Set(scanDefects(seeded, "seeded").findings.map((f) => f.ruleId.slice("quality.".length)));
    expect(planted.filter((p) => !found.has(p))).toEqual([]);
  });
  it("reports nothing on the corrected twin", () => {
    expect(scanDefects(fixed, "fixed").findings.map((f) => `${f.ruleId} ${f.location}`)).toEqual([]);
  });
  it("skips test files, keeps fingerprints stable when code moves, and redacts secrets in evidence", () => {
    expect(scanDefects([F("src/a.test.ts", "items.forEach(async (i) => save(i));")], "x").findings).toHaveLength(0);
    const before = scanDefects([F("src/a.ts", "items.forEach(async (i) => save(i));")], "x").findings[0]!;
    const after = scanDefects([F("src/a.ts", "// moved\n\nitems.forEach(async (i) => save(i));")], "x").findings[0]!;
    expect(after.fingerprint).toBe(before.fingerprint);
    expect(after.location).toBe("src/a.ts:3");
    const key = "AKIA" + "ABCDEFGHIJKLMNOP";
    const leaked = scanDefects([F("src/k.ts", `items.forEach(async (i) => send(i, "${key}"));`)], "x").findings[0]!;
    expect(leaked.evidence[0]!.detail).not.toContain(key);
  });
});

describe("semver (cases checked against npm's semver)", () => {
  const cases: [string, string, boolean][] = [
    ["1.2.4", "^1.2.3", true],
    ["2.0.0", "^1.2.3", false],
    ["0.1.5", "^0.1.0", true],
    ["0.2.0", "^0.1.0", false],
    ["0.0.3", "^0.0.1", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["19.0.0", "^18 || ^19", true],
    ["19.2.0", ">=16.8.0", true],
    ["2.0.0-rc.2", "^2.0.0-rc.1", true],
    ["19.1.0-canary.1", ">=18", false],
    ["2.0.0-beta.1", "*", false],
    ["1.9.9", "1.2.3 - 2.1", true],
    ["2.1.0", "1.2.3 - 2.1", true],
    ["2.2.0", "1.2.3 - 2.1", false],
    ["1.2.0", "<=1.2", true],
    ["1.3.0", "<=1.2", false],
    ["4.17.21", "^4.17.0", true],
  ];
  it.each(cases)("%s satisfies %s → %s", (v, r, want) => expect(satisfies(v, r)).toBe(want));
  it("returns null for things that aren't ranges", () => {
    expect(satisfies("1.0.0", "github:owner/repo")).toBeNull();
    expect(satisfies("1.0.0", "latest")).toBeNull();
  });
});

describe("dependency compatibility", () => {
  const pkg = {
    name: "app",
    engines: { node: "18.x" },
    dependencies: { left: "^2.0.0", react: "^19.0.0", ui: "^1.0.0", ghost: "^1.0.0", unused: "^1.0.0", old: "^1.0.0", wild: "*" },
    devDependencies: { left: "^2.0.0", vitest: "^5.0.0" },
  };
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: pkg.dependencies },
      "node_modules/left": { version: "1.5.0" },
      "node_modules/react": { version: "19.1.0" },
      "node_modules/ui": { version: "1.2.0", peerDependencies: { react: "^18.0.0" } },
      "node_modules/unused": { version: "1.0.0" },
      "node_modules/old": { version: "1.0.0", deprecated: "Use new-old instead" },
      "node_modules/wild": { version: "3.0.0" },
      "node_modules/vitest": { version: "5.0.0", dev: true, engines: { node: "^22.12.0" } },
      "node_modules/transitive": { version: "1.0.0" },
    },
  };
  const files = [
    F("package.json", JSON.stringify(pkg)),
    F("package-lock.json", JSON.stringify(lock)),
    F(".nvmrc", "20"),
    F(
      "src/a.ts",
      'import React from "react";\nimport { Button } from "ui";\nimport l from "left";\nimport o from "old";\nimport w from "wild";\nimport t from "transitive";\nimport n from "not-installed";\nimport fs from "node:fs";\nimport p from "path";',
    ),
  ];
  const r = checkCompatibility(files, buildGraph(files), "repo");
  const by = (id: string) => r.findings.filter((f) => f.ruleId === id);
  it("detects lockfile drift (range not satisfied, declared but not locked)", () => {
    const d = by("compat.lockfile-drift")[0]!;
    expect(d.severity).toBe("high");
    expect(d.description).toContain("left: package.json wants ^2.0.0, lockfile has 1.5.0");
    expect(d.description).toContain("ghost@^1.0.0 is in package.json but not in the lockfile");
  });
  it("separates imports that will fail from ones that work by accident", () => {
    const u = by("compat.undeclared-import");
    expect(u.find((f) => f.title.startsWith("not-installed"))?.severity).toBe("high");
    expect(u.find((f) => f.title.startsWith("transitive"))?.severity).toBe("medium");
    expect(u.some((f) => /node:fs|path/.test(f.title))).toBe(false);
  });
  it("reports peer conflicts, dev-only engine mismatches as low, deprecations and unused/duplicate/unpinned declarations", () => {
    expect(by("compat.peer-conflict")[0]?.title).toContain("react");
    expect(by("compat.engine-mismatch")[0]?.severity).toBe("low");
    expect(by("compat.deprecated")[0]?.title).toContain("old");
    // "ghost" is declared and never imported either.
    expect(
      by("compat.unused-dependency")
        .map((f) => f.title.split(" ")[0])
        .sort(),
    ).toEqual(["ghost", "unused"]);
    expect(by("compat.declared-twice")[0]?.description).toContain("left");
    expect(by("compat.unpinned")[0]?.description).toContain("wild");
    expect(by("compat.node-version-mismatch")).toHaveLength(1);
  });
  it("is quiet when everything agrees", () => {
    const ok = [
      F("package.json", JSON.stringify({ dependencies: { a: "^1.0.0" } })),
      F("package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { a: "^1.0.0" } }, "node_modules/a": { version: "1.4.0" } } })),
      F("src/x.ts", 'import a from "a";'),
    ];
    expect(checkCompatibility(ok, buildGraph(ok), "ok").findings).toEqual([]);
  });
});

describe("maintainability", () => {
  it("finds duplicated blocks, complex functions and debt markers in comments only", () => {
    const block = Array.from({ length: 16 }, (_, i) => `  total += values[${i}] * weights[${i}];`).join("\n");
    const branches = Array.from({ length: 30 }, (_, i) => `  if (x === ${i}) y++;`).join("\n");
    const files = [
      F("src/a.ts", `export function a(values: number[], weights: number[]) {\n  let total = 0;\n${block}\n  return total;\n}\n// TODO: handle empty input`),
      F("src/b.ts", `export function b(values: number[], weights: number[]) {\n  let total = 0;\n${block}\n  return total;\n}\nconst s = "TODO: not a comment";`),
      F("src/c.ts", `export function tangled(x: number) {\n  let y = 0;\n${branches}\n  return y;\n}`),
    ];
    expect(duplicateBlocks(files)[0]).toMatchObject({ lines: expect.any(Number) });
    const m = analyseMaintainability(files, buildGraph(files), "repo");
    expect(m.summary.complexFunctions[0]?.name).toBe("tangled");
    expect(m.summary.debt.total).toBe(1);
    expect(m.findings.some((f) => f.ruleId === "arch.duplicate-block")).toBe(true);
  });
});

describe("change impact", () => {
  const shared = Array.from({ length: 30 }, (_, i) => F(`src/feature${i}.ts`, `import { util } from "./util";\nexport const f${i} = () => util();`));
  const files = [
    F("package.json", JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit", lint: "eslint" }, devDependencies: { vitest: "^5.0.0" } })),
    F("src/util.ts", "export const util = () => 1;"),
    F("src/lonely.ts", "export const lonely = () => 2;"),
    F("src/app/page.tsx", 'import { f0 } from "@/feature0";\nexport default function P() { return f0(); }'),
    F("tsconfig.json", '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }'),
    F("tests/util.test.ts", 'import { util } from "../src/util";\nit("x", () => util());'),
    F("tests/feature1.test.ts", 'import { f1 } from "../src/feature1";\nit("y", () => f1());'),
    ...shared,
  ];
  const g = buildGraph(files);
  const profile = buildProfile(files);
  it("rates a widely shared module high risk and plans direct tests first, then wider ones and the full suite", () => {
    const r = analyseImpact(g, ["src/util.ts"], profile);
    expect(r.risk).toBe("high");
    expect(r.affectedTotal).toBeGreaterThanOrEqual(30);
    expect(r.entryPoints).toContain("src/app/page.tsx");
    expect(r.plan[0]!.command).toBe("npx vitest run tests/util.test.ts");
    expect(r.plan.some((p) => p.command === "npm test")).toBe(true);
    expect(r.plan.every((p) => p.status !== ("passed" as string))).toBe(true);
  });
  it("asks for a test first when nothing covers the changed file", () => {
    const r = analyseImpact(g, ["src/lonely.ts"], profile);
    expect(r.untested).toEqual(["src/lonely.ts"]);
    expect(r.risk).toBe("medium");
    expect(r.plan.some((p) => /Write a test/.test(p.why))).toBe(true);
  });
  it("treats migrations and auth as high risk with a rollback approach", () => {
    const r = analyseImpact(g, ["supabase/migrations/001_x.sql", "src/lib/auth.ts"], profile);
    expect(r.risk).toBe("high");
    expect(r.rollback.join(" ")).toMatch(/down-migration/);
    expect(r.rollback.join(" ")).toMatch(/sign-in/);
  });
});

describe("regression memory, repair task and storage", () => {
  it("lists regressions, fragile files and repeated patterns, and compares with the previous scan", () => {
    const row = (fp: string, rule: string, loc: string, status = "open", occ = 1) => ({
      fingerprint: fp,
      rule_id: rule,
      title: `${rule} at ${loc}`,
      location: loc,
      status,
      occurrences: occ,
      first_seen: "2026-10-01T00:00:00Z",
      last_run_id: "run2",
    });
    const rows = [
      row("1", "quality.async-foreach", "src/a.ts:3"),
      row("2", "quality.async-foreach", "src/b.ts:4"),
      row("3", "quality.async-foreach", "src/c.ts:5"),
      row("4", "quality.nan-compare", "src/a.ts:9", "open", 4),
      row("5", "quality.get-year", "src/a.ts:12"),
    ];
    const m = buildMemory({
      rows,
      runId: "run2",
      reopened: ["4"],
      resolvedThisScan: 2,
      previous: { at: "2026-10-10T00:00:00Z", counts: { defects: 7, dependencies: 0, maintainability: 0, security: 1 } },
    });
    expect(m.regressions.map((r) => r.rule)).toEqual(["quality.nan-compare"]);
    expect(m.fragile[0]).toMatchObject({ file: "src/a.ts", regressions: 1 });
    expect(m.patterns[0]).toMatchObject({ rule: "quality.async-foreach", files: 3 });
    expect(m.delta.defects).toBe(-2);
    expect(m.longStanding[0]?.scans).toBe(4);
  });
  it("builds a repair task with reproduction first, approvals and an honest completion report", () => {
    const f = {
      title: "x",
      rule_id: "compat.lockfile-drift",
      severity: "high",
      confidence: "confirmed",
      location: "package-lock.json",
      asset: "github:o/r",
      description: "d",
      remediation: "r",
      evidence: [],
    };
    const t = repairTask(f, null);
    expect(t).toMatch(/Reproduce: before editing/);
    expect(t).toMatch(/implemented but unverified/);
    expect(approvalNeeded(f, null).join(" ")).toMatch(/dependency install/);
  });
  it("keeps the stored summary within its budget and never reports a check as run", () => {
    const files = Array.from({ length: 60 }, (_, i) => F(`src/m${i}.ts`, `import { m${(i + 1) % 60} } from "./m${(i + 1) % 60}";\nexport const m${i} = 1;\nexport const dead${i} = 2;`));
    const a = analyseEngineering([F("package.json", JSON.stringify({ scripts: { test: "vitest run" } })), ...files], "repo", { completeSnapshot: true });
    expect(a.summary.checks.every((c) => c.status === "not run")).toBe(true);
    const fitted = fitGuardianSummary({ ...a.summary, memory: null }, 4000);
    expect(jsonBytes(fitted)).toBeLessThanOrEqual(4000);
  });
  it("keeps engineering findings out of security categories", () => {
    expect(isEngineering("quality.async-foreach")).toBe(true);
    expect(isEngineering("compat.peer-conflict")).toBe(true);
    expect(isEngineering("code.eval")).toBe(false);
    expect(isEngineering("deps.osv")).toBe(false);
  });
});
