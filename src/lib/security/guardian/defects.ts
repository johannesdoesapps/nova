import { redactAll } from "../../secrets";
import { fingerprint, type Confidence, type FindingDraft, type Severity } from "../types";
import { codeOnly, isTestPath, langOf, lineIndex, lineText, matchBrace, type Lang, type SourceFile } from "./source";

/**
 * Defect rules: code patterns that are wrong (or very likely wrong) regardless of the project — the kind of
 * bug that compiles, looks fine and passes a happy-path test. Each rule says what fails and when, why it
 * matters, how to fix it and how to test the fix, and carries its own positive and negative test cases
 * (run in the test suite). Rules match text with comments removed and string contents blanked, so code
 * samples in strings and commented-out code don't count. They are heuristics: "firm" rules match patterns
 * that are wrong in practically every case; "tentative" ones need a person to look at the context.
 */

export const DEFECT_CATEGORIES = ["logic", "async", "data", "integration", "resource", "performance", "error_handling"] as const;
export type DefectCategory = (typeof DEFECT_CATEGORIES)[number];
export const CATEGORY_LABEL: Record<DefectCategory, string> = {
  logic: "Logic and correctness",
  async: "Async and runtime",
  data: "Data and dates",
  integration: "API and integration",
  resource: "Resource leaks",
  performance: "Performance",
  error_handling: "Error handling",
};

export interface DefectHit {
  line: number;
  /** Extra detail for this occurrence (e.g. the duplicated label). */
  detail?: string;
}

export interface FileCtx {
  path: string;
  lang: Lang;
  /** Original text. */
  raw: string;
  /** Comments removed, string contents blanked (offsets unchanged). */
  code: string;
  lineOf: (index: number) => number;
  /** Client-side React file ("use client", hooks, or .jsx/.tsx using hooks). */
  client: boolean;
}

export interface DefectRule {
  id: string;
  version: string;
  title: string;
  category: DefectCategory;
  langs: Lang[];
  severity: Severity;
  confidence: Confidence;
  /** When it goes wrong. */
  scenario: string;
  /** Why it matters. */
  impact: string;
  fix: string;
  /** How to prove the fix. */
  test: string;
  detect: (f: FileCtx) => DefectHit[];
  tests: { name: string; path: string; code: string; expect: number }[];
}

const JS: Lang[] = ["ts", "js"];
const hits = (f: FileCtx, re: RegExp, on: "code" | "raw" = "code"): DefectHit[] => {
  const out: DefectHit[] = [];
  for (const m of (on === "code" ? f.code : f.raw).matchAll(re)) {
    // A raw-text match must start in code (not in a comment or string).
    if (on === "raw" && f.code.slice(m.index!, m.index! + 3).trim() === "") continue;
    out.push({ line: f.lineOf(m.index!) });
  }
  return out;
};

/** Text of the statement/block following an index, up to `lines` lines. */
const after = (text: string, index: number, lines: number) => {
  let end = index;
  for (let k = 0; k < lines && end >= 0; k++) end = text.indexOf("\n", end + 1);
  return text.slice(index, end < 0 ? text.length : end);
};

/** The full statement starting at `index`: ends at a top-level `;`, or a top-level newline not followed by `.`/`?.`. */
function statementAt(code: string, index: number, max = 4000): string {
  let depth = 0;
  for (let i = index; i < code.length && i < index + max; i++) {
    const c = code[i]!;
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") {
      if (--depth < 0) return code.slice(index, i);
    } else if (depth === 0 && c === ";") return code.slice(index, i);
    else if (depth === 0 && c === "\n" && !/^\s*\??\./.test(code.slice(i + 1, i + 200))) return code.slice(index, i);
  }
  return code.slice(index, index + max);
}

/** The statement with everything inside brackets removed: "a(x).then(y)" → "a().then()". */
function topLevel(stmt: string): string {
  let depth = 0;
  let out = "";
  for (const c of stmt) {
    if ("([{".includes(c)) {
      if (depth++ === 0) out += c;
    } else if (")]}".includes(c)) {
      if (--depth === 0) out += c;
    } else if (depth === 0) out += c;
  }
  return out.replace(/\s+/g, "");
}

/** True when the code at `index` begins a new statement (the previous code character is ; { } or nothing). */
const startsStatement = (code: string, index: number) => /(^|[;{}])\s*$/.test(code.slice(Math.max(0, index - 400), index));

export const DEFECT_RULES: DefectRule[] = [
  {
    id: "async-foreach",
    version: "1.0",
    title: "async callback passed to forEach",
    category: "async",
    langs: JS,
    severity: "medium",
    confidence: "firm",
    scenario: "forEach ignores the promises its callback returns, so the code after the loop runs before the work inside it finishes, and errors thrown inside become unhandled rejections.",
    impact: "Writes or requests that the caller believes are done may still be running (or have failed silently) — classic cause of missing data and flaky behaviour.",
    fix: "Use `for (const x of items) { await … }` for sequential work, or `await Promise.all(items.map(async (x) => …))` for parallel work.",
    test: "Add a test that awaits the function and then asserts every item's side effect happened (and that a failing item makes the function reject).",
    detect: (f) => hits(f, /\.forEach\(\s*async\b/g),
    tests: [
      { name: "async forEach", path: "a.ts", code: "items.forEach(async (i) => { await save(i); });", expect: 1 },
      { name: "for of await", path: "a.ts", code: "for (const i of items) await save(i);", expect: 0 },
      { name: "in a string", path: "a.ts", code: 'const s = "items.forEach(async (i) => x)";', expect: 0 },
    ],
  },
  {
    id: "useeffect-async",
    version: "1.0",
    title: "useEffect callback is async",
    category: "async",
    langs: JS,
    severity: "medium",
    confidence: "firm",
    scenario:
      "React expects the effect to return a cleanup function or nothing; an async effect returns a promise, so cleanup never runs and a slow response can update state after the component unmounted or after newer input.",
    impact: "Race conditions (stale data shown), state updates on unmounted components and leaked subscriptions.",
    fix: "Define an async function inside the effect and call it; track cancellation (`let cancelled = false; … return () => { cancelled = true; }`) or use an AbortController.",
    test: "Render the component, change its input twice quickly with the first request resolving last, and assert the newest data is shown.",
    detect: (f) => hits(f, /\buse(?:Layout)?Effect\(\s*async\b/g),
    tests: [
      { name: "async effect", path: "c.tsx", code: "useEffect(async () => { setX(await load()); }, []);", expect: 1 },
      { name: "inner async", path: "c.tsx", code: "useEffect(() => { void (async () => setX(await load()))(); }, []);", expect: 0 },
    ],
  },
  {
    id: "nan-compare",
    version: "1.0",
    title: "comparison with NaN",
    category: "logic",
    langs: JS,
    severity: "medium",
    confidence: "firm",
    scenario: "NaN is not equal to anything, including itself, so `x === NaN` is always false and `x !== NaN` always true.",
    impact: "The check never detects invalid numbers; bad values flow on into calculations or storage.",
    fix: "Use `Number.isNaN(x)` (or `!Number.isFinite(x)` to also reject Infinity).",
    test: 'Unit-test the function with NaN input (e.g. `Number("abc")`) and assert it\'s rejected.',
    detect: (f) => hits(f, /[=!]==?\s*NaN\b|\bNaN\s*[=!]==?/g),
    tests: [
      { name: "=== NaN", path: "a.ts", code: "if (n === NaN) return 0;", expect: 1 },
      { name: "isNaN", path: "a.ts", code: "if (Number.isNaN(n)) return 0;", expect: 0 },
    ],
  },
  {
    id: "typeof-impossible",
    version: "1.0",
    title: "typeof compared with a value it never returns",
    category: "logic",
    langs: JS,
    severity: "medium",
    confidence: "firm",
    scenario: 'typeof only returns "string", "number", "bigint", "boolean", "symbol", "undefined", "object" or "function"; comparing it with "array", "null", "date" and similar is always false.',
    impact: "The branch never runs (or always runs, with !==), so arrays, null or dates are handled by the wrong code.",
    fix: "Use `Array.isArray(x)`, `x === null`, `x instanceof Date`, `Number.isInteger(x)` as appropriate.",
    test: "Call the code with an array/null/Date and assert the intended branch runs.",
    detect: (f) => hits(f, /\btypeof\s+[\w$.[\]]+\s*[=!]==?\s*["'](?:array|null|date|list|integer|int|float|regexp|nan|object array)["']/gi, "raw"),
    tests: [
      { name: "array", path: "a.ts", code: 'if (typeof v === "array") return v;', expect: 1 },
      { name: "object", path: "a.ts", code: 'if (typeof v === "object") return v;', expect: 0 },
    ],
  },
  {
    id: "assign-in-condition",
    version: "1.0",
    title: "assignment inside an if/while condition",
    category: "logic",
    langs: JS,
    severity: "medium",
    confidence: "firm",
    scenario: "`if (a = b)` assigns b to a and tests the assigned value, instead of comparing them; it's usually a typo for `===`.",
    impact: "The condition depends on the assigned value and the variable is silently overwritten.",
    fix: "Use `===` for a comparison. If the assignment is intended, wrap it in extra parentheses and compare explicitly: `if ((m = re.exec(s)) !== null)`.",
    test: "Unit-test both branches with values that differ.",
    detect: (f) => hits(f, /\b(?:if|while)\s*\(\s*[\w$.]+\s*=\s*(?![=>])[^=)][^)]*\)/g),
    tests: [
      { name: "assign", path: "a.ts", code: "if (user.role = 'admin') grant();", expect: 1 },
      { name: "compare", path: "a.ts", code: "if (user.role === 'admin') grant();", expect: 0 },
      { name: "double parens", path: "a.ts", code: "while ((m = re.exec(s))) out.push(m);", expect: 0 },
    ],
  },
  {
    id: "self-compare",
    version: "1.0",
    title: "value compared with itself",
    category: "logic",
    langs: [...JS, "py"],
    severity: "low",
    confidence: "firm",
    scenario: "`x === x` is always true (except for NaN), so the condition doesn't test what was intended — usually a typo for comparing two different values.",
    impact: "The check never fails; the bug it should catch goes through.",
    fix: "Compare the intended values (e.g. `a.id === b.id`); for a NaN test use `Number.isNaN`.",
    test: "Unit-test the comparison with two values that differ.",
    detect: (f) => {
      const out: DefectHit[] = [];
      for (const m of f.code.matchAll(/(?<![\w$.])([\w$]+(?:\.[\w$]+)*)\s*(===|==)\s*([\w$]+(?:\.[\w$]+)*)(?![\w$.([])/g))
        if (m[1] === m[3] && !/^\d+$/.test(m[1]!)) out.push({ line: f.lineOf(m.index!) });
      return out;
    },
    tests: [
      { name: "same", path: "a.ts", code: "if (a.id === a.id) merge();", expect: 1 },
      { name: "different", path: "a.ts", code: "if (a.id === b.id) merge();", expect: 0 },
      { name: "prefix", path: "a.ts", code: "if (a === a.length) x();", expect: 0 },
    ],
  },
  {
    id: "mutate-then-set-state",
    version: "1.0",
    title: "React state mutated in place, then set to the same object",
    category: "logic",
    langs: JS,
    severity: "medium",
    confidence: "firm",
    scenario:
      'React compares state by reference. Pushing/sorting/splicing the existing array and passing the same array to its setter is treated as "no change", so the component may not re-render, and other code holding the old reference sees it change underneath.',
    impact: "UI doesn't update (or updates later, unpredictably); memoised children keep stale data.",
    fix: "Create a new array/object: `setItems([...items, item])`, `setItems(items.toSorted(cmp))`, `setItems(items.filter(...))`.",
    test: "Render the component, trigger the update, and assert the new item appears without any other re-render.",
    detect: (f) => {
      const out: DefectHit[] = [];
      for (const m of f.code.matchAll(/\b([\w$]+)\.(push|splice|unshift|pop|shift|sort|reverse|fill|copyWithin)\(/g)) {
        const name = m[1]!;
        const next = after(f.code, m.index!, 6);
        if (new RegExp(`\\bset[A-Z][\\w$]*\\(\\s*${name.replace(/\$/g, "\\$")}\\s*\\)`).test(next)) out.push({ line: f.lineOf(m.index!) });
      }
      return out;
    },
    tests: [
      { name: "push then set", path: "c.tsx", code: "items.push(item);\nsetItems(items);", expect: 1 },
      { name: "spread", path: "c.tsx", code: "setItems([...items, item]);", expect: 0 },
    ],
  },
  {
    id: "json-parse-storage",
    version: "1.0",
    title: "JSON.parse of browser storage without error handling",
    category: "data",
    langs: JS,
    severity: "medium",
    confidence: "firm",
    scenario: "Stored values can be invalid JSON (an older format, a manual edit, another script or extension writing the same key, a quota-truncated write). JSON.parse then throws.",
    impact: "The page or component crashes on load for that user, every time, until they clear site data.",
    fix: "Wrap the read in try/catch (falling back to a default and optionally removing the bad value) and validate the parsed shape.",
    test: "Set the key to `{not json` in a test and assert the component renders with the default.",
    detect: (f) => {
      const out: DefectHit[] = [];
      for (const m of f.code.matchAll(/JSON\.parse\(\s*(?:window\.)?(?:localStorage|sessionStorage)\.getItem\(/g)) {
        const before = f.code.slice(Math.max(0, m.index! - 600), m.index!);
        const lastTry = before.lastIndexOf("try");
        if (lastTry >= 0 && !/\bcatch\b/.test(before.slice(lastTry))) continue;
        out.push({ line: f.lineOf(m.index!) });
      }
      return out;
    },
    tests: [
      { name: "bare", path: "a.ts", code: 'const s = JSON.parse(localStorage.getItem("k") ?? "{}");', expect: 1 },
      { name: "in try", path: "a.ts", code: 'try {\n  const s = JSON.parse(localStorage.getItem("k") ?? "{}");\n} catch {}', expect: 0 },
    ],
  },
  {
    id: "fetch-no-status-check",
    version: "1.0",
    title: "fetch response used without checking its status",
    category: "integration",
    langs: JS,
    severity: "medium",
    confidence: "tentative",
    scenario:
      "fetch only rejects on network failure; a 4xx/5xx response resolves normally. Reading `.json()` without checking `res.ok`/`res.status` treats an error body (or an HTML error page, which makes .json() throw) as data.",
    impact: "Error responses are shown or stored as if they were real results, or the code crashes with a confusing JSON parse error instead of a clear message.",
    fix: "Check `if (!res.ok) throw new Error(...)` (or handle the status) before reading the body.",
    test: "Mock the endpoint to return 500 with an error body and assert the caller reports the error instead of using the body.",
    detect: (f) => {
      const out: DefectHit[] = [];
      for (const m of f.code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*await\s+fetch\(/g)) {
        const v = m[1]!.replace(/\$/g, "\\$");
        const next = after(f.code, m.index!, 25);
        const rest = next.slice(next.indexOf("\n"));
        // Handled when the status is checked, the response goes to a helper, or the parsed body's ok/error field is checked.
        if (new RegExp(`\\b${v}\\.(json|text)\\(`).test(next) && !new RegExp(`\\b${v}\\.(ok|status)\\b|\\b${v}\\s*\\)|\\(${v}\\b`).test(rest) && !/\??\.(ok|error)\b/.test(rest))
          out.push({ line: f.lineOf(m.index!) });
      }
      return out;
    },
    tests: [
      { name: "no check", path: "a.ts", code: "const res = await fetch(url);\nconst data = await res.json();\nreturn data.items;", expect: 1 },
      { name: "ok check", path: "a.ts", code: "const res = await fetch(url);\nif (!res.ok) throw new Error('x');\nreturn res.json();", expect: 0 },
      { name: "passed to helper", path: "a.ts", code: "const res = await fetch(url);\nawait assertOk(res);\nreturn res.json();", expect: 0 },
      { name: "body ok field", path: "a.ts", code: "const res = await fetch(url);\nconst body = await res.json();\nif (body?.ok) done();", expect: 0 },
    ],
  },
  {
    id: "json-unawaited",
    version: "1.0",
    title: "response body read without await",
    category: "async",
    langs: JS,
    severity: "high",
    confidence: "firm",
    scenario: "`res.json()` returns a promise. Assigning it without `await` and then reading fields gives undefined (or `[object Promise]`).",
    impact: "The data is never actually used; fields read as undefined and the code takes the empty/default path every time.",
    fix: "Await it: `const data = await res.json();`.",
    test: "Unit-test the function with a mocked response and assert the parsed fields are returned.",
    detect: (f) => {
      const out: DefectHit[] = [];
      const fetched = new Set([...f.code.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*await\s+fetch\(/g)].map((m) => m[1]!));
      for (const m of f.code.matchAll(/\b(?:const|let|var)\s+[\w${}\s,]+=\s*([\w$]+)\.json\(\)\s*;?/g)) if (fetched.has(m[1]!)) out.push({ line: f.lineOf(m.index!) });
      return out;
    },
    tests: [
      { name: "no await", path: "a.ts", code: "const res = await fetch(u);\nconst data = res.json();\nreturn data.id;", expect: 1 },
      { name: "await", path: "a.ts", code: "const res = await fetch(u);\nconst data = await res.json();", expect: 0 },
    ],
  },
  {
    id: "error-with-200",
    version: "1.0",
    title: "API route returns an error body with status 200",
    category: "integration",
    langs: JS,
    severity: "medium",
    confidence: "firm",
    scenario: "`NextResponse.json({ error: … })` / `Response.json({ error: … })` without a status option responds 200 OK.",
    impact: "Clients that check `res.ok` (and caches, monitoring and retries) treat the failure as success; errors go unnoticed.",
    fix: "Pass the right status: `NextResponse.json({ error }, { status: 400 })` (or 401/403/404/500 as appropriate).",
    test: "Call the route with the failing input and assert the response status is the error code, not 200.",
    detect: (f) => {
      if (!/(^|\/)(app|pages)\/.*(route|\[.+\]|api\/.+)\.[cm]?[jt]s$|(^|\/)api\//.test(f.path)) return [];
      const out: DefectHit[] = [];
      for (const m of f.code.matchAll(/\b(?:NextResponse|Response)\.json\(\s*\{\s*error\b/g)) {
        const open = f.code.indexOf("(", m.index!);
        let depth = 0;
        let end = open;
        for (; end < f.code.length && end < open + 600; end++) {
          if (f.code[end] === "(") depth++;
          else if (f.code[end] === ")" && --depth === 0) break;
        }
        if (!/\bstatus\s*:/.test(f.code.slice(open, end))) out.push({ line: f.lineOf(m.index!) });
      }
      return out;
    },
    tests: [
      { name: "no status", path: "app/api/x/route.ts", code: 'return NextResponse.json({ error: "bad" });', expect: 1 },
      { name: "status", path: "app/api/x/route.ts", code: 'return NextResponse.json({ error: "bad" }, { status: 400 });', expect: 0 },
      { name: "not a route", path: "lib/x.ts", code: 'return NextResponse.json({ error: "bad" });', expect: 0 },
    ],
  },
  {
    id: "interval-not-cleared",
    version: "1.0",
    title: "setInterval in a component that never calls clearInterval",
    category: "resource",
    langs: JS,
    severity: "medium",
    confidence: "firm",
    scenario: "Each mount starts a timer that outlives the component; remounts (navigation, StrictMode in development) stack more timers.",
    impact: "Growing CPU/network use, duplicate requests and state updates on unmounted components.",
    fix: "Keep the id and clear it in the effect's cleanup: `const id = setInterval(…); return () => clearInterval(id);`.",
    test: "Mount and unmount the component with fake timers and assert the callback stops running after unmount.",
    // Skipped when the file defines its own setInterval (e.g. a state setter named that way).
    detect: (f) =>
      f.client && !/\bclearInterval\(/.test(f.code) && !/\b(?:const|let|var|function)\s+setInterval\b|[,[]\s*setInterval\s*[\],]/.test(f.code)
        ? hits(f, /(?<![\w$.])(?:window\.)?setInterval\(/g).slice(0, 1)
        : [],
    tests: [
      { name: "own setter", path: "c.tsx", code: '"use client";\nconst setInterval = (i) => setPeriod(i);\nsetInterval("year");', expect: 0 },
      { name: "never cleared", path: "c.tsx", code: '"use client";\nuseEffect(() => { setInterval(tick, 1000); }, []);', expect: 1 },
      { name: "cleared", path: "c.tsx", code: '"use client";\nuseEffect(() => { const id = setInterval(tick, 1000); return () => clearInterval(id); }, []);', expect: 0 },
    ],
  },
  {
    id: "listener-not-removed",
    version: "1.0",
    title: "event listener added in a component and never removed",
    category: "resource",
    langs: JS,
    severity: "low",
    confidence: "tentative",
    scenario: "A listener added to window/document in an effect without removeEventListener (or an AbortController signal, or `once`) stays after unmount; each remount adds another.",
    impact: "Handlers run for components that no longer exist (errors, duplicate actions) and memory is retained.",
    fix: "Remove it in the effect cleanup, or pass `{ signal }` from an AbortController you abort in cleanup.",
    test: "Mount/unmount twice, dispatch the event, and assert the handler ran once (or not at all).",
    detect: (f) =>
      f.client && /\buse(?:Layout)?Effect\(/.test(f.code) && !/\bremoveEventListener\(|\bsignal\b|\bonce\s*:/.test(f.code) ? hits(f, /\b(?:window|document)\.addEventListener\(/g).slice(0, 1) : [],
    tests: [
      { name: "never removed", path: "c.tsx", code: '"use client";\nuseEffect(() => { window.addEventListener("resize", onResize); }, []);', expect: 1 },
      { name: "removed", path: "c.tsx", code: '"use client";\nuseEffect(() => { window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);', expect: 0 },
    ],
  },
  {
    id: "sequential-io-in-loop",
    version: "1.0",
    title: "awaited network or database call inside a loop",
    category: "performance",
    langs: JS,
    severity: "low",
    confidence: "tentative",
    scenario: "Each iteration waits for the previous request: 50 items × 100 ms = 5 s. With a query per item it's the N+1 pattern.",
    impact: "Latency grows linearly with the data; requests time out as data grows.",
    fix: 'Batch the query (`.in("id", ids)`, a join) or run independent calls with Promise.all (with a concurrency limit if needed). Keep it sequential only where order or rate limits require it — and say so in a comment.',
    test: "Measure the function with 1 and 50 items before and after (or count queries in a test with a mocked client).",
    detect: (f) => {
      const out: DefectHit[] = [];
      for (const m of f.code.matchAll(/\bfor\s*\((?:const|let|var)\s+[^)]*\s(?:of|in)\s[^)]*\)\s*\{/g)) {
        const open = m.index! + m[0].length - 1;
        const close = matchBrace(f.code, open);
        if (close < 0) continue;
        const body = f.code.slice(open, close);
        const io = /\bawait\s+(?:[\w$.]+\.)?(?:fetch\(|from\(|query\(|rpc\(|find\w*\(|select\(|insert\(|update\(|upsert\(|execute\(|get\(|post\()/.exec(body);
        if (io) out.push({ line: f.lineOf(open + io.index) });
      }
      return out.slice(0, 3);
    },
    tests: [
      { name: "query per item", path: "a.ts", code: 'for (const id of ids) {\n  const { data } = await db.from("t").select("*").eq("id", id);\n}', expect: 1 },
      { name: "batched", path: "a.ts", code: 'const { data } = await db.from("t").select("*").in("id", ids);', expect: 0 },
    ],
  },
  {
    id: "get-year",
    version: "1.0",
    title: "Date.getYear() used",
    category: "data",
    langs: JS,
    severity: "medium",
    confidence: "firm",
    scenario: "getYear() returns the year minus 1900 (126 for 2026).",
    impact: "Wrong years in output, comparisons and stored values.",
    fix: "Use getFullYear() (or getUTCFullYear()).",
    test: "Unit-test with a fixed date and assert the four-digit year.",
    detect: (f) => hits(f, /\.getYear\(\)/g),
    tests: [
      { name: "getYear", path: "a.ts", code: "const y = d.getYear();", expect: 1 },
      { name: "getFullYear", path: "a.ts", code: "const y = d.getFullYear();", expect: 0 },
    ],
  },
  {
    id: "utc-date-as-today",
    version: "1.0",
    title: "today's date taken from the UTC timestamp",
    category: "data",
    langs: JS,
    severity: "low",
    confidence: "tentative",
    scenario: "`new Date().toISOString().slice(0, 10)` is the date in UTC. For a user in UTC−5 it's already tomorrow from 7 pm; in UTC+10 it's still yesterday until 10 am.",
    impact: 'Off-by-one-day bugs in "today" views, daily limits, streaks and date filters for users outside UTC.',
    fix: 'If the user\'s local date is meant, format in their time zone (`toLocaleDateString("en-CA", { timeZone })`); if UTC is intended, say so in the name (e.g. `utcDay`).',
    test: "Run the function with a fixed clock at 23:30 in a negative-offset time zone and assert the expected date.",
    detect: (f) => hits(f, /new Date\(\)\.toISOString\(\)\s*\.(?:slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\)|split\(\s*["']T["']\s*\)\[0\])/g),
    tests: [
      { name: "slice", path: "a.ts", code: "const today = new Date().toISOString().slice(0, 10);", expect: 1 },
      { name: "locale", path: "a.ts", code: 'const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });', expect: 0 },
    ],
  },
  {
    id: "map-parseint",
    version: "1.0",
    title: "parseInt passed directly to map",
    category: "logic",
    langs: JS,
    severity: "medium",
    confidence: "firm",
    scenario: 'map passes (value, index), so parseInt receives the index as the radix: `["1","2","3"].map(parseInt)` is `[1, NaN, NaN]`.',
    impact: "Every value after the first is wrong or NaN.",
    fix: "`.map((s) => parseInt(s, 10))` or `.map(Number)`.",
    test: "Unit-test with at least three values and assert all are parsed.",
    detect: (f) => hits(f, /\.map\(\s*(?:Number\.)?parseInt\s*\)/g),
    tests: [
      { name: "map(parseInt)", path: "a.ts", code: "const n = parts.map(parseInt);", expect: 1 },
      { name: "map(Number)", path: "a.ts", code: "const n = parts.map(Number);", expect: 0 },
    ],
  },
  {
    id: "duplicate-case",
    version: "1.0",
    title: "duplicate case label in a switch",
    category: "logic",
    langs: JS,
    severity: "medium",
    confidence: "firm",
    scenario: "Only the first matching case runs; the second identical label is dead code — usually a copy-paste where a different value was meant.",
    impact: "One of the intended values has no handling and falls to default.",
    fix: "Change the duplicate to the value that was intended (or merge the cases).",
    test: "Unit-test each intended value reaches its own branch.",
    detect: (f) => {
      const out: DefectHit[] = [];
      for (const m of f.code.matchAll(/\bswitch\s*\([^)]*\)\s*\{/g)) {
        const open = m.index! + m[0].length - 1;
        const close = matchBrace(f.code, open);
        if (close < 0) continue;
        const seen = new Map<string, number>();
        // Labels read from the raw text (strings are blanked in code); only top-level cases of this switch.
        let depth = 0;
        for (let i = open + 1; i < close; i++) {
          const c = f.code[i];
          if (c === "{") depth++;
          else if (c === "}") depth--;
          else if (depth === 0 && f.code.startsWith("case", i) && /\W/.test(f.code[i - 1] ?? " ")) {
            const colon = f.code.indexOf(":", i);
            const label = f.raw.slice(i + 4, colon).trim();
            if (seen.has(label)) out.push({ line: f.lineOf(i), detail: `case ${label} (first at line ${seen.get(label)})` });
            else seen.set(label, f.lineOf(i));
          }
        }
      }
      return out;
    },
    tests: [
      { name: "dup", path: "a.ts", code: 'switch (s) {\n  case "a": x(); break;\n  case "a": y(); break;\n}', expect: 1 },
      { name: "distinct", path: "a.ts", code: 'switch (s) {\n  case "a": x(); break;\n  case "b": y(); break;\n}', expect: 0 },
    ],
  },
  {
    id: "floating-then",
    version: "1.0",
    title: "promise chain with no rejection handler",
    category: "error_handling",
    langs: JS,
    severity: "low",
    confidence: "tentative",
    scenario: "A `.then(...)` chain that isn't awaited, returned or ended with `.catch(...)`: if the promise rejects, nothing handles it.",
    impact: "Unhandled rejections (crashes in Node with default settings, silent failures in browsers) and work the caller can't wait for.",
    fix: "Add `.catch(...)` with real handling, or `await` it inside a try/catch, or return it to the caller.",
    test: "Make the underlying call reject in a test and assert the error is handled (no unhandled rejection).",
    detect: (f) => {
      const out: DefectHit[] = [];
      for (const m of f.code.matchAll(/^[ \t]*(?!return\b|await\b|const\b|let\b|var\b|void\b|yield\b|\.)[\w$][\w$.]*\s*\(/gm)) {
        const start = m.index! + m[0].length - m[0].trimStart().length;
        if (!startsStatement(f.code, start)) continue;
        const stmt = statementAt(f.code, start);
        if (/^(if|for|while|switch|else|do|try|catch|function|class|async)\b/.test(stmt)) continue;
        // Only the statement's own call chain counts, not a .then nested inside a callback or block.
        const chain = topLevel(stmt);
        if (/\.then\(\)/.test(chain) && !/\.catch\(\)/.test(chain)) out.push({ line: f.lineOf(start) });
      }
      return out.slice(0, 3);
    },
    tests: [
      { name: "catch after multi-line then", path: "a.ts", code: "fetch(u)\n  .then(async (r) => {\n    const j = await r.json();\n    set(j);\n  })\n  .catch(() => {});", expect: 0 },
      { name: "assigned chain", path: "a.ts", code: "cache ??= fetch(u)\n  .then((r) => r.json());", expect: 0 },
      { name: "receiver on its own line", path: "a.ts", code: "store\n  .load(id)\n  .then((r) => set(r))\n  .catch(fail);", expect: 0 },
      { name: "no catch", path: "a.ts", code: "load(id).then((r) => setData(r));", expect: 1 },
      { name: "catch", path: "a.ts", code: "load(id).then((r) => setData(r)).catch(report);", expect: 0 },
      { name: "returned", path: "a.ts", code: "return load(id).then((r) => r.x);", expect: 0 },
    ],
  },
  {
    id: "empty-catch",
    version: "1.0",
    title: "error caught and ignored without explanation",
    category: "error_handling",
    langs: JS,
    severity: "low",
    confidence: "tentative",
    scenario: "An empty catch block hides every error in the try, including ones nobody anticipated (typos, null data, network failures).",
    impact: "Failures become silent wrong behaviour that's hard to trace.",
    fix: "Handle or log the error, narrow the try to the line that can legitimately fail, or add a comment saying why ignoring it is safe.",
    test: "Force the failure in a test and assert the intended fallback (and that unexpected errors still surface).",
    detect: (f) => hits(f, /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g, "raw"),
    tests: [
      { name: "empty", path: "a.ts", code: "try { run(); } catch (e) {}", expect: 1 },
      { name: "commented", path: "a.ts", code: "try { run(); } catch { /* optional cache */ }", expect: 0 },
    ],
  },
  {
    id: "py-mutable-default",
    version: "1.0",
    title: "mutable default argument",
    category: "logic",
    langs: ["py"],
    severity: "medium",
    confidence: "firm",
    scenario: "The default list/dict is created once when the function is defined and shared by every call that doesn't pass the argument.",
    impact: "Values leak between calls (and between requests in a server): items accumulate, caches cross users.",
    fix: "Default to None and create the object inside: `def f(items=None): items = [] if items is None else items`.",
    test: "Call the function twice without the argument and assert the second call doesn't see the first call's data.",
    detect: (f) => {
      const out: DefectHit[] = [];
      for (const m of f.code.matchAll(/\bdef\s+\w+\s*\(/g)) {
        // Only a parameter's own default counts — not e.g. FastAPI's Body(default={}), which is copied per call.
        const open = m.index! + m[0].length - 1;
        const params: string[] = [];
        let cur = "";
        let depth = 0;
        for (let i = open + 1; i < f.code.length; i++) {
          const c = f.code[i]!;
          if ("([{".includes(c)) depth++;
          else if (")]}".includes(c) && depth-- === 0) break;
          if (c === "," && depth === 0) {
            params.push(cur);
            cur = "";
          } else cur += c;
        }
        params.push(cur);
        if (params.some((p) => /^\s*\w+\s*(?::[^=]+)?=\s*(?:\[\s*\]|\{\s*\}|set\(\)|list\(\)|dict\(\))\s*$/.test(p))) out.push({ line: f.lineOf(m.index!) });
      }
      return out;
    },
    tests: [
      { name: "framework default object", path: "a.py", code: "def run(body: dict = Body(default={}), db = Depends(db_dep)):\n    pass", expect: 0 },
      { name: "typed list default", path: "a.py", code: "def add(x, items: list = []):\n    pass", expect: 1 },
      { name: "list default", path: "a.py", code: "def add(x, items=[]):\n    items.append(x)\n    return items", expect: 1 },
      { name: "None default", path: "a.py", code: "def add(x, items=None):\n    items = items or []", expect: 0 },
    ],
  },
  {
    id: "py-bare-except",
    version: "1.0",
    title: "bare except clause",
    category: "error_handling",
    langs: ["py"],
    severity: "low",
    confidence: "firm",
    scenario: "`except:` also catches KeyboardInterrupt, SystemExit and programming errors (NameError, TypeError).",
    impact: "Bugs are swallowed and processes can't be stopped cleanly.",
    fix: "Catch the specific exceptions you expect (or at least `except Exception:`) and log them.",
    test: "Raise an unexpected exception type in a test and assert it propagates.",
    detect: (f) => hits(f, /^[ \t]*except\s*:/gm),
    tests: [
      { name: "bare", path: "a.py", code: "try:\n    run()\nexcept:\n    pass", expect: 1 },
      { name: "specific", path: "a.py", code: "try:\n    run()\nexcept ValueError:\n    pass", expect: 0 },
    ],
  },
  {
    id: "py-is-literal",
    version: "1.0",
    title: "identity comparison with a literal",
    category: "logic",
    langs: ["py"],
    severity: "medium",
    confidence: "firm",
    scenario: '`x is "text"` / `x is 1000` test object identity, not equality; results depend on interpreter caching and differ between values and Python versions.',
    impact: "The comparison is false for equal values in some cases — intermittent wrong branches.",
    fix: "Use `==` (keep `is` only for None, True, False and sentinels).",
    test: 'Compare with a value built at runtime (e.g. `"te" + "xt"`) and assert the branch runs.',
    detect: (f) => hits(f, /\bis\s+(?:not\s+)?(?:["'][^"'\n]*["']|-?\d+(?:\.\d+)?)(?![\w.])/g, "raw"),
    tests: [
      { name: "is string", path: "a.py", code: 'if status is "done":\n    finish()', expect: 1 },
      { name: "is None", path: "a.py", code: "if status is None:\n    finish()", expect: 0 },
    ],
  },
];

export const defectRuleById = (id: string) => DEFECT_RULES.find((r) => r.id === id || `quality.${r.id}` === id);

function ctxFor(path: string, raw: string): FileCtx {
  const lang = langOf(path);
  const code = codeOnly(raw, lang);
  const client = /^\s*["']use client["']/.test(raw) || (/\.(tsx|jsx)$/.test(path) && /\buse(State|Effect|LayoutEffect|Reducer)\(/.test(code));
  return { path, lang, raw, code, lineOf: lineIndex(code), client };
}

export function runDefectRule(rule: DefectRule, path: string, raw: string): DefectHit[] {
  const f = ctxFor(path, raw);
  return rule.langs.includes(f.lang) ? rule.detect(f) : [];
}

/** Each rule's own test cases. */
export function runDefectRuleTests(rule: DefectRule): { name: string; passed: boolean; expected: number; got: number }[] {
  return rule.tests.map((t) => {
    const got = runDefectRule(rule, t.path, t.code).length;
    return { name: t.name, passed: t.expect === 0 ? got === 0 : got >= t.expect, expected: t.expect, got };
  });
}

const MAX_PER_RULE = 25;

/** Run every defect rule over the code (tests are skipped: patterns there rarely affect users). */
export function scanDefects(files: SourceFile[], asset: string): { findings: FindingDraft[]; filesScanned: number; byRule: Record<string, number>; capped: string[] } {
  const findings: FindingDraft[] = [];
  const byRule: Record<string, number> = {};
  const capped: string[] = [];
  let filesScanned = 0;
  for (const file of files) {
    const lang = langOf(file.path);
    if (lang === "other" || isTestPath(file.path) || /\.d\.ts$|\.min\.js$/.test(file.path) || file.content.length > 400_000) continue;
    filesScanned++;
    const f = ctxFor(file.path, file.content);
    for (const rule of DEFECT_RULES) {
      if (!rule.langs.includes(lang)) continue;
      for (const h of rule.detect(f)) {
        const n = (byRule[rule.id] = (byRule[rule.id] ?? 0) + 1);
        if (n > MAX_PER_RULE) {
          if (n === MAX_PER_RULE + 1) capped.push(rule.id);
          continue;
        }
        const text = redactAll(lineText(file.content, h.line));
        findings.push(defectFinding(rule, file.path, h, text, asset));
      }
    }
  }
  return { findings, filesScanned, byRule, capped };
}

export function defectFinding(rule: DefectRule, path: string, h: DefectHit, text: string, asset: string): FindingDraft {
  return {
    agent: "code_guardian",
    ruleId: `quality.${rule.id}`,
    // Keyed on the line's text, not its number, so the finding survives edits above it.
    fingerprint: fingerprint("code_guardian", `quality.${rule.id}`, asset, path, text.replace(/\s+/g, " ")),
    title: `${rule.title[0]!.toUpperCase()}${rule.title.slice(1)}${h.detail ? ` (${h.detail})` : ""}`,
    description: `What's wrong: ${rule.title}. When it fails: ${rule.scenario} Why it matters: ${rule.impact}`,
    severity: rule.severity,
    confidence: rule.confidence,
    rationale: `${CATEGORY_LABEL[rule.category]} rule ${rule.id} v${rule.version}; ${rule.confidence === "firm" ? "this pattern is wrong in practically every case" : "a heuristic — check the surrounding code before changing it"}.`,
    asset,
    location: `${path}:${h.line}`,
    evidence: [{ source: `${path}:${h.line}`, detail: text }],
    evidenceSource: "orbis:code-guardian",
    remediation: `${rule.fix} How to test the fix: ${rule.test}`,
    references: [],
  };
}
