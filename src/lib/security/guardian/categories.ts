/**
 * Code Guardian findings are either security findings (code., secret., deps., map., config., py., php., ai.)
 * or engineering findings: defects (quality.), dependency compatibility (compat.) and maintainability (arch.).
 * Security views count only the first kind; the Code Guardian workspace shows both, separately.
 */

export const ENGINEERING_PREFIXES = ["quality.", "compat.", "arch."] as const;
export const isEngineering = (ruleId: string) => ENGINEERING_PREFIXES.some((p) => ruleId.startsWith(p));

export type EngineeringKind = "defect" | "dependency" | "maintainability";
export const engineeringKind = (ruleId: string): EngineeringKind | null =>
  ruleId.startsWith("quality.") ? "defect" : ruleId.startsWith("compat.") ? "dependency" : ruleId.startsWith("arch.") ? "maintainability" : null;
export const KIND_LABEL: Record<EngineeringKind, string> = { defect: "Defects", dependency: "Dependencies & compatibility", maintainability: "Maintainability" };
