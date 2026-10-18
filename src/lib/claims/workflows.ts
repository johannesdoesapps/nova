import { keyTerms } from "./text";
import type { Claim, ClaimStatus, EvidenceBasis, ReportSummary, SourceRecord } from "./types";

const STATUSES: ClaimStatus[] = ["supported", "partially_supported", "contested", "contradicted", "insufficient", "not_checkable"];

export function summarize(claims: Claim[], sources: SourceRecord[]): ReportSummary {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<ClaimStatus, number>;
  const byBasis: Record<EvidenceBasis, number> = { direct: 0, inference: 0, none: 0 };
  for (const c of claims) {
    byStatus[c.assessment.status]++;
    byBasis[c.assessment.basis]++;
  }
  const miscitations = misCitations(claims).length;
  const total = claims.length;
  const checkable = total - byStatus.not_checkable;
  const backed = byStatus.supported + byStatus.partially_supported;
  const headline =
    total === 0
      ? "No checkable claims were found in this text."
      : `${backed} of ${checkable} checkable claim(s) have supporting evidence in the provided sources; ` +
        `${byStatus.insufficient} lack evidence and ${byStatus.contested + byStatus.contradicted} conflict with a source.`;
  return {
    total,
    byStatus,
    byBasis,
    miscitations,
    snippetOnly: sources.length > 0 && sources.every((s) => s.contentKind === "snippet"),
    headline,
  };
}

/** Fact-check queue: everything a careful reader should look at, worst first. */
export function factCheckQueue(claims: Claim[]): Claim[] {
  const rank: Record<ClaimStatus, number> = { contradicted: 0, contested: 1, insufficient: 2, partially_supported: 3, supported: 4, not_checkable: 5 };
  return [...claims].sort((a, b) => rank[a.assessment.status] - rank[b.assessment.status] || a.index - b.index);
}

/** Assertions stated as fact with no supporting evidence. */
export function unsupportedStatements(claims: Claim[]): Claim[] {
  return claims.filter((c) => c.assessment.status === "insufficient" && c.kind !== "opinion");
}

export interface Conflict {
  claim: Claim;
  supporting: { sourceId: string; quote: string }[];
  contradicting: { sourceId: string; quote: string; rationale: string }[];
}

export function conflicts(claims: Claim[]): Conflict[] {
  return claims
    .filter((c) => c.assessment.status === "contested" || c.assessment.status === "contradicted")
    .map((c) => ({
      claim: c,
      supporting: c.evidence.filter((l) => l.stance === "supports").map((l) => ({ sourceId: l.sourceId, quote: l.quote })),
      contradicting: c.evidence.filter((l) => l.stance === "contradicts").map((l) => ({ sourceId: l.sourceId, quote: l.quote, rationale: l.rationale })),
    }));
}

export interface MissingEvidence {
  claim: Claim;
  need: string;
  queries: string[];
}

/** For unsupported or weakly supported claims, say what evidence would help and suggest searches. */
export function missingEvidence(claims: Claim[]): MissingEvidence[] {
  return claims
    .filter((c) => ["insufficient", "partially_supported"].includes(c.assessment.status) || (c.assessment.status === "supported" && c.assessment.independentSupportingPublishers < 2))
    .filter((c) => c.kind !== "opinion")
    .map((c) => {
      const terms = keyTerms(c.text).slice(0, 6).join(" ");
      const need =
        c.kind === "statistical"
          ? "A primary dataset or official statistic with the same figure and date."
          : c.kind === "causal"
            ? "A study that tests the causal link (ideally controlled or quasi-experimental), not just a correlation."
            : c.kind === "predictive"
              ? "A dated forecast from a named organisation, and its track record."
              : c.assessment.status === "supported"
                ? "A second, independent publisher confirming it."
                : "Any source that states this directly.";
      const queries = [terms];
      if (c.kind === "statistical") queries.push(`${terms} official statistics`, `${terms} dataset`);
      else if (c.kind === "causal") queries.push(`${terms} randomized study`, `${terms} systematic review`);
      else if (c.kind === "predictive") queries.push(`${terms} forecast report`);
      else queries.push(`${terms} source`);
      return { claim: c, need, queries: [...new Set(queries)] };
    });
}

/** Claims whose cited source does not appear to contain them. */
export function misCitations(claims: Claim[]): { claim: Claim; sourceIds: string[] }[] {
  return claims
    .map((c) => ({
      claim: c,
      sourceIds: c.evidence.filter((l) => l.cited && l.stance === "insufficient" && l.relevance < 0.35 && l.judgedBy !== "user").map((l) => l.sourceId),
    }))
    .filter((x) => x.sourceIds.length > 0);
}

/** Split claims into what a source states directly vs. what the AI inferred or asserted without evidence. */
export function directVsInference(claims: Claim[]) {
  return {
    direct: claims.filter((c) => c.assessment.basis === "direct"),
    inference: claims.filter((c) => c.assessment.basis === "inference"),
    unbacked: claims.filter((c) => c.assessment.basis === "none"),
  };
}
