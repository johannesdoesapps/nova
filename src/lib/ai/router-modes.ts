/**
 * Auto model ids and Smart Router modes. Kept apart from the platform
 * settings schema so screens that only need these don't download zod.
 */

export const AUTO_MODEL_ID = "auto";

/**
 * Smart Router preferences. "auto" is balanced; the others bias the same
 * published rules toward speed, reasoning depth, sources or code. Chosen as
 * "auto:<mode>" in the model selector.
 */
export const ROUTER_MODES = [
  { id: "balanced", label: "Auto", blurb: "The lowest-cost model for everyday requests; a stronger one only for hard coding or reasoning tasks." },
  { id: "quick", label: "Quick", blurb: "Fast, economical models first." },
  { id: "deep", label: "Deep", blurb: "Reasoning models for complex problems." },
  { id: "research", label: "Research", blurb: "Reasoning model plus web sources when search is set up." },
  { id: "coding", label: "Coding", blurb: "Models suited to programming." },
] as const;
export type RouterMode = (typeof ROUTER_MODES)[number]["id"];

export function isAutoId(id: string | null | undefined): boolean {
  return id === AUTO_MODEL_ID || (!!id && id.startsWith(`${AUTO_MODEL_ID}:`) && ROUTER_MODES.some((m) => `${AUTO_MODEL_ID}:${m.id}` === id));
}

export function routerModeOf(id: string | null | undefined): RouterMode {
  const mode = id?.startsWith(`${AUTO_MODEL_ID}:`) ? id.slice(AUTO_MODEL_ID.length + 1) : "balanced";
  return (ROUTER_MODES.find((m) => m.id === mode)?.id ?? "balanced") as RouterMode;
}

export function autoIdFor(mode: RouterMode): string {
  return mode === "balanced" ? AUTO_MODEL_ID : `${AUTO_MODEL_ID}:${mode}`;
}
