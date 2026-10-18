import { extractJson } from "../claims/llm";
import type { CheckerSpec } from "./types";

export interface CheckResult {
  passed: boolean;
  score: number;
  detail: string;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[`*_"'“”‘’]/g, "")
    .replace(/[.\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The last non-empty line, or the line after "Answer:", is treated as the final answer. */
export function finalAnswer(output: string): string {
  const m = output.match(/answer\s*[:：]\s*(.+)/i);
  if (m) return m[1]!.trim();
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** Deterministic, auditable scoring. No LLM-as-judge in the general benchmark. */
export function check(spec: CheckerSpec, output: string): CheckResult {
  const out = output.trim();
  switch (spec.type) {
    case "exact": {
      const got = norm(finalAnswer(out));
      const ok = got === norm(spec.answer) || norm(out) === norm(spec.answer);
      return { passed: ok, score: ok ? 1 : 0, detail: ok ? "Exact match." : `Expected “${spec.answer}”, got “${finalAnswer(out).slice(0, 80)}”.` };
    }
    case "contains_all": {
      const n = norm(out);
      const found = spec.values.filter((v) => n.includes(norm(v)));
      return { passed: found.length === spec.values.length, score: found.length / spec.values.length, detail: `Found ${found.length}/${spec.values.length} required terms.` };
    }
    case "contains_any": {
      const n = norm(out);
      const hit = spec.values.find((v) => n.includes(norm(v)));
      return { passed: Boolean(hit), score: hit ? 1 : 0, detail: hit ? `Contains “${hit}”.` : `None of: ${spec.values.join(", ")}.` };
    }
    case "regex": {
      let ok = false;
      try {
        ok = new RegExp(spec.pattern, spec.flags ?? "i").test(out);
      } catch {
        return { passed: false, score: 0, detail: "Invalid regex in test item." };
      }
      return { passed: ok, score: ok ? 1 : 0, detail: ok ? "Pattern matched." : `Did not match /${spec.pattern}/.` };
    }
    case "numeric": {
      const nums = (finalAnswer(out).match(/-?\d[\d,]*(?:\.\d+)?/g) ?? out.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? []).map((x) => Number(x.replace(/,/g, "")));
      const got = nums[nums.length - 1];
      const ok = got !== undefined && Math.abs(got - spec.answer) <= spec.tolerance;
      return { passed: ok, score: ok ? 1 : 0, detail: got === undefined ? "No number found." : ok ? `Got ${got} (expected ${spec.answer}).` : `Got ${got}, expected ${spec.answer} ± ${spec.tolerance}.` };
    }
    case "json_keys": {
      const j = extractJson(out);
      if (!j || typeof j !== "object" || Array.isArray(j)) return { passed: false, score: 0, detail: "No JSON object found." };
      const have = spec.keys.filter((k) => k in (j as Record<string, unknown>));
      return { passed: have.length === spec.keys.length, score: have.length / spec.keys.length, detail: `JSON has ${have.length}/${spec.keys.length} required keys.` };
    }
    case "bullets": {
      const bullets = out.split("\n").filter((l) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(l));
      const countOk = bullets.length === spec.count;
      const tooLong = spec.maxWords ? bullets.filter((b) => b.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").split(/\s+/).length > spec.maxWords!) : [];
      const ok = countOk && tooLong.length === 0;
      const parts = [countOk ? `${bullets.length} bullets.` : `Expected ${spec.count} bullets, got ${bullets.length}.`];
      if (tooLong.length) parts.push(`${tooLong.length} bullet(s) over ${spec.maxWords} words.`);
      return { passed: ok, score: (countOk ? 0.5 : 0) + (tooLong.length === 0 ? 0.5 : 0), detail: parts.join(" ") };
    }
    case "lowercase": {
      const letters = out.replace(/[^A-Za-z]/g, "");
      const ok = letters.length > 0 && letters === letters.toLowerCase();
      return { passed: ok, score: ok ? 1 : 0, detail: ok ? "All lowercase." : "Contains uppercase letters." };
    }
    case "not_stated": {
      const n = norm(out);
      const says = /not (?:stated|mentioned|specified|given|provided)|does not (?:say|state|mention|specify)|doesn't (?:say|state|mention)|no information|cannot be determined|unknown/.test(n);
      const leaked = (spec.forbidden ?? []).filter((f) => n.includes(norm(f)));
      const ok = says && leaked.length === 0;
      return { passed: ok, score: ok ? 1 : 0, detail: ok ? "Correctly said the passage does not state it." : leaked.length ? `Invented an answer (${leaked.join(", ")}).` : "Did not acknowledge the information is missing." };
    }
  }
}
