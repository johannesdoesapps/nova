import type { Capability, ModelWithStatus } from "./types";

/** Picker categories, derived from registry capabilities (no hardcoded model names). */
export const MODEL_CATEGORIES = [
  { id: "recommended", label: "Recommended" },
  { id: "reasoning", label: "Reasoning" },
  { id: "coding", label: "Coding" },
  { id: "writing", label: "Writing" },
  { id: "fast", label: "Fast & economical" },
  { id: "multimodal", label: "Multimodal" },
] as const;
export type ModelCategory = (typeof MODEL_CATEGORIES)[number]["id"];

const has = (m: ModelWithStatus, c: Capability) => m.capabilities.includes(c);

export function inCategory(m: ModelWithStatus, c: ModelCategory, recommended: Set<string>): boolean {
  switch (c) {
    case "recommended":
      return recommended.has(m.id);
    case "reasoning":
      return has(m, "reasoning");
    case "coding":
      return has(m, "coding");
    case "writing":
      return has(m, "writing");
    case "fast":
      return has(m, "fast") || has(m, "low-cost");
    case "multimodal":
      return has(m, "vision");
  }
}

/** Recommended: the default model plus the first available model for reasoning and for fast, everyday use. */
export function recommendedIds(models: ModelWithStatus[]): Set<string> {
  const avail = models.filter((m) => m.available && m.provider !== "demo");
  const picks = [
    avail.find((m) => m.isDefault) ?? avail[0],
    avail.find((m) => has(m, "reasoning")),
    avail.find((m) => has(m, "fast") || has(m, "low-cost")),
  ];
  return new Set(picks.filter(Boolean).map((m) => m!.id));
}

/** Short capability tags for the picker. Only shown when the registry says so. */
export function modelTags(m: ModelWithStatus): string[] {
  const tags: string[] = [];
  if (has(m, "fast")) tags.push("Fast");
  if (has(m, "reasoning")) tags.push("Reasoning");
  if (has(m, "vision")) tags.push("Images");
  if (m.contextWindow && m.contextWindow >= 500_000) {
    tags.push(m.contextWindow >= 1_000_000 ? `${+(m.contextWindow / 1_000_000).toFixed(1)}M context` : `${Math.round(m.contextWindow / 1000)}K context`);
  }
  return tags;
}

/** "$0.10 / $0.50 per 1M tokens" when both prices are known, else null. */
export function priceLabel(m: ModelWithStatus): string | null {
  if (m.inputPrice === null || m.outputPrice === null || m.provider === "demo") return null;
  const f = (n: number) => `$${n < 1 ? n.toFixed(2) : n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `${f(m.inputPrice)} in / ${f(m.outputPrice)} out per 1M tokens`;
}
