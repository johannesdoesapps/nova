import { baseOf, codeOnly, dirOf, isCode, isTestPath, langOf, type SourceFile } from "./source";

/**
 * What a project is made of, read from the files themselves: languages, frameworks, runtime versions,
 * package scripts, tests and CI, configuration (environment variables referenced and documented), docs and
 * migrations. Every entry names the file it came from; nothing is inferred from names alone.
 */

export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  main?: string;
  module?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  type?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  packageManager?: string;
  workspaces?: string[] | { packages?: string[] };
}

export interface ProjectProfile {
  files: number;
  codeFiles: number;
  languages: { lang: string; files: number; lines: number }[];
  packages: { path: string; name: string | null; scripts: Record<string, string>; deps: number; devDeps: number }[];
  frameworks: { name: string; version: string | null; source: string }[];
  runtime: { what: string; value: string; source: string }[];
  tests: { files: number; frameworks: string[]; dirs: string[]; command: string | null };
  ci: { file: string; jobs: string[]; runs: { tests: boolean; lint: boolean; typecheck: boolean; build: boolean } }[];
  env: { referenced: { name: string; files: string[] }[]; documented: string[]; documentedIn: string[]; undocumented: string[] };
  configFiles: string[];
  docs: { readme: string | null; docs: number; decisions: string[] };
  migrations: { dir: string; files: number }[];
  monorepo: boolean;
  entryPoints: string[];
}

const FRAMEWORKS: [string, string][] = [
  ["next", "Next.js"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["@sveltejs/kit", "SvelteKit"],
  ["@angular/core", "Angular"],
  ["nuxt", "Nuxt"],
  ["astro", "Astro"],
  ["@remix-run/react", "Remix"],
  ["vite", "Vite"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["koa", "Koa"],
  ["hono", "Hono"],
  ["@nestjs/core", "NestJS"],
  ["electron", "Electron"],
  ["react-native", "React Native"],
  ["expo", "Expo"],
  ["prisma", "Prisma"],
  ["@prisma/client", "Prisma Client"],
  ["drizzle-orm", "Drizzle"],
  ["typeorm", "TypeORM"],
  ["mongoose", "Mongoose"],
  ["sequelize", "Sequelize"],
  ["@supabase/supabase-js", "Supabase"],
  ["tailwindcss", "Tailwind CSS"],
  ["typescript", "TypeScript"],
];
const TEST_FRAMEWORKS: [string, string][] = [
  ["vitest", "Vitest"],
  ["jest", "Jest"],
  ["mocha", "Mocha"],
  ["ava", "AVA"],
  ["@playwright/test", "Playwright"],
  ["cypress", "Cypress"],
  ["@testing-library/react", "Testing Library"],
];
const PY_FRAMEWORKS: [RegExp, string][] = [
  [/^django\b/im, "Django"],
  [/^flask\b/im, "Flask"],
  [/^fastapi\b/im, "FastAPI"],
  [/^sqlalchemy\b/im, "SQLAlchemy"],
  [/^pytest\b/im, "pytest"],
  [/^pydantic\b/im, "Pydantic"],
];

export function readPackageJsons(files: SourceFile[]): { path: string; pkg: PackageJson }[] {
  const out: { path: string; pkg: PackageJson }[] = [];
  for (const f of files)
    if (baseOf(f.path) === "package.json" && !/node_modules\//.test(f.path))
      try {
        out.push({ path: f.path, pkg: JSON.parse(f.content) as PackageJson });
      } catch {
        /* invalid package.json is reported by the dependency checks */
      }
  return out.sort((a, b) => a.path.split("/").length - b.path.split("/").length);
}

/** The command a person (or the coding agent) would run for tests, from package.json or Python conventions. */
export function testCommand(files: SourceFile[]): string | null {
  const root = readPackageJsons(files)[0];
  const s = root?.pkg.scripts ?? {};
  if (s.test && !/no test specified/.test(s.test)) return `npm test${root!.path.includes("/") ? ` (in ${dirOf(root!.path)})` : ""}`;
  if (files.some((f) => /(^|\/)(pytest\.ini|conftest\.py)$/.test(f.path) || (/pyproject\.toml$/.test(f.path) && /\[tool\.pytest/.test(f.content)))) return "pytest";
  return null;
}

const ENV_JS = /\b(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]{1,60})\b|\bprocess\.env\[\s*["']([A-Z][A-Z0-9_]{1,60})["']\s*\]/g;
const ENV_PY = /\bos\.(?:environ(?:\.get)?\s*[[(]\s*|getenv\(\s*)["']([A-Z][A-Z0-9_]{1,60})["']/g;
const BUILTIN_ENV = new Set([
  "NODE_ENV",
  "CI",
  "PORT",
  "HOME",
  "PATH",
  "TZ",
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_REGION",
  "NEXT_RUNTIME",
  "NEXT_PHASE",
  "DEV",
  "PROD",
  "MODE",
  "SSR",
  "BASE_URL",
  "PWD",
  "USER",
  "HOSTNAME",
]);

export function buildProfile(files: SourceFile[], entryPoints: string[] = []): ProjectProfile {
  const langs = new Map<string, { files: number; lines: number }>();
  for (const f of files) {
    if (!isCode(f.path)) continue;
    const l = { ts: "TypeScript", js: "JavaScript", py: "Python", other: "Other" }[langOf(f.path)];
    const cur = langs.get(l) ?? { files: 0, lines: 0 };
    langs.set(l, { files: cur.files + 1, lines: cur.lines + f.content.split("\n").length });
  }
  const pkgs = readPackageJsons(files);
  const frameworks: ProjectProfile["frameworks"] = [];
  const testFw = new Set<string>();
  for (const { path, pkg } of pkgs) {
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [dep, label] of FRAMEWORKS) if (all[dep] && !frameworks.some((x) => x.name === label)) frameworks.push({ name: label, version: all[dep]!, source: path });
    for (const [dep, label] of TEST_FRAMEWORKS) if (all[dep]) testFw.add(label);
  }
  for (const f of files)
    if (/(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile)$/.test(f.path))
      for (const [re, label] of PY_FRAMEWORKS)
        if (re.test(f.content.replace(/^\s*["']?/gm, "")) && !frameworks.some((x) => x.name === label)) frameworks.push({ name: label, version: null, source: f.path });
  if (frameworks.some((x) => x.name === "pytest")) testFw.add("pytest");
  if (files.some((f) => isTestPath(f.path) && /from\s+["']node:test["']/.test(f.content))) testFw.add("node:test");

  const runtime: ProjectProfile["runtime"] = [];
  for (const { path, pkg } of pkgs.slice(0, 3)) {
    if (pkg.engines?.node) runtime.push({ what: "Node.js (engines)", value: pkg.engines.node, source: path });
    if (pkg.packageManager) runtime.push({ what: "Package manager", value: pkg.packageManager, source: path });
    if (pkg.type) runtime.push({ what: "Module type", value: pkg.type, source: path });
  }
  for (const f of files) {
    const b = baseOf(f.path);
    if (b === ".nvmrc" || b === ".node-version") runtime.push({ what: "Node.js", value: f.content.trim().slice(0, 30), source: f.path });
    if (b === ".python-version") runtime.push({ what: "Python", value: f.content.trim().slice(0, 30), source: f.path });
    if (b === "Dockerfile") for (const m of f.content.matchAll(/^FROM\s+(\S+)/gim)) runtime.push({ what: "Container base image", value: m[1]!.slice(0, 60), source: f.path });
    if (b === "pyproject.toml") {
      const m = /requires-python\s*=\s*["']([^"']+)["']/.exec(f.content);
      if (m) runtime.push({ what: "Python (requires-python)", value: m[1]!, source: f.path });
    }
  }

  const testFiles = files.filter((f) => isCode(f.path) && isTestPath(f.path));
  const testDirs = [...new Set(testFiles.map((f) => dirOf(f.path).split("/").slice(0, 2).join("/") || "."))].slice(0, 8);

  const ci = files
    .filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f.path) || /(^|\/)\.gitlab-ci\.yml$|(^|\/)\.circleci\/config\.yml$|(^|\/)azure-pipelines\.yml$/.test(f.path))
    .map((f) => {
      const runs = f.content.match(/^\s*(?:-\s*)?run:\s*[|>]?\s*(.*)$/gm)?.join("\n") ?? f.content;
      const jobs = [...f.content.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]!).slice(0, 10);
      return {
        file: f.path,
        jobs,
        runs: {
          tests: /\b(npm (run )?test|yarn test|pnpm test|vitest|jest|pytest|go test|playwright test)\b/.test(runs),
          lint: /\b(lint|eslint|ruff|flake8|biome)\b/.test(runs),
          typecheck: /\b(tsc|typecheck|type-check|mypy|pyright)\b/.test(runs),
          build: /\b(run build|next build|vite build|yarn build|pnpm build|docker build)\b/.test(runs),
        },
      };
    });

  const referenced = new Map<string, Set<string>>();
  for (const f of files) {
    if (!isCode(f.path)) continue;
    const src = codeOnly(f.content, langOf(f.path));
    // codeOnly blanks string contents, so read names from the original text at the same offsets.
    for (const m of f.content.matchAll(langOf(f.path) === "py" ? ENV_PY : ENV_JS)) {
      const name = m[1] ?? m[2]!;
      if (BUILTIN_ENV.has(name) || src.slice(m.index!, m.index! + 4).trim() === "") continue;
      (referenced.get(name) ?? referenced.set(name, new Set()).get(name)!).add(f.path);
    }
  }
  const envDocs = files.filter((f) => /(^|\/)\.env\.(example|sample|template|dist|defaults)$|(^|\/)env\.example$/.test(f.path));
  const documented = [...new Set(envDocs.flatMap((f) => [...f.content.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,60})\s*=/gm)].map((m) => m[1]!)))];
  const docText = files
    .filter((f) => /\.md$/i.test(f.path))
    .map((f) => f.content)
    .join("\n");
  const undocumented = [...referenced.keys()].filter((k) => !documented.includes(k) && !docText.includes(k)).sort();

  const migrationDirs = new Map<string, number>();
  for (const f of files) {
    const m = /^(.*?(?:supabase\/migrations|prisma\/migrations|migrations|alembic\/versions|db\/migrate))\//.exec(f.path);
    if (m) migrationDirs.set(m[1]!, (migrationDirs.get(m[1]!) ?? 0) + 1);
  }

  return {
    files: files.length,
    codeFiles: files.filter((f) => isCode(f.path)).length,
    languages: [...langs.entries()].map(([lang, v]) => ({ lang, ...v })).sort((a, b) => b.lines - a.lines),
    packages: pkgs.slice(0, 12).map(({ path, pkg }) => ({
      path,
      name: pkg.name ?? null,
      scripts: Object.fromEntries(
        Object.entries(pkg.scripts ?? {})
          .slice(0, 20)
          .map(([k, v]) => [k, v.slice(0, 120)]),
      ),
      deps: Object.keys(pkg.dependencies ?? {}).length,
      devDeps: Object.keys(pkg.devDependencies ?? {}).length,
    })),
    frameworks,
    runtime: runtime.slice(0, 10),
    tests: { files: testFiles.length, frameworks: [...testFw], dirs: testDirs, command: testCommand(files) },
    ci,
    env: {
      referenced: [...referenced.entries()].map(([name, s]) => ({ name, files: [...s].slice(0, 3) })).sort((a, b) => a.name.localeCompare(b.name)),
      documented,
      documentedIn: envDocs.map((f) => f.path),
      undocumented,
    },
    configFiles: files
      .filter((f) =>
        /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|[^/]*\.config\.[cm]?[jt]s|vercel\.json|netlify\.toml|Dockerfile|docker-compose\.ya?ml|\.eslintrc[^/]*|pyproject\.toml|setup\.cfg|tox\.ini)$/.test(
          f.path,
        ),
      )
      .map((f) => f.path)
      .slice(0, 30),
    docs: {
      readme: files.find((f) => /^readme(\.md)?$/i.test(f.path))?.path ?? files.find((f) => /(^|\/)readme(\.md)?$/i.test(f.path))?.path ?? null,
      docs: files.filter((f) => /(^|\/)docs?\//i.test(f.path) && /\.(md|mdx|txt)$/i.test(f.path)).length,
      decisions: files
        .filter((f) => /(^|\/)(adr|adrs|decisions)\/[^/]+\.md$/i.test(f.path))
        .map((f) => f.path)
        .slice(0, 20),
    },
    migrations: [...migrationDirs.entries()].map(([dir, n]) => ({ dir, files: n })),
    monorepo: pkgs.some((p) => p.pkg.workspaces) || pkgs.length > 2,
    entryPoints: entryPoints.slice(0, 40),
  };
}
