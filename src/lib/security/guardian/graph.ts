import { baseOf, codeOnly, dirOf, isCode, isConfigPath, isGeneratedPath, isTestPath, joinPath, langOf, lineIndex, stripComments, type SourceFile } from "./source";

/**
 * The module graph: which file imports which, built from import/require/export-from statements (JS/TS) and
 * import/from statements (Python). Relative imports and tsconfig/jsconfig path aliases are resolved against
 * the files actually present; anything else is an external package. From the graph: dependents (what could
 * break when a file changes), import cycles, imports that point at missing files, files nothing imports and
 * exports nothing imports. It's a static, text-based view: dynamic paths, plugin loading and code outside
 * the repository aren't seen, and the results say so.
 */

export interface ImportRef {
  spec: string;
  line: number;
  /** Resolved repository path, when the import points into the repo. */
  to: string | null;
  /** Bare package name for external imports. */
  pkg: string | null;
  kind: "static" | "type" | "dynamic" | "require" | "reexport";
  names: string[];
  /** `import * as ns` or `export * from`: every export counts as used. */
  all: boolean;
}

export interface ModuleNode {
  path: string;
  lang: "ts" | "js" | "py";
  lines: number;
  imports: ImportRef[];
  /** Named value/type exports (JS/TS). */
  exports: { name: string; line: number; type: boolean; /** Other mentions of the name in its own file. */ localUses: number }[];
  hasDefault: boolean;
  test: boolean;
  entry: boolean;
}

export interface ModuleGraph {
  nodes: Map<string, ModuleNode>;
  /** path → files that import it (runtime and type imports). */
  dependents: Map<string, Set<string>>;
  aliases: { prefix: string; targets: string[]; config: string }[];
}

export const NODE_BUILTINS = new Set(
  "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib test".split(
    " ",
  ),
);

const CODE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
/** Imports the snapshot can't contain (assets) — never reported as missing. */
const ASSET = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp3|mp4|wasm|glsl|wgsl|txt|md|mdx|html|graphql|gql|ya?ml|toml|csv)(\?.*)?$/i;

/** Which Next.js / framework files are loaded by convention rather than imported. */
const NEXT_SPECIAL =
  /(^|\/)(app|pages)\/.*(^|\/)?(page|layout|template|loading|error|not-found|global-error|default|route|head|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest|middleware|_app|_document|_error|\[[^/]+\]|index)\.[cm]?[jt]sx?$|(^|\/)pages\/.+\.[jt]sx?$/;
const ENTRY_NAME =
  /(^|\/)(middleware|proxy|instrumentation|instrumentation-client|server|main|index|app|cli|worker|sw|service-worker|manage|wsgi|asgi|__main__|setup|conftest)\.[cm]?[jt]sx?$|(^|\/)(manage|wsgi|asgi|__main__|setup|conftest|app|main)\.py$|\.worker\.[jt]s$/;

export function packageName(spec: string): string {
  const s = spec.replace(/^node:/, "");
  if (s.startsWith("@")) return s.split("/").slice(0, 2).join("/");
  return s.split("/")[0]!;
}

/** tsconfig/jsconfig `paths` aliases (JSON with comments allowed). */
function readAliases(files: SourceFile[]): ModuleGraph["aliases"] {
  const out: ModuleGraph["aliases"] = [];
  for (const f of files) {
    if (!/(^|\/)(tsconfig|jsconfig)[^/]*\.json$/.test(f.path)) continue;
    try {
      const j = JSON.parse(stripComments(f.content, "js").replace(/,\s*([}\]])/g, "$1")) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
      const base = joinPath(dirOf(f.path), j.compilerOptions?.baseUrl ?? ".") ?? "";
      for (const [k, v] of Object.entries(j.compilerOptions?.paths ?? {}))
        out.push({
          prefix: k.replace(/\*$/, ""),
          targets: v.map((t) => joinPath(base, t.replace(/\*$/, "")) ?? "").map((t) => (t && !t.endsWith("/") && v[0]!.endsWith("*") ? `${t}/` : t)),
          config: f.path,
        });
    } catch {
      /* unreadable config: aliases from it simply aren't resolved */
    }
  }
  return out.sort((a, b) => b.prefix.length - a.prefix.length);
}

function resolveJs(spec: string, from: string, have: Set<string>, aliases: ModuleGraph["aliases"]): { to: string | null; local: boolean } {
  const candidates: string[] = [];
  if (spec.startsWith(".")) {
    const p = joinPath(dirOf(from), spec);
    if (p === null) return { to: null, local: true };
    candidates.push(p);
  } else {
    const fromDir = dirOf(from);
    // Use the aliases from the nearest config above this file; fall back to any.
    const scoped = aliases.filter((a) => !dirOf(a.config) || fromDir === dirOf(a.config) || fromDir.startsWith(`${dirOf(a.config)}/`));
    const a = (scoped.length ? scoped : aliases).find((x) => (x.prefix.endsWith("/") ? spec.startsWith(x.prefix) : spec === x.prefix || spec.startsWith(`${x.prefix}/`)));
    if (!a) return { to: null, local: false };
    for (const t of a.targets) candidates.push(joinPath("", `${t}${spec.slice(a.prefix.length)}`) ?? "");
  }
  for (const c of candidates) {
    const stem = c.replace(/\.(js|jsx|mjs|cjs)$/, "");
    const tries = [c, ...CODE_EXT.map((e) => `${c}${e}`), ...CODE_EXT.map((e) => `${stem}${e}`), ...CODE_EXT.map((e) => `${c}/index${e}`), `${c}.d.ts`, `${c}/index.d.ts`, `${c}.json`];
    const hit = tries.find((t) => have.has(t));
    if (hit) return { to: hit, local: true };
  }
  return { to: null, local: true };
}

function resolvePy(mod: string, from: string, have: Set<string>): { to: string | null; local: boolean } {
  let base: string;
  let rest = mod;
  if (mod.startsWith(".")) {
    const dots = /^\.+/.exec(mod)![0].length;
    rest = mod.slice(dots);
    let d: string | null = dirOf(from);
    for (let k = 1; k < dots && d !== null; k++) d = d ? dirOf(d) : null;
    if (d === null) return { to: null, local: true };
    base = d;
    const p = [base, rest.replace(/\./g, "/")].filter(Boolean).join("/");
    const hit = [`${p}.py`, `${p}/__init__.py`].find((t) => have.has(t));
    return { to: hit ?? null, local: true };
  }
  const p = mod.replace(/\./g, "/");
  for (const root of ["", "src/", "app/", `${from.split("/")[0]}/`]) {
    const hit = [`${root}${p}.py`, `${root}${p}/__init__.py`].find((t) => have.has(t));
    if (hit) return { to: hit, local: true };
  }
  return { to: null, local: false };
}

const JS_IMPORT =
  /\bimport\s+(type\s+)?([\w$*{}\s,]+?)\s+from\s*["']([^"'\n]+)["']|\bimport\s*["']([^"'\n]+)["']|\bexport\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s*["']([^"'\n]+)["']|\brequire\(\s*["']([^"'\n]+)["']\s*\)|\bimport\(\s*["']([^"'\n]+)["']\s*\)/g;
const JS_EXPORT = /\bexport\s+(?:declare\s+)?(?:(default)\b|(?:async\s+)?(function\*?|class|const|let|var|type|interface|enum|abstract\s+class)\s+([\w$]+)|\{([^}]*)\}(?!\s*from))/g;
const PY_IMPORT = /^[ \t]*(?:from\s+([.\w]+)\s+import\s+(\([^)]*\)|[^\n#]+)|import\s+([\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*))/gm;

function importedNames(clause: string): { names: string[]; all: boolean } {
  const all = /\*\s+as\s+/.test(clause) || clause.trim() === "*";
  const names: string[] = [];
  const brace = /\{([^}]*)\}/.exec(clause);
  if (brace)
    for (const part of brace[1]!.split(",")) {
      const n = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]!
        .trim();
      if (n) names.push(n);
    }
  const def = clause
    .replace(/\{[^}]*\}/, "")
    .replace(/\*\s+as\s+[\w$]+/, "")
    .replace(/,/g, " ")
    .trim();
  if (def && /^[\w$]+$/.test(def)) names.push("default");
  return { names, all };
}

export function buildGraph(files: SourceFile[], opts: { entries?: string[] } = {}): ModuleGraph {
  const code = files.filter((f) => isCode(f.path) || /\.d\.ts$/.test(f.path));
  const have = new Set(files.map((f) => f.path));
  const aliases = readAliases(files);
  const entries = new Set(opts.entries ?? []);
  const nodes = new Map<string, ModuleNode>();
  const dependents = new Map<string, Set<string>>();
  for (const f of code) {
    const lang = langOf(f.path) as ModuleNode["lang"];
    const src = codeOnly(f.content, lang);
    const lineOf = lineIndex(src);
    const imports: ImportRef[] = [];
    const exports: ModuleNode["exports"] = [];
    let hasDefault = false;
    if (lang === "py") {
      for (const m of src.matchAll(PY_IMPORT)) {
        const line = lineOf(m.index!);
        // An indented import runs when its function runs (the usual way to break a cycle), not at load time.
        const lazy = /^[ \t]+/.test(m[0]);
        if (m[1]) {
          const r = resolvePy(m[1], f.path, have);
          const names = m[2]!
            .replace(/[()]/g, "")
            .split(",")
            .map((s) => s.trim().split(/\s+as\s+/)[0]!)
            .filter(Boolean);
          // "from . import x": x may itself be a module.
          let to = r.to;
          if (/^\.+$/.test(m[1]) && names.length === 1) to = resolvePy(`${m[1]}${names[0]}`, f.path, have).to ?? to;
          imports.push({ spec: m[1], line, to, pkg: r.local ? null : m[1].split(".")[0]!, kind: lazy ? "dynamic" : "static", names, all: names.includes("*") });
        } else
          for (const part of m[3]!.split(",")) {
            const mod = part.trim().split(/\s+as\s+/)[0]!;
            const r = resolvePy(mod, f.path, have);
            imports.push({ spec: mod, line, to: r.to, pkg: r.local ? null : mod.split(".")[0]!, kind: lazy ? "dynamic" : "static", names: [], all: true });
          }
      }
    } else {
      for (const m of src.matchAll(JS_IMPORT)) {
        const spec = m[3] ?? m[4] ?? m[7] ?? m[8] ?? m[9]!;
        // Text inside a regex literal can look like an import; a real specifier is a path or package name.
        if (!/^[\w@.~#$/][\w@.~#$/:+-]*$/.test(spec)) continue;
        const kind: ImportRef["kind"] = m[3] ? (m[1] ? "type" : "static") : m[4] ? "static" : m[7] ? (m[5] ? "type" : "reexport") : m[8] ? "require" : "dynamic";
        const clause = m[2] ?? m[6] ?? "";
        const { names, all } = m[3] || m[7] ? importedNames(clause) : { names: [], all: true };
        // `import { type A, B }` — a clause with only type specifiers is type-only too.
        const typeOnly = kind === "static" && m[2] && /^\s*\{\s*(type\s+[\w$]+\s*(as\s+[\w$]+\s*)?,?\s*)+\}\s*$/.test(m[2]);
        const r = resolveJs(spec, f.path, have, aliases);
        imports.push({
          spec,
          line: lineOf(m.index!),
          to: r.to,
          pkg: r.local ? null : packageName(spec),
          kind: typeOnly ? "type" : kind,
          names,
          all: all || (kind === "reexport" && m[6]!.startsWith("*")),
        });
      }
      for (const m of src.matchAll(JS_EXPORT)) {
        const line = lineOf(m.index!);
        if (m[1]) hasDefault = true;
        else if (m[3]) exports.push({ name: m[3], line, type: /^(type|interface)$/.test(m[2]!), localUses: 0 });
        else if (m[4])
          for (const part of m[4].split(",")) {
            const [local, alias] = part
              .trim()
              .replace(/^type\s+/, "")
              .split(/\s+as\s+/);
            const name = (alias ?? local ?? "").trim();
            if (name === "default") hasDefault = true;
            else if (name) exports.push({ name, line, type: /^\s*type\s/.test(part), localUses: 1 });
          }
      }
      for (const e of exports) if (!e.localUses) e.localUses = Math.max(0, (src.match(new RegExp(`(?<![\\w$.])${e.name.replace(/\$/g, "\\$")}(?![\\w$])`, "g"))?.length ?? 1) - 1);
    }
    const entry = entries.has(f.path) || NEXT_SPECIAL.test(f.path) || ENTRY_NAME.test(f.path) || isConfigPath(f.path) || /(^|\/)(scripts|bin)\//.test(f.path);
    nodes.set(f.path, { path: f.path, lang, lines: f.content.split("\n").length, imports, exports, hasDefault, test: isTestPath(f.path), entry });
    for (const i of imports) if (i.to) (dependents.get(i.to) ?? dependents.set(i.to, new Set()).get(i.to)!).add(f.path);
  }
  return { nodes, dependents, aliases };
}

/* ------------------------------------------------------------- analyses */

/** Import cycles among runtime imports (type-only and lazy imports don't create load-order problems). Tarjan's SCC. */
export function findCycles(g: ModuleGraph): string[][] {
  const adj = new Map<string, string[]>();
  for (const n of g.nodes.values())
    adj.set(n.path, [...new Set(n.imports.filter((i) => i.to && i.to !== n.path && (i.kind === "static" || i.kind === "reexport" || i.kind === "require") && g.nodes.has(i.to)).map((i) => i.to!))]);
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const visit = (start: string) => {
    // Iterative to survive deep graphs.
    const work: { v: string; i: number }[] = [{ v: start, i: 0 }];
    idx.set(start, index);
    low.set(start, index++);
    stack.push(start);
    on.add(start);
    while (work.length) {
      const top = work[work.length - 1]!;
      const next = adj.get(top.v)!;
      if (top.i < next.length) {
        const w = next[top.i++]!;
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index++);
          stack.push(w);
          on.add(w);
          work.push({ v: w, i: 0 });
        } else if (on.has(w)) low.set(top.v, Math.min(low.get(top.v)!, idx.get(w)!));
      } else {
        work.pop();
        if (work.length) low.set(work[work.length - 1]!.v, Math.min(low.get(work[work.length - 1]!.v)!, low.get(top.v)!));
        if (low.get(top.v) === idx.get(top.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            on.delete(w);
            comp.push(w);
          } while (w !== top.v);
          if (comp.length > 1) out.push(comp.sort());
        }
      }
    }
  };
  for (const v of adj.keys()) if (!idx.has(v)) visit(v);
  return out.sort((a, b) => a.length - b.length);
}

/** One concrete loop through a cycle's files, for evidence (A → B → … → A). */
export function cyclePath(g: ModuleGraph, comp: string[]): { from: string; to: string; line: number }[] {
  const inComp = new Set(comp);
  const start = comp[0]!;
  const prev = new Map<string, { from: string; line: number }>();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length) {
    const v = queue.shift()!;
    for (const i of g.nodes.get(v)!.imports) {
      if (!i.to || !inComp.has(i.to) || i.kind === "type" || i.kind === "dynamic") continue;
      if (i.to === start) {
        const path = [{ from: v, to: start, line: i.line }];
        let cur = v;
        while (cur !== start) {
          const p = prev.get(cur)!;
          path.unshift({ from: p.from, to: cur, line: p.line });
          cur = p.from;
        }
        return path;
      }
      if (!seen.has(i.to)) {
        seen.add(i.to);
        prev.set(i.to, { from: v, line: i.line });
        queue.push(i.to);
      }
    }
  }
  return [];
}

/** Local imports that point at nothing in the repository (assets excluded — the snapshot doesn't carry them). */
export function brokenImports(g: ModuleGraph): { file: string; line: number; spec: string }[] {
  const out: { file: string; line: number; spec: string }[] = [];
  for (const n of g.nodes.values())
    for (const i of n.imports) if (!i.to && !i.pkg && !ASSET.test(i.spec) && !isGeneratedPath(i.spec) && !/[$*{]/.test(i.spec)) out.push({ file: n.path, line: i.line, spec: i.spec });
  return out;
}

/** Transitive dependents of a set of files, with the shortest distance to each. */
export function dependentsOf(g: ModuleGraph, files: string[], maxDepth = 12): Map<string, number> {
  const dist = new Map<string, number>();
  let frontier = files.filter((f) => g.nodes.has(f));
  for (const f of frontier) dist.set(f, 0);
  for (let d = 1; d <= maxDepth && frontier.length; d++) {
    const next: string[] = [];
    for (const f of frontier)
      for (const dep of g.dependents.get(f) ?? []) {
        if (dist.has(dep)) continue;
        dist.set(dep, d);
        next.push(dep);
      }
    frontier = next;
  }
  return dist;
}

/** Code files nothing imports that aren't entry points, tests, configs or declarations. */
export function orphans(g: ModuleGraph): string[] {
  return [...g.nodes.values()]
    .filter((n) => !n.entry && !n.test && !/\.d\.ts$/.test(n.path) && !(g.dependents.get(n.path)?.size ?? 0) && !isGeneratedPath(n.path) && !/(^|\/)(__init__\.py|public\/.*|static\/.*)$/.test(n.path))
    .map((n) => n.path);
}

/**
 * Named value exports no other file imports. A namespace import, `export *` or a dynamic import of the file
 * counts every export as used; framework entry files are skipped. The export may still be used inside its own
 * file or from outside the repository.
 */
export function unusedExports(g: ModuleGraph): { file: string; name: string; line: number; localUses: number }[] {
  const used = new Map<string, Set<string>>();
  const everything = new Set<string>();
  for (const n of g.nodes.values())
    for (const i of n.imports) {
      if (!i.to) continue;
      if (i.all || i.kind === "dynamic" || i.kind === "require") everything.add(i.to);
      const s = used.get(i.to) ?? used.set(i.to, new Set()).get(i.to)!;
      for (const name of i.names) s.add(name);
    }
  const out: { file: string; name: string; line: number; localUses: number }[] = [];
  for (const n of g.nodes.values()) {
    if (n.lang === "py" || n.entry || n.test || everything.has(n.path) || /\.d\.ts$/.test(n.path)) continue;
    for (const e of n.exports) if (!e.type && !used.get(n.path)?.has(e.name)) out.push({ file: n.path, name: e.name, line: e.line, localUses: e.localUses });
  }
  return out;
}

/** Most-depended-on files (fan-in), the ones whose changes reach furthest. */
export function hotspots(g: ModuleGraph, n = 10): { file: string; dependents: number; transitive: number; lines: number }[] {
  return [...g.nodes.values()]
    .filter((x) => !x.test)
    .map((x) => ({ file: x.path, dependents: g.dependents.get(x.path)?.size ?? 0, lines: x.lines }))
    .filter((x) => x.dependents > 0)
    .sort((a, b) => b.dependents - a.dependents)
    .slice(0, n)
    .map((x) => ({ ...x, transitive: dependentsOf(g, [x.file]).size - 1 }));
}

export const isFrameworkEntry = (path: string) => NEXT_SPECIAL.test(path) || ENTRY_NAME.test(path);
export { baseOf };
