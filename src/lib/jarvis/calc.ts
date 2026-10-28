/**
 * Jarvis's calculator: exact arithmetic for the `calculate` tool, so answers don't depend on the model's mental
 * maths. A small recursive-descent parser over a fixed grammar; nothing is evaluated as code.
 *
 *   expr   = term (("+" | "-") term)*
 *   term   = power (("*" | "/" | "%") power)*      % is the remainder
 *   power  = unary ("^" power)?                     right-associative
 *   unary  = ("-" | "+") unary | call
 *   call   = name "(" args ")" | name | number | "(" expr ")"
 *
 * Functions: sqrt, abs, round(x, digits?), floor, ceil, min, max, log (base 10), ln, exp, sin, cos, tan (radians).
 * Constants: pi, e. Numbers may use a decimal point, an exponent (1.5e3) and thousands separators (1,234.5), but only
 * outside parentheses: inside them a comma always separates function arguments (max(120,450) is 450).
 */

export type CalcResult = { ok: true; value: number; text: string } | { ok: false; error: string };

const FUNCS: Record<string, { min: number; max: number; fn: (...a: number[]) => number }> = {
  sqrt: { min: 1, max: 1, fn: Math.sqrt },
  abs: { min: 1, max: 1, fn: Math.abs },
  round: { min: 1, max: 2, fn: (x, d = 0) => { const f = 10 ** Math.max(0, Math.min(12, Math.trunc(d))); return Math.round(x * f) / f; } },
  floor: { min: 1, max: 1, fn: Math.floor },
  ceil: { min: 1, max: 1, fn: Math.ceil },
  min: { min: 1, max: 20, fn: Math.min },
  max: { min: 1, max: 20, fn: Math.max },
  log: { min: 1, max: 1, fn: Math.log10 },
  ln: { min: 1, max: 1, fn: Math.log },
  exp: { min: 1, max: 1, fn: Math.exp },
  sin: { min: 1, max: 1, fn: Math.sin },
  cos: { min: 1, max: 1, fn: Math.cos },
  tan: { min: 1, max: 1, fn: Math.tan },
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Tok = { t: "num"; v: number } | { t: "name"; v: string } | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  // Inside parentheses a comma separates arguments (max(120,450)), so thousands separators are only read outside them.
  let depth = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      // Thousands separators only in the form 1,234,567(.89): a comma followed by exactly three digits, outside parentheses.
      const m = (depth === 0 ? /^(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d*\.?\d+(?:[eE][+-]?\d+)?)/ : /^\d*\.?\d+(?:[eE][+-]?\d+)?/).exec(src.slice(i));
      if (!m) throw new Error(`Unexpected "${c}".`);
      out.push({ t: "num", v: Number(m[0].replace(/,/g, "")) });
      i += m[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      const m = /^[a-zA-Z_]\w*/.exec(src.slice(i))!;
      out.push({ t: "name", v: m[0].toLowerCase() });
      i += m[0].length;
      continue;
    }
    if ("+-*/^%(),".includes(c)) {
      if (c === "(") depth++;
      else if (c === ")") depth = Math.max(0, depth - 1);
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    if (c === "×") {
      out.push({ t: "op", v: "*" });
      i++;
      continue;
    }
    if (c === "÷") {
      out.push({ t: "op", v: "/" });
      i++;
      continue;
    }
    throw new Error(`Unexpected "${c}".`);
  }
  return out;
}

export function evaluate(expression: string): CalcResult {
  const src = expression.trim();
  if (!src) return { ok: false, error: "Empty expression." };
  if (src.length > 300) return { ok: false, error: "The expression is too long (300 characters at most)." };
  let toks: Tok[];
  try {
    toks = tokenize(src);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  let p = 0;
  let depth = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new Error(`Expected "${v}".`);
    p++;
  };
  const guard = () => {
    if (++depth > 60) throw new Error("The expression is nested too deeply.");
  };

  function expr(): number {
    guard();
    let v = term();
    while (isOp("+") || isOp("-")) v = (toks[p++]!.v === "+" ? 1 : -1) * term() + v;
    depth--;
    return v;
  }
  function term(): number {
    let v = power();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = toks[p++]!.v;
      const r = power();
      if ((op === "/" || op === "%") && r === 0) throw new Error("Division by zero.");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }
  function power(): number {
    const base = unary();
    if (isOp("^")) {
      p++;
      guard();
      const v = base ** power();
      depth--;
      return v;
    }
    return base;
  }
  function unary(): number {
    if (isOp("-") || isOp("+")) {
      const neg = toks[p++]!.v === "-";
      guard();
      const v = unary();
      depth--;
      return neg ? -v : v;
    }
    return primary();
  }
  function primary(): number {
    const t = peek();
    if (!t) throw new Error("The expression ends too early.");
    if (t.t === "num") {
      p++;
      return t.v;
    }
    if (t.t === "op" && t.v === "(") {
      p++;
      const v = expr();
      expect(")");
      return v;
    }
    if (t.t === "name") {
      p++;
      const f = Object.hasOwn(FUNCS, t.v) ? FUNCS[t.v] : undefined;
      if (f) {
        expect("(");
        const args = [expr()];
        while (isOp(",")) {
          p++;
          args.push(expr());
        }
        expect(")");
        if (args.length < f.min || args.length > f.max) throw new Error(`${t.v} takes ${f.min === f.max ? f.min : `${f.min} to ${f.max}`} value${f.max === 1 ? "" : "s"}.`);
        return f.fn(...args);
      }
      if (Object.hasOwn(CONSTS, t.v)) return CONSTS[t.v]!;
      throw new Error(`Unknown name "${t.v}".`);
    }
    throw new Error(`Unexpected "${t.v}".`);
  }

  try {
    const value = expr();
    if (p < toks.length) throw new Error(`Unexpected "${toks[p]!.v}".`);
    if (!Number.isFinite(value)) return { ok: false, error: "The result isn't a finite number." };
    return { ok: true, value, text: formatNumber(value) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Up to 12 significant digits, without floating-point noise (0.1 + 0.2 → 0.3). */
export function formatNumber(v: number): string {
  if (Object.is(v, -0)) return "0";
  const s = Number(v.toPrecision(12)).toString();
  return s.includes("e") ? s : Number(s).toLocaleString("en-US", { maximumFractionDigits: 12, useGrouping: Math.abs(v) >= 10_000 });
}
