import type { ExtractedClaim } from "./extract";
import type { Assessment, ClaimStatus, EvidenceBasis, EvidenceLink, SourceRecord, SupportEstimate } from "./types";

export const ESTIMATE_CAVEAT =
  "Heuristic estimate of how well the retrieved text backs this claim. It is not a probability that the claim is true, and it cannot see anything the sources left out.";

/**
 * Turn evidence links into a status. The status vocabulary is about evidence,
 * not truth: "insufficient" means NOVA found nothing to check against — the
 * claim may still be correct.
 */
export function assessClaim(claim: ExtractedClaim, links: EvidenceLink[], sources: SourceRecord[]): Assessment {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const counted = links.filter((l) => l.quoteVerified || l.judgedBy === "user");
  const supports = counted.filter((l) => l.stance === "supports");
  const contradicts = counted.filter((l) => l.stance === "contradicts");
  const publishers = new Set(supports.map((l) => byId.get(l.sourceId)?.publisher ?? l.sourceId));
  const direct = supports.some((l) => l.directness === "direct");

  let status: ClaimStatus;
  if (claim.kind === "opinion" && supports.length === 0 && contradicts.length === 0) status = "not_checkable";
  else if (supports.length && contradicts.length) status = "contested";
  else if (contradicts.length) status = "contradicted";
  else if (supports.length) status = direct ? "supported" : "partially_supported";
  else status = "insufficient";

  const basis: EvidenceBasis = direct ? "direct" : supports.length || claim.origin === "ai_inference" ? "inference" : "none";

  const explanation: string[] = [];
  if (status === "not_checkable") explanation.push("Opinion or recommendation — evidence can inform it but cannot settle it.");
  if (supports.length) explanation.push(`${supports.length} passage(s) support it, from ${publishers.size} independent publisher(s).`);
  if (contradicts.length) explanation.push(`${contradicts.length} passage(s) conflict with it.`);
  if (!supports.length && !contradicts.length && status !== "not_checkable")
    explanation.push("No retrieved passage clearly addresses this claim.");
  if (claim.origin === "ai_inference") explanation.push("The answer presents this as interpretation, not as something a source states.");

  const limitations: string[] = [];
  const used = links.map((l) => byId.get(l.sourceId)).filter(Boolean) as SourceRecord[];
  const support = supports.map((l) => byId.get(l.sourceId)).filter(Boolean) as SourceRecord[];
  if (used.length && used.every((s) => s.contentKind === "snippet")) limitations.push("Checked against search snippets only, not full documents.");
  if (supports.length && publishers.size === 1) limitations.push("Only one independent publisher supports it.");
  if (support.length && support.every((s) => !s.reliability.hasDate)) limitations.push("Supporting sources are undated.");
  if (["statistical", "predictive"].includes(claim.kind) && support.length) {
    const newest = Math.min(...support.map((s) => s.reliability.ageDays ?? Number.POSITIVE_INFINITY));
    if (Number.isFinite(newest) && newest > 2 * 365) limitations.push(`Newest supporting source is ${Math.floor(newest / 365)}+ years old; figures may have changed.`);
  }
  if (supports.length && !direct) limitations.push("Evidence is indirect: it covers the topic but may not state this exact claim.");
  if (links.some((l) => l.cited && l.stance === "insufficient" && l.relevance < 0.35))
    limitations.push("Cites a source whose retrieved text does not appear to contain the claim.");
  if (links.some((l) => !l.quoteVerified && l.judgedBy === "model")) limitations.push("A model judgement was discarded because its quote could not be found in the source.");
  if (links.some((l) => l.judgedBy === "rules" && l.stance !== "insufficient"))
    limitations.push("Stance was detected with keyword rules, which can miss sarcasm, hedging and context.");
  if (support.length && support.every((s) => ["blog_forum", "unknown", "user_provided"].includes(s.reliability.sourceType)))
    limitations.push("All supporting sources are of unknown or informal type.");

  return {
    status,
    basis,
    supporting: supports.length,
    contradicting: contradicts.length,
    independentSupportingPublishers: publishers.size,
    estimate: estimateSupport(status, supports, contradicts, publishers.size, used),
    limitations,
    explanation,
  };
}

function estimateSupport(
  status: ClaimStatus,
  supports: EvidenceLink[],
  contradicts: EvidenceLink[],
  independent: number,
  used: SourceRecord[],
): SupportEstimate | null {
  if (status === "not_checkable") return null;
  const best = Math.max(0, ...supports.map((l) => l.relevance));
  let v = 0.2 + 0.35 * best + 0.12 * Math.min(independent, 3) - 0.22 * contradicts.length;
  if (supports.some((l) => l.directness === "direct")) v += 0.08;
  // Snippet-only evidence can never reach the top band.
  if (used.length && used.every((s) => s.contentKind === "snippet")) v = Math.min(v, 0.69);
  v = Math.max(0.03, Math.min(0.9, v));
  const value = Math.round(v * 100) / 100;
  return {
    value,
    band: value >= 0.7 ? "strong" : value >= 0.4 ? "moderate" : "weak",
    method: "0.20 + 0.35×best relevance + 0.12×independent publishers (max 3) + 0.08 if direct − 0.22×contradictions; capped at 0.69 for snippet-only evidence.",
    judgedBy: supports.some((l) => l.judgedBy === "user") ? "user" : supports.some((l) => l.judgedBy === "model") ? "model" : "rules",
    caveat: ESTIMATE_CAVEAT,
  };
}
