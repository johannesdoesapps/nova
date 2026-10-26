/**
 * Preparing a Code project for publishing: which files go out, what kind of site it is, and what's wrong with it.
 * Pure functions (no network), shared by the publish API and its tests.
 *
 * - A plain site needs an index.html at the top level; it's served as is.
 * - A project with a package.json and a "build" script is built by the host (Vercel detects the framework, or runs
 *   the build script and serves its output).
 * - Secret and machine files (.env, keys, .git, node_modules, Orbis's effect instructions) never leave Orbis.
 * - Local links to files that don't exist are reported as warnings: the site still publishes, but those images,
 *   styles or pages will be missing.
 */
import { hardSecrets, isSecretPath } from "@/lib/bastion/guards";

export interface SiteFile {
  path: string;
  content: string;
}

export type SiteKind = "static" | "build";

export interface SiteProblem {
  level: "error" | "warning";
  message: string;
}

export interface SitePlan {
  kind: SiteKind;
  /** Vercel's framework preset, or null to serve the files as they are (or run buildCommand). */
  framework: string | null;
  buildCommand: string | null;
  entry: string | null;
  files: SiteFile[];
  /** Files kept back on purpose (secrets, dependencies, Orbis's own notes). */
  excluded: string[];
  problems: SiteProblem[];
  bytes: number;
}

/** What a published site may hold, well inside what the host accepts. */
export const PUBLISH_MAX_FILES = 300;
export const PUBLISH_MAX_BYTES = 8 * 1024 * 1024;

const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|id_rsa[^/]*|id_ed25519[^/]*|[^/]*\.(pem|key|p12|pfx))$/i;
const SKIPPED_DIR = /(^|\/)(\.git|node_modules|\.next|\.vercel|\.orbis|orbis-effects)\//;
const MACHINE_FILE = /(^|\/)(\.DS_Store|Thumbs\.db)$/;

/** Whether a file stays private when the site is published, and why (for the list shown before publishing). */
export function keptPrivate(path: string): string | null {
  if (SECRET_FILE.test(path) || isSecretPath(path)) return "secret or key file";
  if (SKIPPED_DIR.test(path)) return path.includes("orbis-effects/") ? "Orbis's effect instructions" : "dependency or tool folder";
  if (MACHINE_FILE.test(path)) return "system file";
  return null;
}

/** Vercel framework presets for common dependencies, most specific first. */
const FRAMEWORKS: [dep: string, preset: string][] = [
  ["next", "nextjs"],
  ["@sveltejs/kit", "sveltekit"],
  ["nuxt", "nuxtjs"],
  ["astro", "astro"],
  ["@remix-run/react", "remix"],
  ["gatsby", "gatsby"],
  ["react-scripts", "create-react-app"],
  ["@angular/core", "angular"],
  ["vite", "vite"],
];

function readPackage(files: SiteFile[]): { scripts: Record<string, string>; deps: Record<string, string> } | "invalid" | null {
  const pkg = files.find((f) => f.path === "package.json");
  if (!pkg) return null;
  try {
    const j = JSON.parse(pkg.content) as { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    const str = (o: Record<string, unknown> | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"));
    return { scripts: str(j.scripts), deps: { ...str(j.devDependencies), ...str(j.dependencies) } };
  } catch {
    return "invalid";
  }
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{\{|\$\{|<%)/i;

/** Local files an HTML or CSS file points at (src/href/url()), resolved against the file's folder. */
export function localReferences(file: SiteFile): string[] {
  const raw: string[] = [];
  if (/\.html?$/i.test(file.path)) {
    for (const m of file.content.matchAll(/\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) raw.push(m[1] ?? m[2] ?? "");
  }
  if (/\.(css|html?)$/i.test(file.path)) {
    for (const m of file.content.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi)) raw.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  const out = new Set<string>();
  for (let r of raw) {
    r = r.trim();
    if (!r || EXTERNAL.test(r)) continue;
    r = r.split(/[?#]/)[0];
    if (!r) continue;
    let decoded = r;
    try {
      decoded = decodeURIComponent(r);
    } catch {
      /* keep as written */
    }
    const parts = (decoded.startsWith("/") ? [] : dir ? dir.split("/") : []).concat(decoded.replace(/^\/+/, "").split("/"));
    const stack: string[] = [];
    let escaped = false;
    for (const p of parts) {
      if (p === "" || p === ".") continue;
      if (p === "..") {
        if (!stack.pop()) escaped = true;
      } else stack.push(p);
    }
    if (!escaped) out.add(stack.join("/"));
  }
  return [...out];
}

/** Whether a link target exists once published: the file itself, a folder's index.html, or a clean URL (page → page.html). */
function exists(target: string, paths: Set<string>): boolean {
  if (target === "" || paths.has(target)) return true;
  const t = target.replace(/\/$/, "");
  return paths.has(`${t}/index.html`) || paths.has(`${t}.html`) || (t === "" && paths.has("index.html"));
}

export function planSite(all: SiteFile[]): SitePlan {
  const problems: SiteProblem[] = [];
  const excluded = all.filter((f) => keptPrivate(f.path)).map((f) => f.path);
  const kept = all.filter((f) => !keptPrivate(f.path));
  const bytes = kept.reduce((n, f) => n + new TextEncoder().encode(f.content).length, 0);

  const pkg = readPackage(kept);
  let kind: SiteKind = "static";
  let framework: string | null = null;
  let buildCommand: string | null = null;
  if (pkg === "invalid") problems.push({ level: "error", message: "package.json isn't valid JSON, so the site can't be built. Fix it, or remove it if this is a plain HTML site." });
  else if (pkg?.scripts.build) {
    kind = "build";
    framework = FRAMEWORKS.find(([dep]) => dep in pkg.deps)?.[1] ?? null;
    // Without a known framework the host runs the project's own build script and serves what it outputs.
    if (!framework) buildCommand = "npm run build";
  }

  const paths = new Set(kept.map((f) => f.path));
  const entry = kind === "static" ? (paths.has("index.html") ? "index.html" : null) : "package.json";
  if (kind === "static" && !entry) {
    const pages = kept.filter((f) => /\.html?$/i.test(f.path)).map((f) => f.path);
    problems.push({
      level: "error",
      message: pages.length
        ? `There's no index.html at the top of the project, so the site would have no home page. Rename the main page (${pages.slice(0, 3).join(", ")}) to index.html, or ask the agent to.`
        : "There's no index.html (and no package.json with a build script), so there's nothing to publish yet. Ask the agent to build the site first.",
    });
  }
  if (!kept.length) problems.push({ level: "error", message: "The project has no files to publish." });
  if (kept.length > PUBLISH_MAX_FILES) problems.push({ level: "error", message: `The site has ${kept.length} files; publishing takes at most ${PUBLISH_MAX_FILES}.` });
  if (bytes > PUBLISH_MAX_BYTES) problems.push({ level: "error", message: `The site is ${(bytes / 1048576).toFixed(1)} MB; publishing takes at most ${PUBLISH_MAX_BYTES / 1048576} MB.` });

  if (kind === "static") {
    const missing = new Map<string, string>();
    for (const f of kept) for (const ref of localReferences(f)) if (!exists(ref, paths) && !missing.has(ref)) missing.set(ref, f.path);
    for (const [ref, from] of [...missing].slice(0, 8)) problems.push({ level: "warning", message: `${from} links to ${ref}, which isn't in the project, so it will be missing on the live site.` });
    if (missing.size > 8) problems.push({ level: "warning", message: `…and ${missing.size - 8} more missing files.` });
  }
  // A credential written into a page or script would be readable by anyone once it's live.
  for (const f of kept) {
    const found = hardSecrets(f.content);
    const serious = found.filter((k) => k !== "Google API key");
    if (serious.length) problems.push({ level: "error", message: `${f.path} contains what looks like a ${serious.join(" and ")}. Anyone could read it on the live site, so publishing is blocked. Remove it (keep keys on a server, never in the website's files).` });
    else if (found.length) problems.push({ level: "warning", message: `${f.path} contains a Google API key. That's normal for maps and similar browser features, but restrict the key to your site's address in Google Cloud.` });
  }
  if (excluded.length) problems.push({ level: "warning", message: `${excluded.length} file${excluded.length === 1 ? " stays" : "s stay"} private and won't be published: ${excluded.slice(0, 4).join(", ")}${excluded.length > 4 ? ", …" : ""}.` });

  return { kind, framework, buildCommand, entry, files: kept, excluded, problems, bytes };
}

/** A fingerprint of what would be published, to tell whether the live site is up to date. */
export async function siteFingerprint(files: SiteFile[]): Promise<string> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const enc = new TextEncoder();
  const parts = sorted.flatMap((f) => [enc.encode(`${f.path}\u0000${enc.encode(f.content).length}\u0000`), enc.encode(f.content)]);
  const buf = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    buf.set(p, o);
    o += p.length;
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
  return [...hash].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The part of a project's id that names its site, so a renamed project keeps the same address. */
export const siteKey = (projectId: string) => projectId.replace(/-/g, "").slice(0, 12).toLowerCase();

/** The host project's name (and so its address): the project's name, then its key. Lowercase, letters, digits and dashes. */
export function siteProjectName(projectName: string, projectId: string): string {
  const slug = projectName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${slug || "site"}-${siteKey(projectId)}`;
}

/** The address to share: the shortest production alias on the host's domain, else the deployment's own URL. */
export function publicUrl(aliases: readonly string[] | undefined, deploymentUrl: string, projectName: string): string {
  const own = (aliases ?? []).filter((a) => a.endsWith(".vercel.app"));
  const exact = own.find((a) => a === `${projectName}.vercel.app`);
  const pick = exact ?? [...own].sort((a, b) => a.length - b.length)[0] ?? deploymentUrl;
  return `https://${pick.replace(/^https?:\/\//, "")}`;
}
