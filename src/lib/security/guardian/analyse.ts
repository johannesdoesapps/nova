import { jsonBytes } from "../hunt/investigate";
import { fingerprint, SEVERITY_ORDER, type FindingDraft } from "../types";
import { checkCompatibility, type CompatSummary } from "./compat";
import { scanDefects } from "./defects";
import { brokenImports, buildGraph, orphans, unusedExports, type ModuleGraph } from "./graph";
import { analyseMaintainability, type MaintainSummary } from "./maintain";
import { buildProfile, type ProjectProfile } from "./profile";
import { dirOf, joinPath, lineText, type SourceFile } from "./source";

/**
 * Code Guardian's engineering analysis over one snapshot of a codebase, as one pure function: profile, module
 * graph, defect rules, dependency compatibility and maintainability. The runner adds history (regression memory)
 * and stores the findings; the summary is sized for the run record. Nothing here executes the code — test and
 * build results come from wherever they're actually run, and the summary says so.
 */

export interface EngineeringAnalysis {
  graph: ModuleGraph;
  profile: ProjectProfile;
  findings: FindingDraft[];
  summary: GuardianSummary;
}

export interface GuardianSummary {
  profile: {
    languages: ProjectProfile["languages"];
    frameworks: { name: string; version: string | null }[];
    runtime: ProjectProfile["runtime"];
    scripts: string[];
    tests: ProjectProfile["tests"];
    ci: ProjectProfile["ci"];
    env: { referenced: number; documentedIn: string[]; undocumented: string[] };
    migrations: ProjectProfile["migrations"];
    docs: { readme: string | null; docs: number; decisions: number };
    monorepo: boolean;
    files: number;
    codeFiles: number;
  };
  graph: {
    modules: number;
    edges: number;
    broken: { file: string; line: number; spec: string; caseOnly: boolean }[];
    brokenReported: boolean;
    orphans: { count: number; sample: string[] };
    deadExports: { count: number; sample: { file: string; name: string; line: number }[] };
    exportOnlyUsedLocally: number;
  };
  defects: { filesScanned: number; byRule: Record<string, number>; capped: string[] };
  compat: CompatSummary;
  maintain: Pick<MaintainSummary, "functions" | "thresholds" | "hotspots"> & {
    longFunctions: MaintainSummary["longFunctions"];
    complexFunctions: MaintainSummary["complexFunctions"];
    largeFiles: MaintainSummary["largeFiles"];
    cycles: MaintainSummary["cycles"];
    duplicates: MaintainSummary["duplicates"];
    debt: MaintainSummary["debt"];
  };
  checks: { what: string; status: "not run"; why: string; command: string | null }[];
  limits: string[];
}

export function analyseEngineering(files: SourceFile[], asset: string, opts: { completeSnapshot: boolean }): EngineeringAnalysis {
  const graph = buildGraph(files);
  const profile = buildProfile(
    files,
    [...graph.nodes.values()].filter((n) => n.entry && !n.test).map((n) => n.path),
  );
  const findings: FindingDraft[] = [];

  const defects = scanDefects(files, asset);
  findings.push(...defects.findings);

  // Broken imports: only trustworthy when the snapshot is the whole repository.
  const lowerPaths = files.map((f) => f.path.toLowerCase());
  const broken = brokenImports(graph).map((b) => {
    // Relative imports only: does a file match if letter case is ignored?
    const target = b.spec.startsWith(".")
      ? joinPath(dirOf(b.file), b.spec)
          ?.toLowerCase()
          .replace(/\.(js|jsx|mjs|cjs)$/, "")
      : null;
    const caseOnly = !!target && lowerPaths.some((k) => (k.startsWith(`${target}.`) || k.startsWith(`${target}/index.`)) && /\.[cm]?[jt]sx?$/.test(k));
    return { ...b, caseOnly };
  });
  if (opts.completeSnapshot)
    for (const b of broken.slice(0, 20)) {
      const text = lineText(files.find((f) => f.path === b.file)?.content ?? "", b.line);
      findings.push({
        agent: "code_guardian",
        ruleId: "quality.broken-import",
        fingerprint: fingerprint("code_guardian", "quality.broken-import", asset, b.file, b.spec),
        title: `${b.file} imports "${b.spec}", which isn't in the repository`,
        description: `What's wrong: the import doesn't resolve to any file in the repository${b.caseOnly ? " — a file exists whose name differs only in letter case, which works on macOS and Windows but fails on Linux (most CI and hosting)" : ""}. When it fails: the build stops, or (for lazily loaded code) the first request that loads this file crashes. Why it matters: nothing that depends on this module can run. If the file is generated during the build, this is expected — say so and ignore it.`,
        severity: "high",
        confidence: b.caseOnly ? "confirmed" : "firm",
        rationale: "Resolved relative imports and tsconfig path aliases against every file in the snapshot.",
        asset,
        location: `${b.file}:${b.line}`,
        evidence: [{ source: `${b.file}:${b.line}`, detail: text }],
        evidenceSource: "orbis:code-guardian",
        remediation: `${b.caseOnly ? "Make the import's letter case match the file name exactly." : "Point the import at the right file (or add the missing file)."} How to test the fix: run the type check and build on Linux (as CI does).`,
        references: [],
      });
    }

  const compat = checkCompatibility(files, graph, asset);
  findings.push(...compat.findings);
  const maintain = analyseMaintainability(files, graph, asset);
  findings.push(...maintain.findings);

  const dead = unusedExports(graph);
  const orphanList = orphans(graph);
  const scripts = profile.packages[0]?.scripts ?? {};
  const checks: GuardianSummary["checks"] = [
    {
      what: "Tests",
      status: "not run",
      why: profile.tests.command ? "An audit reads code; it doesn't execute it. The coding agent runs these in its sandbox when it fixes a finding." : "No test command found in the repository.",
      command: profile.tests.command,
    },
    ...(["typecheck", "lint", "build"] as const)
      .map((k) => ({ k, s: Object.keys(scripts).find((x) => x === k || (k === "typecheck" && /^(type-check|tsc)$/.test(x))) }))
      .map(({ k, s }) => ({
        what: k === "typecheck" ? "Type check" : k === "lint" ? "Lint" : "Build",
        status: "not run" as const,
        why: s ? "Not executed during an audit." : `No ${k} script in package.json.`,
        command: s ? `npm run ${s}` : null,
      })),
  ];
  const limits = [
    "Static analysis of the files in this snapshot; nothing was executed, so no test or build result is claimed.",
    "Rules are text-based heuristics (no type information): 'firm' patterns are wrong in practically every case, 'tentative' ones need a person to check the context.",
    ...(opts.completeSnapshot ? [] : ["Uploaded files may not be the whole project, so imports that don't resolve are listed but not reported as defects."]),
  ];
  const summary: GuardianSummary = {
    profile: {
      languages: profile.languages,
      frameworks: profile.frameworks.slice(0, 12).map((f) => ({ name: f.name, version: f.version })),
      runtime: profile.runtime.slice(0, 6),
      scripts: Object.keys(scripts).slice(0, 20),
      tests: { ...profile.tests, dirs: profile.tests.dirs.slice(0, 5) },
      ci: profile.ci.slice(0, 5).map((c) => ({ ...c, jobs: c.jobs.slice(0, 5) })),
      env: { referenced: profile.env.referenced.length, documentedIn: profile.env.documentedIn, undocumented: profile.env.undocumented.slice(0, 20) },
      migrations: profile.migrations.slice(0, 4),
      docs: { readme: profile.docs.readme, docs: profile.docs.docs, decisions: profile.docs.decisions.length },
      monorepo: profile.monorepo,
      files: profile.files,
      codeFiles: profile.codeFiles,
    },
    graph: {
      modules: graph.nodes.size,
      edges: [...graph.nodes.values()].reduce((n, x) => n + x.imports.filter((i) => i.to).length, 0),
      broken: broken.slice(0, 10),
      brokenReported: opts.completeSnapshot,
      orphans: { count: orphanList.length, sample: orphanList.slice(0, 12) },
      deadExports: {
        count: dead.filter((d) => d.localUses === 0).length,
        sample: dead
          .filter((d) => d.localUses === 0)
          .slice(0, 12)
          .map(({ file, name, line }) => ({ file, name, line })),
      },
      exportOnlyUsedLocally: dead.filter((d) => d.localUses > 0).length,
    },
    defects: { filesScanned: defects.filesScanned, byRule: defects.byRule, capped: defects.capped },
    compat: { ...compat.summary, duplicates: compat.summary.duplicates.slice(0, 6) },
    maintain: {
      functions: maintain.summary.functions,
      thresholds: maintain.summary.thresholds,
      hotspots: maintain.summary.hotspots.slice(0, 8),
      longFunctions: maintain.summary.longFunctions.slice(0, 6),
      complexFunctions: maintain.summary.complexFunctions.slice(0, 6),
      largeFiles: maintain.summary.largeFiles.slice(0, 6),
      cycles: maintain.summary.cycles.slice(0, 6),
      duplicates: maintain.summary.duplicates.slice(0, 6),
      debt: { ...maintain.summary.debt, items: maintain.summary.debt.items.slice(0, 10) },
    },
    checks,
    limits,
  };
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { graph, profile, findings, summary };
}

/** Shrink the summary's lists until it fits `budget` bytes (the run record is capped at 20 KB). */
export function fitGuardianSummary<T extends Record<string, unknown>>(s: T, budget: number): T {
  if (jsonBytes(s) <= budget) return s;
  const out = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  const shrinkLists = (v: unknown, n: number): unknown => {
    if (Array.isArray(v)) return v.slice(0, n).map((x) => shrinkLists(x, n));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrinkLists(x, n)]));
    if (typeof v === "string" && v.length > 200) return `${v.slice(0, 199)}…`;
    return v;
  };
  for (const n of [5, 3, 2, 1]) {
    const shrunk = shrinkLists(out, n) as T;
    if (jsonBytes(shrunk) <= budget) return { ...shrunk, trimmed: `Lists shortened to ${n} item(s) to fit the run record.` };
  }
  return { trimmed: "The analysis summary was too large to store; the findings are saved." } as unknown as T;
}
