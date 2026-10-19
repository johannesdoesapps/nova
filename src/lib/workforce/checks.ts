import type { CheckDef } from "./types";

/**
 * The only commands the Workforce can run. Checks are derived from the
 * project's package.json scripts; operators can enable/disable them and mark
 * them required, but cannot type arbitrary commands, and models can't add any.
 */
export const INSTALL_COMMAND = ["npm", "ci", "--no-audit", "--no-fund", "--ignore-scripts"];
export const INSTALL_DOMAINS = ["registry.npmjs.org"];
export const BUILD_DOMAINS = ["fonts.googleapis.com", "fonts.gstatic.com"];

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function detectChecks(pkg: PackageJson): CheckDef[] {
  const scripts = pkg.scripts ?? {};
  const hasNext = Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
  const out: CheckDef[] = [];
  const tsScript = ["typecheck", "type-check", "tsc"].find((s) => scripts[s]);
  if (tsScript) out.push({ id: "typecheck", label: "Typecheck", commands: [...(hasNext ? [["npx", "next", "typegen"]] : []), ["npm", "run", tsScript]], required: true, timeoutMs: 300_000 });
  if (scripts.lint) out.push({ id: "lint", label: "Lint", commands: [["npm", "run", "lint"]], required: true, timeoutMs: 300_000 });
  if (scripts.test && !/no test specified/.test(scripts.test)) out.push({ id: "test", label: "Tests", commands: [["npm", "run", "test"]], required: true, timeoutMs: 600_000 });
  if (scripts.build) out.push({ id: "build", label: "Production build", commands: [["npm", "run", "build"]], required: false, network: BUILD_DOMAINS, timeoutMs: 600_000 });
  return out;
}

/** Validate operator-edited checks against package.json: only `npm run <existing script>` and `npx next typegen`. */
export function validateChecks(checks: CheckDef[], pkg: PackageJson): string | null {
  const scripts = pkg.scripts ?? {};
  for (const c of checks) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(c.id)) return `Invalid check id "${c.id}".`;
    for (const cmd of c.commands) {
      const ok = (cmd.length === 3 && cmd[0] === "npm" && cmd[1] === "run" && Object.hasOwn(scripts, cmd[2]!)) || (cmd.length === 3 && cmd[0] === "npx" && cmd[1] === "next" && cmd[2] === "typegen");
      if (!ok) return `"${cmd.join(" ")}" isn't allowed. Checks may only run package.json scripts.`;
    }
    for (const d of c.network ?? []) if (!BUILD_DOMAINS.includes(d)) return `Network access to ${d} isn't allowed for checks.`;
  }
  return null;
}

/** Files the Workforce may never write, whatever a plan says. */
export function protectedPath(path: string, allowDependencyChanges: boolean): string | null {
  const p = path.replace(/^\.\//, "");
  if (p.startsWith(".git/") || p === ".git") return "the .git directory";
  if (/(^|\/)node_modules\//.test(p)) return "node_modules";
  if (/(^|\/)\.env(\.|$)/.test(p) && !/\.env\.example$/.test(p)) return "environment files";
  if (/(^|\/)(\.vercel|\.next)\//.test(p)) return "build or deployment output";
  if (!allowDependencyChanges && /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(p)) return "dependency manifests (dependency changes are disabled in Workforce settings)";
  return null;
}

/** Paths whose change raises a plan's risk to high (needs approval in every mode). */
export function highRiskPath(path: string): boolean {
  return /(^|\/)(supabase\/migrations|migrations)\//.test(path) || /(auth|admin|security|permission|middleware|proxy|payment|billing|secret|token)/i.test(path) || /^\.github\//.test(path) || /(^|\/)(vercel\.json|next\.config\.[a-z]+)$/.test(path);
}
