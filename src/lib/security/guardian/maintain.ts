import { fingerprint, type FindingDraft } from "../types";
import { cyclePath, findCycles, hotspots, type ModuleGraph } from "./graph";
import { codeOnly, isGeneratedPath, isTestPath, langOf, lineIndex, lineText, matchBrace, stripComments, type SourceFile } from "./source";

/**
 * Maintainability: measurements, not opinions. Long and branch-heavy functions, very large files, import cycles,
 * duplicated blocks of code, and debt markers left in comments. Each recommendation says what it would make
 * easier and what it would risk; none of it is urgent unless it causes a defect, and it's reported separately
 * from correctness findings.
 */

export interface FunctionMetric {
  file: string;
  name: string;
  line: number;
  lines: number;
  /** Decision points + 1 (if, loops, case, catch, &&, ||, ??, ternaries). An approximation of cyclomatic complexity. */
  complexity: number;
}

export interface MaintainSummary {
  functions: number;
  longFunctions: FunctionMetric[];
  complexFunctions: FunctionMetric[];
  largeFiles: { file: string; lines: number }[];
  cycles: { files: string[]; path: string[] }[];
  duplicates: { lines: number; a: string; b: string }[];
  debt: { total: number; byKind: Record<string, number>; items: { file: string; line: number; text: string }[] };
  hotspots: ReturnType<typeof hotspots>;
  thresholds: { longFunction: number; complexFunction: number; largeFile: number; duplicateLines: number };
}

const T = { longFunction: 120, complexFunction: 25, largeFile: 800, duplicateLines: 10 };

const DECISION = /\b(?:if|for|while|case|catch)\b|&&|\|\||\?\?|\?(?![.?:])/g;

function jsFunctions(path: string, raw: string): FunctionMetric[] {
  const code = codeOnly(raw, langOf(path));
  const lineOf = lineIndex(code);
  const out: FunctionMetric[] = [];
  const re =
    /\bfunction\s*\*?\s*([\w$]+)?\s*\([^)]*\)[^{;]*\{|\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>\s*\{|^\s*(?:(?:public|private|protected|static|async|get|set)\s+)*([\w$]+)\s*\([^)]*\)\s*(?::[^{]+)?\{/gm;
  for (const m of code.matchAll(re)) {
    const name = m[1] ?? m[2] ?? m[3] ?? "anonymous";
    if (/^(if|for|while|switch|catch|with|return|function)$/.test(name)) continue;
    const open = m.index! + m[0].length - 1;
    const close = matchBrace(code, open);
    if (close < 0) continue;
    const body = code.slice(open, close);
    out.push({ file: path, name, line: lineOf(m.index! + (m[0].length - m[0].trimStart().length)), lines: lineOf(close) - lineOf(open) + 1, complexity: (body.match(DECISION)?.length ?? 0) + 1 });
  }
  return out;
}

function pyFunctions(path: string, raw: string): FunctionMetric[] {
  const code = codeOnly(raw, "py");
  const lines = code.split("\n");
  const out: FunctionMetric[] = [];
  lines.forEach((l, i) => {
    const m = /^(\s*)(?:async\s+)?def\s+(\w+)/.exec(l);
    if (!m) return;
    const indent = m[1]!.length;
    let end = i + 1;
    while (end < lines.length && (lines[end]!.trim() === "" || /^\s*/.exec(lines[end]!)![0].length > indent)) end++;
    const body = lines.slice(i, end).join("\n");
    out.push({ file: path, name: m[2]!, line: i + 1, lines: end - i, complexity: (body.match(/\b(?:if|elif|for|while|except|and|or)\b|\bif\b.+\belse\b/g)?.length ?? 0) + 1 });
  });
  return out;
}

/** Repeated blocks of ≥ minLines significant lines (whitespace-normalised), across files or far apart in one. */
export function duplicateBlocks(files: SourceFile[], minLines = T.duplicateLines): { lines: number; a: string; b: string }[] {
  const TRIVIAL = /^([{}()[\];,]*|\}\s*else\s*\{|import .*|export \{.*|from .*|return;?|break;?|\*.*|\/\/.*|#.*|pass|""".*)$/;
  const seen = new Map<string, { file: string; line: number }>();
  const pairs = new Map<string, { a: { file: string; line: number }; b: { file: string; line: number }; len: number }>();
  for (const f of files) {
    if (isTestPath(f.path) || isGeneratedPath(f.path) || langOf(f.path) === "other" || f.content.length > 300_000) continue;
    const sig: { text: string; line: number }[] = [];
    // Compare real text (strings kept): blanking strings would make unrelated string-only lines look identical.
    stripComments(f.content, langOf(f.path))
      .split("\n")
      .forEach((l, i) => {
        const t = l.trim().replace(/\s+/g, " ");
        if (t.length > 3 && !TRIVIAL.test(t)) sig.push({ text: t, line: i + 1 });
      });
    let lastPair: string | null = null;
    for (let i = 0; i + minLines <= sig.length; i++) {
      const key = sig
        .slice(i, i + minLines)
        .map((s) => s.text)
        .join("\n");
      const prev = seen.get(key);
      if (!prev) {
        seen.set(key, { file: f.path, line: sig[i]!.line });
        lastPair = null;
        continue;
      }
      if (prev.file === f.path && Math.abs(prev.line - sig[i]!.line) < minLines * 2) continue;
      // Extend the previous pair when this window continues it.
      const id = `${prev.file}|${f.path}`;
      if (lastPair && pairs.has(lastPair)) {
        pairs.get(lastPair)!.len++;
        continue;
      }
      const k = `${id}|${prev.line}|${sig[i]!.line}`;
      pairs.set(k, { a: prev, b: { file: f.path, line: sig[i]!.line }, len: minLines });
      lastPair = k;
    }
  }
  return [...pairs.values()]
    .sort((x, y) => y.len - x.len)
    .slice(0, 15)
    .map((p) => ({ lines: p.len, a: `${p.a.file}:${p.a.line}`, b: `${p.b.file}:${p.b.line}` }));
}

export function analyseMaintainability(files: SourceFile[], graph: ModuleGraph, asset: string): { findings: FindingDraft[]; summary: MaintainSummary } {
  const fns: FunctionMetric[] = [];
  const large: { file: string; lines: number }[] = [];
  const debt: MaintainSummary["debt"] = { total: 0, byKind: {}, items: [] };
  for (const f of files) {
    const lang = langOf(f.path);
    if (lang === "other" || isTestPath(f.path) || isGeneratedPath(f.path) || /\.d\.ts$|\.min\.js$/.test(f.path) || f.content.length > 400_000) continue;
    fns.push(...(lang === "py" ? pyFunctions(f.path, f.content) : jsFunctions(f.path, f.content)));
    const lines = f.content.split("\n").length;
    if (lines > T.largeFile) large.push({ file: f.path, lines });
    // Comments blanked, strings kept: a marker blanked here was in a comment, not in a string.
    const noComments = stripComments(f.content, lang);
    const lineOf = lineIndex(f.content);
    for (const m of f.content.matchAll(/\b(TODO|FIXME|HACK|XXX)\b[:\s]/g)) {
      if (noComments[m.index!] !== " ") continue;
      debt.total++;
      debt.byKind[m[1]!] = (debt.byKind[m[1]!] ?? 0) + 1;
      if (debt.items.length < 25) {
        const line = lineOf(m.index!);
        debt.items.push({ file: f.path, line, text: lineText(f.content, line).slice(0, 160) });
      }
    }
  }
  const cycles = findCycles(graph)
    .slice(0, 10)
    .map((c) => ({ files: c, path: cyclePath(graph, c).map((e) => `${e.from}:${e.line} → ${e.to}`) }));
  const duplicates = duplicateBlocks(files);
  const summary: MaintainSummary = {
    functions: fns.length,
    longFunctions: fns
      .filter((x) => x.lines > T.longFunction)
      .sort((a, b) => b.lines - a.lines)
      .slice(0, 15),
    complexFunctions: fns
      .filter((x) => x.complexity > T.complexFunction)
      .sort((a, b) => b.complexity - a.complexity)
      .slice(0, 15),
    largeFiles: large.sort((a, b) => b.lines - a.lines).slice(0, 15),
    cycles,
    duplicates,
    debt,
    hotspots: hotspots(graph, 10),
    thresholds: T,
  };

  const findings: FindingDraft[] = [];
  for (const c of cycles)
    findings.push({
      agent: "code_guardian",
      ruleId: "arch.import-cycle",
      fingerprint: fingerprint("code_guardian", "arch.import-cycle", asset, c.files.join("|")),
      title: `Import cycle between ${c.files.length} files`,
      description: `${c.files.join(", ")} import each other (${c.path.join("; ")}). In a cycle, one module is used before it has finished loading — values can be undefined at import time ("Cannot access … before initialization"), behaviour depends on which file loads first, and none of them can be changed or tested in isolation.`,
      severity: "low",
      confidence: "confirmed",
      rationale: "Found in the module graph (runtime imports only; type-only and lazy imports excluded).",
      asset,
      location: c.path[0]?.split(" → ")[0] ?? c.files[0]!,
      evidence: c.path.map((p) => ({ source: p.split(" → ")[0]!, detail: `imports ${p.split(" → ")[1]}` })),
      evidenceSource: "orbis:code-guardian",
      remediation:
        "Benefit: each module can load and be tested on its own. Usual fix: move the shared piece both files need into a third module, or have one side receive what it needs as a parameter. Risk: low if covered by tests; check every importer of the moved code. Run the full test suite after.",
      references: [],
    });
  for (const d of duplicates.filter((x) => x.lines >= 15).slice(0, 8))
    findings.push({
      agent: "code_guardian",
      ruleId: "arch.duplicate-block",
      fingerprint: fingerprint("code_guardian", "arch.duplicate-block", asset, `${d.a.split(":")[0]}|${d.b.split(":")[0]}|${d.lines}`),
      title: `${d.lines} lines duplicated between ${d.a.split(":")[0]} and ${d.b.split(":")[0]}`,
      description: `The same ${d.lines}-line block (ignoring whitespace and comments) appears at ${d.a} and ${d.b}. A fix or rule change made in one copy is easily missed in the other — a common source of "fixed it, but it still happens" bugs.`,
      severity: "info",
      confidence: "confirmed",
      rationale: "Exact match of normalised source lines.",
      asset,
      location: d.a,
      evidence: [
        { source: d.a, detail: "first copy" },
        { source: d.b, detail: "second copy" },
      ],
      evidenceSource: "orbis:code-guardian",
      remediation:
        "Benefit: one place to change. Extract the shared logic into a function both call, if they really must stay identical; leave them separate if they're expected to diverge. Risk: low; test both call sites.",
      references: [],
    });
  for (const fn of summary.complexFunctions.slice(0, 5))
    findings.push({
      agent: "code_guardian",
      ruleId: "arch.complex-function",
      fingerprint: fingerprint("code_guardian", "arch.complex-function", asset, `${fn.file}:${fn.name}`),
      title: `${fn.name} in ${fn.file} has ${fn.complexity} decision points over ${fn.lines} lines`,
      description: `Functions with this many branches are hard to test completely (each path needs its own case) and are where edge-case bugs tend to hide. Threshold: ${T.complexFunction} decision points.`,
      severity: "info",
      confidence: "confirmed",
      rationale: "Counted if/loop/case/catch/&&/||/??/ternaries in the function body (an approximation of cyclomatic complexity).",
      asset,
      location: `${fn.file}:${fn.line}`,
      evidence: [{ source: `${fn.file}:${fn.line}`, detail: `${fn.lines} lines, complexity ${fn.complexity}` }],
      evidenceSource: "orbis:code-guardian",
      remediation:
        "Benefit: smaller pieces with their own tests. Split it along its natural steps when you next change it, adding tests for each branch first. Not urgent on its own — don't refactor working code just for the number.",
      references: [],
    });
  return { findings, summary };
}
