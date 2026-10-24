import { redactAll } from "../../secrets";
import { fingerprint, type FindingDraft } from "../types";
import { NODE_BUILTINS, type ModuleGraph } from "./graph";
import { readPackageJsons, type PackageJson } from "./profile";
import { isRange, parseVersion, rangeMajors, satisfies } from "./semver";
import { baseOf, dirOf, isTestPath, type SourceFile } from "./source";

/**
 * Dependency compatibility (security advisories stay with the OSV check): whether package.json and the
 * lockfile agree (`npm ci` fails when they don't), imports of packages that aren't declared, declared packages
 * nothing uses, peer-dependency conflicts and engine requirements recorded in the lockfile, deprecated packages,
 * and versions that can't be reproduced. Facts come from package.json and package-lock.json only; nothing is
 * looked up online, and no upgrade is ever made.
 */

interface LockEntry {
  version?: string;
  dev?: boolean;
  optional?: boolean;
  peer?: boolean;
  deprecated?: string;
  engines?: Record<string, string> | string[];
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  link?: boolean;
  dependencies?: Record<string, string>;
}

export interface CompatSummary {
  manifests: string[];
  lockfiles: string[];
  direct: number;
  installed: number | null;
  /** Packages installed in more than one version. */
  duplicates: { name: string; versions: string[] }[];
  checked: string[];
  notChecked: string[];
}

const deps = (p: PackageJson) => ({ ...p.optionalDependencies, ...p.peerDependencies, ...p.devDependencies, ...p.dependencies });

/** Packages a framework or tool loads without an import statement (never reported as unused); react is used by the JSX runtime without an import. */
const IMPLICIT =
  /^(@types\/|typescript$|eslint|@eslint\/|prettier|@typescript-eslint\/|postcss|autoprefixer|tailwindcss$|@tailwindcss\/|react$|react-dom$|preact$|sharp$|@next\/|husky$|lint-staged$|vitest$|jest$|@vitest\/|ts-node$|tsx$|nodemon$|concurrently$|cross-env$|dotenv-cli$|rimraf$|npm-run-all|@playwright\/|playwright$|cypress$|vite$|@vitejs\/|webpack|babel|@babel\/|@swc\/|turbo$|supabase$|vercel$|wrangler$|serve$|http-server$)/;

/** Virtual or framework-provided specifiers that aren't npm packages. */
const VIRTUAL = /^(virtual:|astro:|bun:|\$app\/|\$env\/|\$lib|~\/|#|@\/|server-only$|client-only$)/;

function finding(asset: string, ruleId: string, key: string, f: Omit<FindingDraft, "agent" | "ruleId" | "fingerprint" | "asset" | "evidenceSource" | "references">): FindingDraft {
  return { agent: "code_guardian", ruleId, fingerprint: fingerprint("code_guardian", ruleId, asset, key), asset, evidenceSource: "orbis:code-guardian", references: [], ...f };
}

export function checkCompatibility(files: SourceFile[], graph: ModuleGraph, asset: string): { findings: FindingDraft[]; summary: CompatSummary } {
  const findings: FindingDraft[] = [];
  const pkgs = readPackageJsons(files);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const locks = files.filter((f) => baseOf(f.path) === "package-lock.json");
  const summary: CompatSummary = {
    manifests: pkgs.map((p) => p.path),
    lockfiles: [...locks.map((l) => l.path), ...files.filter((f) => /(^|\/)(yarn\.lock|pnpm-lock\.yaml)$/.test(f.path)).map((f) => f.path)],
    direct: 0,
    installed: null,
    duplicates: [],
    checked: [],
    notChecked: [],
  };
  if (!pkgs.length) {
    summary.notChecked.push("No package.json found: JavaScript dependency checks didn't run.");
    return { findings, summary };
  }
  for (const f of files)
    if (baseOf(f.path) === "package.json" && !pkgs.some((p) => p.path === f.path))
      findings.push(
        finding(asset, "compat.invalid-manifest", f.path, {
          title: `${f.path} isn't valid JSON`,
          description: "npm can't read this package.json, so install, build and every script fail.",
          severity: "high",
          confidence: "confirmed",
          rationale: "JSON.parse failed on the file.",
          location: f.path,
          evidence: [{ source: f.path, detail: f.content.slice(0, 200) }],
          remediation: "Fix the JSON syntax (a trailing comma or a missing quote is the usual cause) and run npm install.",
        }),
      );

  // The package.json that governs a file: the nearest one above it.
  const owner = (path: string) => pkgs.filter((p) => !dirOf(p.path) || path.startsWith(`${dirOf(p.path)}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  const rootDeclared = new Set(pkgs.flatMap((p) => Object.keys(deps(p.pkg))));
  summary.direct = Object.keys(deps(pkgs[0]!.pkg)).length;

  // --- lockfile agreement, peers, engines, deprecations (package-lock v2/v3) ---
  for (const lockFile of locks) {
    const manifest = pkgs.find((p) => dirOf(p.path) === dirOf(lockFile.path));
    let lock: { lockfileVersion?: number; packages?: Record<string, LockEntry>; dependencies?: Record<string, LockEntry> };
    try {
      lock = JSON.parse(lockFile.content);
    } catch {
      findings.push(
        finding(asset, "compat.invalid-lockfile", lockFile.path, {
          title: `${lockFile.path} isn't valid JSON`,
          description: "npm ci refuses to install from a corrupt lockfile; installs fall back to resolving versions afresh (non-reproducible builds).",
          severity: "high",
          confidence: "confirmed",
          rationale: "JSON.parse failed.",
          location: lockFile.path,
          evidence: [{ source: lockFile.path, detail: "Unparseable JSON" }],
          remediation: "Regenerate it with npm install on a clean checkout (review the diff before committing).",
        }),
      );
      continue;
    }
    if (!lock.packages) {
      summary.notChecked.push(`${lockFile.path} is lockfileVersion ${lock.lockfileVersion ?? 1}: peer, engine and deprecation data aren't recorded in that format.`);
      continue;
    }
    summary.checked.push(`${lockFile.path} (lockfileVersion ${lock.lockfileVersion ?? "?"})`);
    const top = new Map<string, LockEntry>();
    const versions = new Map<string, Set<string>>();
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key || entry.link) continue;
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      if (key === `node_modules/${name}`) top.set(name, entry);
      if (entry.version) (versions.get(name) ?? versions.set(name, new Set()).get(name)!).add(entry.version);
    }
    summary.installed = (summary.installed ?? 0) + Object.keys(lock.packages).length - 1;
    summary.duplicates.push(
      ...[...versions.entries()]
        .filter(([, v]) => v.size > 1)
        .map(([name, v]) => ({ name, versions: [...v].sort() }))
        .sort((a, b) => b.versions.length - a.versions.length)
        .slice(0, 10),
    );

    if (manifest) {
      const drift: string[] = [];
      for (const [name, range] of Object.entries({ ...manifest.pkg.dependencies, ...manifest.pkg.devDependencies, ...manifest.pkg.optionalDependencies })) {
        const real = range.startsWith("npm:") ? range.slice(range.lastIndexOf("@") + 1) : range;
        if (!isRange(real)) continue;
        const inst = top.get(name);
        if (!inst?.version) {
          if (!manifest.pkg.optionalDependencies?.[name]) drift.push(`${name}@${range} is in package.json but not in the lockfile`);
        } else if (satisfies(inst.version, real) === false) drift.push(`${name}: package.json wants ${range}, lockfile has ${inst.version}`);
      }
      const rootEntry = lock.packages[""];
      if (rootEntry?.dependencies)
        for (const name of Object.keys(rootEntry.dependencies)) if (!deps(manifest.pkg)[name]) drift.push(`${name} is in the lockfile's dependency list but no longer in package.json`);
      if (drift.length)
        findings.push(
          finding(asset, "compat.lockfile-drift", lockFile.path, {
            title: `package.json and ${baseOf(lockFile.path)} disagree (${drift.length} package${drift.length === 1 ? "" : "s"})`,
            description: `When they disagree, \`npm ci\` (what CI and most deploys run) stops with an error, and \`npm install\` silently resolves different versions than the ones tested. ${drift.slice(0, 8).join("; ")}${drift.length > 8 ? `; and ${drift.length - 8} more` : ""}.`,
            severity: "high",
            confidence: "confirmed",
            rationale: "Compared every declared range with the version recorded in the lockfile.",
            location: lockFile.path,
            evidence: drift.slice(0, 6).map((d) => ({ source: `${manifest.path} ↔ ${lockFile.path}`, detail: d })),
            remediation:
              "Run `npm install` (not ci) on a clean checkout so the lockfile matches package.json, review the version changes in the lockfile diff, run the tests, and commit both files together.",
          }),
        );
    }

    // Peer dependencies: an installed package that expects a different version of a package you have.
    const peerIssues = new Map<string, { range: string; dependents: string[]; installed: string }>();
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key.startsWith("node_modules/") || key.split("node_modules/").length > 2 || !entry.peerDependencies) continue;
      const name = key.slice("node_modules/".length);
      for (const [peer, range] of Object.entries(entry.peerDependencies)) {
        if (entry.peerDependenciesMeta?.[peer]?.optional) continue;
        const inst = top.get(peer)?.version;
        if (!inst || !isRange(range) || satisfies(inst, range) !== false) continue;
        const k = `${peer}@${inst}`;
        const cur = peerIssues.get(k) ?? { range, dependents: [], installed: inst };
        cur.dependents.push(`${name} (wants ${range})`);
        peerIssues.set(k, cur);
      }
    }
    for (const [k, p] of peerIssues) {
      const peer = k.slice(0, k.lastIndexOf("@"));
      const direct = p.dependents.filter((d) => rootDeclared.has(d.slice(0, d.indexOf(" ("))));
      findings.push(
        finding(asset, "compat.peer-conflict", k, {
          title: `${p.dependents.length} package${p.dependents.length === 1 ? "" : "s"} expect a different ${peer} than the ${p.installed} installed`,
          description: `Peer dependencies declare which versions a package was built and tested against. These don't include ${peer} ${p.installed}: ${p.dependents.slice(0, 6).join(", ")}${p.dependents.length > 6 ? ` and ${p.dependents.length - 6} more` : ""}. They may work, or fail at runtime in ways their tests never covered (often when ${peer} changed a major version, e.g. expects ${rangeMajors(p.range) || p.range}).`,
          severity: direct.length ? "medium" : "low",
          confidence: "confirmed",
          rationale: `Read from each package's peerDependencies in the lockfile${direct.length ? `; ${direct.length} of them are your direct dependencies` : "; all are indirect dependencies"}.`,
          location: lockFile.path,
          evidence: p.dependents.slice(0, 5).map((d) => ({ source: lockFile.path, detail: `${d}; installed ${peer} ${p.installed}` })),
          remediation: `Check each package's changelog for a release that supports ${peer} ${p.installed} and upgrade to it (one at a time, running the tests after each). If none exists, test the features that use it, or pin ${peer} to a compatible version until it does. Don't use --force/--legacy-peer-deps to hide the conflict without testing.`,
        }),
      );
    }

    // Engines: a dependency that needs a newer Node than the project declares.
    const projectNode = manifest?.pkg.engines?.node ?? files.find((f) => /(^|\/)\.(nvmrc|node-version)$/.test(f.path))?.content.trim();
    const projectMin = projectNode ? /(\d+)(?:\.(\d+))?/.exec(projectNode) : null;
    if (projectMin) {
      const floor = `${projectMin[1]}.${projectMin[2] ?? 0}.0`;
      const need: string[] = [];
      let runtime = 0;
      for (const [name, entry] of top) {
        const range = !Array.isArray(entry.engines) ? entry.engines?.node : undefined;
        if (range && isRange(range) && satisfies(floor, range) === false && !entry.optional) {
          need.push(`${name}@${entry.version}${entry.dev ? " (dev)" : ""} needs node ${range}`);
          if (!entry.dev) runtime++;
        }
      }
      if (need.length)
        findings.push(
          finding(asset, "compat.engine-mismatch", `${lockFile.path}:node`, {
            title: `${need.length} installed package${need.length === 1 ? "" : "s"} require${need.length === 1 ? "s" : ""} a newer Node.js than the project allows (${projectNode})`,
            description: `The project says it runs on Node ${projectNode}, but ${need.slice(0, 6).join("; ")}${need.length > 6 ? ` and ${need.length - 6} more` : ""}. On the oldest allowed Node these can fail to install (with engine-strict) or crash at runtime on missing APIs.`,
            severity: runtime ? "medium" : "low",
            confidence: "firm",
            rationale: `Compared Node ${floor} (the lowest version the project allows) with each package's engines.node in the lockfile. ${runtime ? `${runtime} of them are needed at runtime.` : "All are development tools (tests, build), so production isn't affected."}`,
            location: manifest?.path ?? lockFile.path,
            evidence: need.slice(0, 5).map((d) => ({ source: lockFile.path, detail: d })),
            remediation: "Raise the project's Node requirement (engines.node, .nvmrc, CI and hosting settings together) or pin those packages to versions that support your Node version.",
          }),
        );
    }

    const deprecated = [...top.entries()].filter(([, e]) => e.deprecated && !e.dev).map(([n, e]) => ({ name: n, version: e.version, msg: e.deprecated!, direct: rootDeclared.has(n) }));
    for (const d of deprecated.filter((x) => x.direct).slice(0, 10))
      findings.push(
        finding(asset, "compat.deprecated", `${d.name}`, {
          title: `${d.name} ${d.version} is deprecated`,
          description: `Its maintainers marked it deprecated: "${d.msg.slice(0, 300)}". Deprecated packages stop receiving fixes, including for compatibility with new Node and framework versions.`,
          severity: "low",
          confidence: "confirmed",
          rationale: "Deprecation notice recorded in the lockfile when it was installed.",
          location: lockFile.path,
          evidence: [{ source: lockFile.path, detail: `${d.name}@${d.version}: ${d.msg.slice(0, 200)}` }],
          remediation: "Follow the replacement the notice suggests (or a maintained alternative), migrate in a separate change, and run the tests.",
        }),
      );
    if (deprecated.length > deprecated.filter((x) => x.direct).length)
      summary.checked.push(`${deprecated.length - deprecated.filter((x) => x.direct).length} indirect dependencies are deprecated (not reported individually).`);
  }
  if (!locks.length) summary.notChecked.push("No package-lock.json: lockfile agreement, peer and engine checks didn't run (yarn.lock and pnpm-lock.yaml aren't analysed for these).");

  // --- imports vs declarations ---
  const installedTop = new Set<string>();
  for (const l of locks)
    try {
      for (const key of Object.keys((JSON.parse(l.content) as { packages?: Record<string, unknown> }).packages ?? {}))
        if (key.startsWith("node_modules/") && key.split("node_modules/").length === 2) installedTop.add(key.slice(13));
    } catch {
      /* reported above */
    }
  const missing = new Map<string, { files: { path: string; line: number }[]; phantom: boolean; testOnly: boolean }>();
  const used = new Set<string>();
  for (const n of graph.nodes.values()) {
    if (n.lang === "py") continue;
    const own = owner(n.path);
    const declared = new Set([...Object.keys(deps(own?.pkg ?? {})), ...Object.keys(deps(pkgs[0]!.pkg))]);
    for (const i of n.imports) {
      if (!i.pkg || NODE_BUILTINS.has(i.pkg.replace(/^node:/, "")) || i.spec.startsWith("node:") || VIRTUAL.test(i.spec)) continue;
      used.add(i.pkg);
      // A workspace package referencing a sibling by name is fine.
      if (declared.has(i.pkg) || pkgs.some((p) => p.pkg.name === i.pkg) || i.kind === "type") continue;
      const m = missing.get(i.pkg) ?? { files: [], phantom: installedTop.has(i.pkg), testOnly: true };
      m.files.push({ path: n.path, line: i.line });
      if (!n.test && !isTestPath(n.path)) m.testOnly = false;
      missing.set(i.pkg, m);
    }
  }
  for (const [name, m] of missing) {
    if (m.testOnly && m.phantom) continue;
    findings.push(
      finding(asset, "compat.undeclared-import", name, {
        title: m.phantom ? `${name} is imported but not declared (it only works because another package installs it)` : `${name} is imported but isn't a dependency`,
        description: m.phantom
          ? `Your code imports ${name}, which isn't in package.json; it's present only as a dependency of something else. If that package drops or changes it, installs keep succeeding but this import breaks.`
          : `Your code imports ${name}, which isn't in package.json${locks.length ? " or the lockfile" : ""}. A clean install (CI, a new machine, a deploy) won't have it, so the build or the first request that loads the file fails.`,
        severity: m.phantom ? "medium" : m.testOnly ? "low" : "high",
        confidence: "firm",
        rationale: `Compared bare imports with the nearest package.json${m.testOnly ? " (only test files import it)" : ""}.`,
        location: `${m.files[0]!.path}:${m.files[0]!.line}`,
        evidence: m.files.slice(0, 4).map((x) => ({ source: `${x.path}:${x.line}`, detail: redactAll((byPath.get(x.path)?.content.split("\n")[x.line - 1] ?? "").trim().slice(0, 200)) })),
        remediation: `Add it explicitly: \`npm install ${name}${m.testOnly ? " --save-dev" : ""}\` (pin the version that's installed now to avoid surprises), then run the build and tests.`,
      }),
    );
  }

  const allText = files
    .filter((f) => !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f.path) && baseOf(f.path) !== "package.json")
    .map((f) => f.content)
    .join("\n");
  for (const { path, pkg } of pkgs) {
    const scripts = Object.values(pkg.scripts ?? {}).join(" ");
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (used.has(name) || IMPLICIT.test(name) || scripts.includes(name) || allText.includes(`"${name}`) || allText.includes(`'${name}`) || allText.includes(name)) continue;
      findings.push(
        finding(asset, "compat.unused-dependency", `${path}:${name}`, {
          title: `${name} is a dependency but nothing in the repository uses it`,
          description: `No import, script or configuration file mentions ${name}. Unused dependencies add install time, bundle risk and upgrade work, and get updated for no benefit.`,
          severity: "info",
          confidence: "tentative",
          rationale: "Searched every file for the package name. Packages loaded by name at runtime (plugins, CLIs run outside package.json) can't be seen this way.",
          location: path,
          evidence: [{ source: path, detail: `"${name}": "${pkg.dependencies![name]}"` }],
          remediation: `Confirm it isn't loaded indirectly, then \`npm uninstall ${name}\` and run the build and tests.`,
        }),
      );
    }
    const both = Object.keys(pkg.dependencies ?? {}).filter((n) => pkg.devDependencies?.[n]);
    if (both.length)
      findings.push(
        finding(asset, "compat.declared-twice", `${path}:dup`, {
          title: `${both.length} package${both.length === 1 ? " is" : "s are"} in both dependencies and devDependencies`,
          description: `${both.join(", ")} — npm uses one entry and ignores the other, so the two ranges can silently disagree.`,
          severity: "low",
          confidence: "confirmed",
          rationale: "Read from package.json.",
          location: path,
          evidence: both.slice(0, 5).map((n) => ({ source: path, detail: `${n}: "${pkg.dependencies![n]}" / "${pkg.devDependencies![n]}"` })),
          remediation: "Keep each package in one list (dependencies if it's needed at runtime).",
        }),
      );
    const loose = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies }).filter(([, r]) => /^(\*|latest|x|)$/.test(r.trim()) || /^(git|https?):|github:/.test(r));
    if (loose.length)
      findings.push(
        finding(asset, "compat.unpinned", `${path}:loose`, {
          title: `${loose.length} dependenc${loose.length === 1 ? "y has" : "ies have"} no fixed version`,
          description: `${loose.map(([n, r]) => `${n}: "${r}"`).join(", ")}. "*", "latest" and branch URLs install whatever is newest at install time, so two installs of the same commit can differ.`,
          severity: "low",
          confidence: "confirmed",
          rationale: "Read from package.json.",
          location: path,
          evidence: loose.slice(0, 5).map(([n, r]) => ({ source: path, detail: `${n}: "${r}"` })),
          remediation: "Use a semver range (or a commit hash for git dependencies) and rely on the lockfile.",
        }),
      );
  }
  const nodeRange = pkgs[0]!.pkg.engines?.node;
  const nvmrc = files.find((f) => /(^|\/)\.(nvmrc|node-version)$/.test(f.path));
  const nvmVer = nvmrc ? /^v?(\d+(?:\.\d+){0,2})/.exec(nvmrc.content.trim())?.[1] : null;
  if (nodeRange && nvmVer && isRange(nodeRange)) {
    const full = nvmVer.split(".").concat(["0", "0"]).slice(0, 3).join(".");
    if (parseVersion(full) && satisfies(full, nodeRange) === false)
      findings.push(
        finding(asset, "compat.node-version-mismatch", "nvmrc", {
          title: `${nvmrc!.path} (Node ${nvmVer}) doesn't satisfy engines.node (${nodeRange})`,
          description: "Developers and tools that read .nvmrc run a Node version the project says it doesn't support, so behaviour differs between local machines, CI and production.",
          severity: "low",
          confidence: "confirmed",
          rationale: "Compared the two files.",
          location: nvmrc!.path,
          evidence: [{ source: nvmrc!.path, detail: nvmrc!.content.trim() }],
          remediation: "Make them agree (and match the CI and hosting Node version).",
        }),
      );
  }
  return { findings, summary };
}
