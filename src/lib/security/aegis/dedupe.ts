import { cvesIn } from "../hunt/intel";
import type { AegisFinding } from "./model";
import { OPEN } from "./model";

/**
 * Duplicate candidates across agents: the same CVE reported twice, the same weakness at the same location, or the
 * same title on the same asset from different scans. These are suggestions — merging is done by a person (mark
 * one as a duplicate of the other on its page), so nothing is hidden automatically.
 */

export interface DuplicateGroup {
  reason: string;
  /** The finding to keep (most severe, then most evidence), followed by its likely duplicates. */
  keep: AegisFinding;
  duplicates: AegisFinding[];
}

const SEV: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const family = (rule: string) =>
  rule
    .split(".")
    .slice(0, 2)
    .join(".")
    .replace(/-[a-z]+$/, "");
const place = (loc: string | null) =>
  (loc ?? "")
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/:\d+$/, "")
    .replace(/\/+$/, "") || null;

export function duplicateCandidates(findings: AegisFinding[]): DuplicateGroup[] {
  const live = findings.filter((f) => OPEN.has(f.status) && !f.duplicate_of);
  const groups = new Map<string, { reason: string; items: AegisFinding[] }>();
  const add = (key: string, reason: string, f: AegisFinding) => {
    const g = groups.get(key) ?? { reason, items: [] };
    if (!g.items.some((x) => x.id === f.id)) g.items.push(f);
    groups.set(key, g);
  };
  for (const f of live) {
    for (const cve of cvesIn(`${f.title} ${f.description}`)) add(`cve:${f.asset}:${cve}`, `Same vulnerability (${cve}) on ${f.asset}`, f);
    const p = place(f.location);
    if (p) add(`loc:${f.asset}:${p}:${family(f.rule_id)}`, `Same kind of issue at ${p}`, f);
    add(`title:${f.asset}:${f.title.toLowerCase()}`, "Same title on the same asset", f);
  }
  const seen = new Set<string>();
  const out: DuplicateGroup[] = [];
  for (const g of [...groups.values()].filter((x) => x.items.length > 1)) {
    const items = [...g.items].sort((a, b) => (SEV[a.severity] ?? 5) - (SEV[b.severity] ?? 5) || b.evidence.length - a.evidence.length || a.first_seen.localeCompare(b.first_seen));
    const key = items
      .map((i) => i.id)
      .sort()
      .join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    // Two different rules from the same agent at the same place are usually distinct issues, not duplicates.
    if (g.reason.startsWith("Same kind") && new Set(items.map((i) => i.agent)).size === 1 && new Set(items.map((i) => i.rule_id)).size > 1) continue;
    out.push({ reason: g.reason, keep: items[0]!, duplicates: items.slice(1) });
  }
  return out.slice(0, 50);
}
