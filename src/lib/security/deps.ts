import { fingerprint, type FindingDraft, type Severity } from "./types";
import type { SourceFile } from "./code-rules";

/** Dependency checks against the OSV.dev database (npm and PyPI). */

export interface Pkg {
  name: string;
  version: string;
  ecosystem: "npm" | "PyPI";
  dev: boolean;
  /** True when the version came from a range in a manifest, not a lockfile. */
  approximate: boolean;
  file: string;
}

export function parseManifests(files: SourceFile[]): { packages: Pkg[]; sources: string[]; notes: string[] } {
  const byKey = new Map<string, Pkg>();
  const sources: string[] = [];
  const notes: string[] = [];
  const add = (p: Pkg) => {
    const k = `${p.ecosystem}:${p.name}@${p.version}`;
    const prev = byKey.get(k);
    if (!prev || (prev.approximate && !p.approximate) || (prev.dev && !p.dev)) byKey.set(k, p);
  };
  const locked = new Set<string>();
  for (const f of files) {
    const base = f.path.split("/").pop()!;
    try {
      if (base === "package-lock.json") {
        const j = JSON.parse(f.content) as { packages?: Record<string, { version?: string; dev?: boolean; link?: boolean }>; dependencies?: Record<string, V1Dep> };
        sources.push(f.path);
        if (j.packages) {
          for (const [key, v] of Object.entries(j.packages)) {
            if (!key || !v.version || v.link) continue;
            const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
            add({ name, version: v.version, ecosystem: "npm", dev: !!v.dev, approximate: false, file: f.path });
          }
        } else if (j.dependencies) walkV1(j.dependencies, f.path, add);
        locked.add(dirOf(f.path));
      } else if (base === "yarn.lock") {
        sources.push(f.path);
        const re = /^"?(@?[^@\s"]+)@[^\n]*:\n(?:[ \t]+[^\n]*\n)*?[ \t]+version:? "?([^"\s]+)"?/gm;
        for (const m of f.content.matchAll(re)) add({ name: m[1]!, version: m[2]!, ecosystem: "npm", dev: false, approximate: false, file: f.path });
        locked.add(dirOf(f.path));
      } else if (/^requirements.*\.txt$/.test(base)) {
        sources.push(f.path);
        for (const line of f.content.split("\n")) {
          const m = /^\s*([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9_.+-]+)/.exec(line);
          if (m) add({ name: m[1]!, version: m[2]!, ecosystem: "PyPI", dev: false, approximate: false, file: f.path });
        }
      } else if (base === "pnpm-lock.yaml") {
        notes.push(`${f.path}: pnpm lockfiles aren't supported yet; upload package-lock.json or yarn.lock instead.`);
      }
    } catch {
      notes.push(`${f.path} couldn't be parsed and was skipped.`);
    }
  }
  // package.json only where no lockfile sits beside it.
  for (const f of files) {
    if (f.path.split("/").pop() !== "package.json" || locked.has(dirOf(f.path))) continue;
    try {
      const j = JSON.parse(f.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      let any = false;
      for (const [deps, dev] of [[j.dependencies, false], [j.devDependencies, true]] as const) {
        for (const [name, range] of Object.entries(deps ?? {})) {
          const m = /^[\^~=v]?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(range.trim());
          if (!m) continue;
          any = true;
          add({ name, version: m[1]!, ecosystem: "npm", dev, approximate: /^[\^~]/.test(range.trim()), file: f.path });
        }
      }
      if (any) {
        sources.push(f.path);
        notes.push(`${f.path} has no lockfile beside it, so versions were read from ranges (the lowest version in each range). Upload package-lock.json for exact results.`);
      }
    } catch {
      notes.push(`${f.path} couldn't be parsed and was skipped.`);
    }
  }
  return { packages: [...byKey.values()], sources, notes };
}

interface V1Dep {
  version?: string;
  dev?: boolean;
  dependencies?: Record<string, V1Dep>;
}
function walkV1(deps: Record<string, V1Dep>, file: string, add: (p: Pkg) => void) {
  for (const [name, d] of Object.entries(deps)) {
    if (d.version && /^\d/.test(d.version)) add({ name, version: d.version, ecosystem: "npm", dev: !!d.dev, approximate: false, file });
    if (d.dependencies) walkV1(d.dependencies, file, add);
  }
}
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { events?: { introduced?: string; fixed?: string }[] }[] }[];
  references?: { type?: string; url?: string }[];
}

const SEV: Record<string, Severity> = { CRITICAL: "critical", HIGH: "high", MODERATE: "medium", MEDIUM: "medium", LOW: "low" };
const DOWN: Record<Severity, Severity> = { critical: "high", high: "medium", medium: "low", low: "low", info: "info" };

export async function checkDependencies(
  packages: Pkg[],
  asset: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; maxDetails?: number } = {},
): Promise<{ findings: FindingDraft[]; queried: number; vulnerable: number; detailsSkipped: number }> {
  const f = opts.fetchImpl ?? fetch;
  const list = packages.slice(0, 3000);
  const hits: { pkg: Pkg; ids: string[] }[] = [];
  for (let i = 0; i < list.length; i += 1000) {
    const chunk = list.slice(i, i + 1000);
    const res = await f("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })) }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`OSV.dev returned HTTP ${res.status}`);
    const j = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
    (j.results ?? []).forEach((r, k) => {
      if (r.vulns?.length) hits.push({ pkg: chunk[k]!, ids: r.vulns.map((v) => v.id) });
    });
  }
  const ids = [...new Set(hits.flatMap((h) => h.ids))];
  const max = opts.maxDetails ?? 60;
  const details = new Map<string, OsvVuln>();
  for (let i = 0; i < Math.min(ids.length, max); i += 10) {
    const batch = ids.slice(i, Math.min(i + 10, max));
    const got = await Promise.all(
      batch.map(async (id) => {
        try {
          const r = await f(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, { signal: opts.signal });
          return r.ok ? ((await r.json()) as OsvVuln) : null;
        } catch {
          return null;
        }
      }),
    );
    got.forEach((v) => v && details.set(v.id, v));
  }

  const findings: FindingDraft[] = [];
  for (const { pkg, ids: vids } of hits) {
    // Prefer GHSA ids and drop aliases of the same advisory.
    const seen = new Set<string>();
    for (const id of [...vids].sort((a, b) => Number(b.startsWith("GHSA")) - Number(a.startsWith("GHSA")))) {
      if (seen.has(id)) continue;
      const v = details.get(id);
      [id, ...(v?.aliases ?? [])].forEach((a) => seen.add(a));
      let severity: Severity = v?.database_specific?.severity ? (SEV[v.database_specific.severity.toUpperCase()] ?? "medium") : "medium";
      const fixed = v?.affected
        ?.filter((a) => a.package?.name === pkg.name)
        .flatMap((a) => a.ranges ?? [])
        .flatMap((r) => r.events ?? [])
        .map((e) => e.fixed)
        .find(Boolean);
      if (pkg.dev) severity = DOWN[severity];
      const cve = v?.aliases?.find((a) => a.startsWith("CVE-"));
      findings.push({
        agent: "code_guardian",
        ruleId: "deps.osv",
        fingerprint: fingerprint("code_guardian", "deps.osv", asset, pkg.ecosystem, pkg.name, id),
        title: `${pkg.name} ${pkg.version}: ${v?.summary ?? id}`.slice(0, 300),
        description: (v?.details ?? v?.summary ?? `Listed in OSV as ${id}. Details could not be loaded.`).slice(0, 2000),
        severity,
        confidence: pkg.approximate ? "tentative" : "confirmed",
        rationale: [
          v?.database_specific?.severity ? `Advisory severity: ${v.database_specific.severity}.` : "No severity published in OSV; defaulted to medium.",
          pkg.dev ? "Development-only dependency, so lowered one level." : "",
          pkg.approximate ? "Version taken from a range in package.json; the installed version may differ." : "",
          "Whether your code actually uses the vulnerable function isn't checked.",
        ]
          .filter(Boolean)
          .join(" "),
        asset,
        location: `${pkg.file} → ${pkg.name}@${pkg.version}`,
        evidence: [{ source: `OSV.dev ${id}${cve ? ` (${cve})` : ""}`, detail: `${pkg.ecosystem} ${pkg.name}@${pkg.version} is listed as affected.${fixed ? ` Fixed in ${fixed}.` : ""}` }],
        evidenceSource: "osv.dev",
        remediation: fixed ? `Upgrade ${pkg.name} to ${fixed} or later, then re-run the audit.` : `No fixed version is listed. Check the advisory for workarounds or replace ${pkg.name}.`,
        references: [`https://osv.dev/vulnerability/${id}`],
      });
    }
  }
  return { findings, queried: list.length, vulnerable: hits.length, detailsSkipped: Math.max(0, ids.length - max) };
}
