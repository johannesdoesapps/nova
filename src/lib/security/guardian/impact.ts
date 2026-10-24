import { dependentsOf, isFrameworkEntry, type ModuleGraph } from "./graph";
import type { ProjectProfile } from "./profile";
import { baseOf, dirOf, isTestPath } from "./source";

/**
 * Change impact: before shared code is edited, what could break — every file that imports the changed files
 * (directly or through others), the entry points (routes, pages, scripts) that reach them, the tests that
 * exercise them, and concerns that raise the risk (dependencies, migrations, auth, configuration, CI). From that,
 * a risk level with its reasons, a test plan that starts with the smallest relevant tests and widens with the
 * risk, and a rollback approach for risky changes. Built from the static import graph: code reached by
 * dynamic loading, string-based plugin registration or other repositories isn't seen.
 */

export type Risk = "low" | "medium" | "high";

export interface TestStep {
  why: string;
  command: string | null;
  /** Never "passed": this is a plan. Results come from wherever it was run. */
  status: "planned" | "unavailable";
}

export interface ImpactReport {
  changed: { file: string; known: boolean; directDependents: number; exports: string[] }[];
  affected: { file: string; distance: number }[];
  affectedTotal: number;
  entryPoints: string[];
  tests: { file: string; reason: "imports the changed code" | "same name" }[];
  untested: string[];
  concerns: string[];
  risk: Risk;
  riskReasons: string[];
  plan: TestStep[];
  rollback: string[];
  limits: string[];
}

const CONCERNS: [RegExp, string, Risk][] = [
  [
    /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements[^/]*\.txt|pyproject\.toml)$/,
    "Changes dependencies: affects every install, the build and possibly runtime behaviour everywhere.",
    "high",
  ],
  [/(^|\/)(migrations|alembic|db\/migrate)\/|\.sql$|schema\.prisma$/, "Changes the database schema or data: may not be reversible; needs a backup and a tested down-migration.", "high"],
  [
    /(^|\/)(auth|session|login|permission|rbac|acl|middleware|proxy)[^/]*\.|\/(auth|permissions?)\//i,
    "Touches authentication or authorisation: mistakes can lock users out or let them in where they shouldn't be.",
    "high",
  ],
  [
    /(^|\/)(\.github\/workflows|\.gitlab-ci|\.circleci)|(^|\/)(vercel\.json|netlify\.toml|Dockerfile|docker-compose)/,
    "Changes CI or deployment configuration: affects how every change is built, tested and released.",
    "high",
  ],
  [/(^|\/)([^/]*\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|\.env[^/]*)$/, "Changes build or runtime configuration.", "medium"],
  [/(^|\/)(schema|schemas|types|validation|contracts?)\.[jt]sx?$|\/api\/|(^|\/)route\.[jt]s$/, "Changes a data shape or API contract that other code (or clients) rely on.", "medium"],
];

function testCommandFor(files: string[], profile: ProjectProfile | null): string | null {
  if (!files.length) return null;
  const fw = profile?.tests.frameworks ?? [];
  const list = files.slice(0, 12).join(" ");
  if (fw.includes("Vitest")) return `npx vitest run ${list}`;
  if (fw.includes("Jest")) return `npx jest ${list}`;
  if (fw.includes("pytest") && files.every((f) => f.endsWith(".py"))) return `pytest ${list}`;
  if (fw.includes("Playwright")) return `npx playwright test ${list}`;
  return profile?.tests.command ? `${profile.tests.command} (filter to: ${list})` : null;
}

export function analyseImpact(graph: ModuleGraph, changed: string[], profile: ProjectProfile | null = null): ImpactReport {
  const limits: string[] = ["Static import analysis: code loaded dynamically, by configuration or from other repositories isn't included."];
  const known = changed.filter((c) => graph.nodes.has(c));
  const dist = dependentsOf(graph, known);
  const affected = [...dist.entries()]
    .filter(([f, d]) => d > 0 && !changed.includes(f))
    .map(([file, distance]) => ({ file, distance }))
    .sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file));
  const reach = new Set([...known, ...affected.map((a) => a.file)]);
  const entryPoints = [...reach].filter((f) => !isTestPath(f) && (graph.nodes.get(f)?.entry || isFrameworkEntry(f))).sort();
  const tests: ImpactReport["tests"] = [...reach].filter((f) => isTestPath(f)).map((file) => ({ file, reason: "imports the changed code" as const }));
  // Tests named after a changed file (foo.ts ↔ foo.test.ts / test_foo.py) even if they don't import it directly.
  for (const c of changed) {
    const stem = baseOf(c).replace(/\.[^.]+$/, "");
    for (const n of graph.nodes.values())
      if (n.test && !tests.some((t) => t.file === n.path) && new RegExp(`(^|[/_.-])${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([._-](test|spec))?\\.`).test(baseOf(n.path)))
        tests.push({ file: n.path, reason: "same name" });
  }
  // A changed file is tested when some test imports it (directly or through other modules) or is named after it.
  const untested = known.filter((c) => {
    if (isTestPath(c)) return false;
    const stem = baseOf(c).replace(/\.[^.]+$/, "");
    return !tests.some((t) => t.reason === "same name" && baseOf(t.file).includes(stem)) && ![...dependentsOf(graph, [c]).keys()].some((f) => isTestPath(f));
  });

  const concerns: string[] = [];
  let risk = "low" as Risk;
  const reasons: string[] = [];
  const raise = (r: Risk, why: string) => {
    if (r === "high" || (r === "medium" && risk === "low")) risk = r;
    reasons.push(why);
  };
  for (const c of changed)
    for (const [re, text, r] of CONCERNS)
      if (re.test(c) && !concerns.includes(text)) {
        concerns.push(text);
        raise(r, `${c}: ${text}`);
      }
  if (affected.length >= 25) raise("high", `${affected.length} files depend on the changed code (directly or indirectly).`);
  else if (affected.length >= 6) raise("medium", `${affected.length} files depend on the changed code.`);
  if (entryPoints.length >= 10) raise("medium", `${entryPoints.length} routes, pages or entry points reach the changed code.`);
  const unknown = changed.filter((c) => !graph.nodes.has(c) && /\.(py|[cm]?[jt]sx?)$/.test(c));
  if (unknown.length) limits.push(`Not in the module graph (new file or not code): ${unknown.join(", ")}.`);
  if (untested.length) raise(risk === "low" ? "medium" : risk, `No test reaches ${untested.join(", ")}: a regression there wouldn't be caught automatically.`);
  if (!known.length) raise("medium", "None of the changed files are in the module graph, so their dependents couldn't be worked out.");
  if (!reasons.length) reasons.push("Few dependents, no sensitive area touched, and tests reach the changed code.");

  const scripts = profile?.packages[0]?.scripts ?? {};
  const plan: TestStep[] = [];
  const direct = tests.filter((t) => t.reason === "same name" || [...(graph.nodes.get(t.file)?.imports ?? [])].some((i) => i.to && changed.includes(i.to)));
  if (direct.length)
    plan.push({
      why: `Fastest signal: the ${direct.length} test file(s) that test the changed code directly.`,
      command: testCommandFor(
        direct.map((t) => t.file),
        profile,
      ),
      status: "planned",
    });
  const wider = tests.filter((t) => !direct.includes(t));
  if (wider.length)
    plan.push({
      why: `Then the ${wider.length} test file(s) that reach it through other modules.`,
      command: testCommandFor(
        wider.map((t) => t.file),
        profile,
      ),
      status: "planned",
    });
  if (untested.length)
    plan.push({ why: `Write a test for ${untested.slice(0, 3).join(", ")} first (it has none), reproducing the behaviour you're about to change.`, command: null, status: "planned" });
  const typecheck = Object.keys(scripts).find((s) => /^(typecheck|type-check|tsc)$/.test(s));
  if (typecheck) plan.push({ why: "Type check: catches callers broken by a changed signature or shape.", command: `npm run ${typecheck}`, status: "planned" });
  if (scripts.lint) plan.push({ why: "Lint.", command: "npm run lint", status: "planned" });
  if (risk !== "low" || affected.length > 20)
    plan.push({ why: `Full test suite: the change is ${risk} risk (${reasons[0]}).`, command: profile?.tests.command ?? null, status: profile?.tests.command ? "planned" : "unavailable" });
  if (scripts.build && concerns.some((c) => /dependencies|configuration|CI/.test(c)))
    plan.push({ why: "Production build: dependency and configuration changes often only fail at build time.", command: "npm run build", status: "planned" });
  if (entryPoints.length)
    plan.push({
      why: `Check by hand (or with end-to-end tests) the entry points that reach this code: ${entryPoints.slice(0, 5).join(", ")}${entryPoints.length > 5 ? `, and ${entryPoints.length - 5} more` : ""}.`,
      command: null,
      status: "planned",
    });
  if (!profile?.tests.command && !tests.length) plan.push({ why: "No test setup was found in the repository, so nothing here can be verified automatically.", command: null, status: "unavailable" });

  const rollback: string[] = [];
  if (risk === "high") {
    rollback.push("Ship it as its own commit/PR so it can be reverted alone.");
    if (concerns.some((c) => c.includes("database")))
      rollback.push("Back up the affected tables and write (and test) the down-migration before running the migration; keep the old columns until the new code has run in production.");
    if (concerns.some((c) => c.includes("dependencies"))) rollback.push("Keep the previous lockfile: reverting package.json and the lockfile together restores the old versions exactly.");
    if (concerns.some((c) => c.includes("authentication")))
      rollback.push("Deploy where you can roll back instantly (e.g. promote the previous deployment), and test sign-in, sign-out and a forbidden action right after release.");
    if (concerns.some((c) => c.includes("CI"))) rollback.push("Test the pipeline change on a branch before merging.");
  }

  return {
    changed: changed.map((c) => ({
      file: c,
      known: graph.nodes.has(c),
      directDependents: graph.dependents.get(c)?.size ?? 0,
      exports: (graph.nodes.get(c)?.exports ?? []).map((e) => e.name).slice(0, 20),
    })),
    affected: affected.slice(0, 200),
    affectedTotal: affected.length,
    entryPoints: entryPoints.slice(0, 60),
    tests: tests.slice(0, 60),
    untested,
    concerns,
    risk,
    riskReasons: reasons,
    plan,
    rollback,
    limits,
  };
}

/** Folder-level view of the affected files, for a compact summary. */
export function byFolder(files: string[]): { dir: string; files: number }[] {
  const m = new Map<string, number>();
  for (const f of files) m.set(dirOf(f) || ".", (m.get(dirOf(f) || ".") ?? 0) + 1);
  return [...m.entries()].map(([dir, n]) => ({ dir, files: n })).sort((a, b) => b.files - a.files);
}
