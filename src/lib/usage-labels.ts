/** Plain names for the features recorded with each request (model_runs.purpose). Unknown ones show as recorded. */
const FEATURES: [RegExp, string][] = [
  [/^chat$/, "Chat"],
  [/^agent$/, "Agents"],
  [/^council/, "Council"],
  [/^(arena|compare)/, "Arena"],
  [/^code_agent$/, "Coding agent"],
  [/^bug_fix$/, "Bug fixing"],
  [/^qa_testing$/, "QA testing"],
  [/^code_ai$/, "Code quick edit"],
  [/^code_run$/, "Run code"],
  [/^code_workspace$/, "Code computer time"],
  [/^mission/, "Missions"],
  [/^template$/, "Templates"],
  [/^connector/, "Connectors"],
  [/^search$/, "Web search"],
  [/^(verify|claims|hypotheses|trial|benchmark|route)$/, "Research tools"],
  [/^(security|sentinel|reviewer|builder|architect|archaeologist)$/, "Security team"],
  [/^workforce$/, "Workforce"],
  [/^code_review$/, "Code review"],
  [/^deep_research$/, "Deep research"],
];

export function featureLabel(purpose: string | null | undefined): string {
  const p = purpose ?? "chat";
  return FEATURES.find(([re]) => re.test(p))?.[1] ?? p;
}

export interface UsageRow {
  at: string;
  model: string;
  requested: string | null;
  fallbackFrom: string | null;
  feature: string;
  units: number | null;
  status: "success" | "error";
  errorCode: string | null;
  notCounted: boolean;
  /** Why it used these units (usage-explain.ts), worked out on the server from the record. */
  why?: string;
  paidWithCredits?: boolean;
}

/** Totals by a key (day, model or feature), largest first; units only from the records. */
export function groupUsage(rows: UsageRow[], by: "day" | "model" | "feature", locale?: string): { key: string; requests: number; units: number; failed: number }[] {
  const out = new Map<string, { key: string; requests: number; units: number; failed: number }>();
  for (const r of rows) {
    const key = by === "day" ? new Date(r.at).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" }) : by === "model" ? r.model : featureLabel(r.feature);
    const g = out.get(key) ?? { key, requests: 0, units: 0, failed: 0 };
    g.requests += 1;
    g.units += r.notCounted ? 0 : (r.units ?? 0);
    if (r.status === "error") g.failed += 1;
    out.set(key, g);
  }
  const list = [...out.values()];
  // Days stay in date order (newest first, as the rows are); the rest by units used.
  return by === "day" ? list : list.sort((a, b) => b.units - a.units || b.requests - a.requests);
}
