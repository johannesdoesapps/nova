import type { ClaimStatus } from "../claims/types";

/**
 * How a claim's result is shown. The wording is about the sources reviewed,
 * never about truth: "supported" means the sources Orbis read state it, not
 * that it is verified to be true.
 */
export type Category = "supported" | "partly" | "contradicted" | "disagree" | "insufficient" | "opinion" | "unchecked";

export const CATEGORIES: Record<Category, { label: string; short: string; tone: "good" | "partial" | "bad" | "mixed" | "neutral" }> = {
  supported: { label: "Supported by the sources reviewed", short: "Supported", tone: "good" },
  partly: { label: "Partly supported by the sources reviewed", short: "Partly supported", tone: "partial" },
  contradicted: { label: "Contradicted by the sources reviewed", short: "Contradicted", tone: "bad" },
  disagree: { label: "Sources disagree", short: "Sources disagree", tone: "mixed" },
  insufficient: { label: "Insufficient evidence", short: "Insufficient evidence", tone: "neutral" },
  opinion: { label: "Opinion: evidence can't settle it", short: "Opinion", tone: "neutral" },
  unchecked: { label: "Not checked", short: "Not checked", tone: "neutral" },
};

export function categoryOf(status: ClaimStatus | null): Category {
  switch (status) {
    case "supported":
      return "supported";
    case "partially_supported":
      return "partly";
    case "contradicted":
      return "contradicted";
    case "contested":
      return "disagree";
    case "insufficient":
      return "insufficient";
    case "not_checkable":
      return "opinion";
    default:
      return "unchecked";
  }
}

/** The order results are listed in: problems first. */
export const CATEGORY_ORDER: Category[] = ["contradicted", "disagree", "insufficient", "partly", "supported", "opinion", "unchecked"];

/** A one-sentence finding from the counts behind a status. */
export function findingFor(status: ClaimStatus | null, n: { supporting: number; contradicting: number; publishers: number }, reason?: string): string {
  const s = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  switch (status) {
    case "supported":
      return `${s(n.supporting, "passage states", "passages state")} this, from ${s(n.publishers, "publisher", "independent publishers")}.`;
    case "partially_supported":
      return "The sources cover this topic but don't state this exact claim.";
    case "contradicted":
      return `${s(n.contradicting, "passage conflicts", "passages conflict")} with this, and none support it.`;
    case "contested":
      return `The sources disagree: ${n.supporting} support it and ${n.contradicting} conflict with it.`;
    case "insufficient":
      return "None of the sources reviewed clearly address this. It may still be correct.";
    case "not_checkable":
      return "This is an opinion or recommendation; evidence can inform it but not settle it.";
    default:
      return reason ?? "This claim wasn't checked against any source.";
  }
}
