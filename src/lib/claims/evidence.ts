import type { ExtractedClaim } from "./extract";
import { findQuote, isNegated, keyTerms, numbers, sentences, tokenize } from "./text";
import type { EvidenceLink, ModelJudgement, SourceRecord, Stance, UserReview } from "./types";

/** Thresholds are published in docs/CLAIM_DNA.md; change them there too. */
export const LINK_THRESHOLDS = {
  /** Minimum relevance before a passage is considered evidence at all (uncited sources). */
  consider: 0.35,
  /** Relevance needed to call a passage supporting. */
  support: 0.6,
  /** Relevance needed for "direct" (the passage states the claim, not just the topic). */
  direct: 0.75,
  /** Relevance needed before a numeric or polarity mismatch counts as a contradiction. */
  conflict: 0.45,
};

const ANTONYMS: [string, string][] = [
  ["increase", "decrease"],
  ["rise", "fall"],
  ["higher", "lower"],
  ["more", "less"],
  ["gain", "loss"],
  ["grow", "shrink"],
  ["effective", "ineffective"],
  ["safe", "unsafe"],
  ["legal", "illegal"],
  ["approve", "reject"],
  ["up", "down"],
  ["above", "below"],
  ["success", "failure"],
];

interface Passage {
  text: string;
  start: number;
  terms: string[];
}

function passages(source: SourceRecord): Passage[] {
  const sents = sentences(source.text);
  const out: Passage[] = sents.map((s) => ({ text: s.text, start: s.start, terms: tokenize(s.text) }));
  // Two-sentence windows catch claims that span a sentence boundary.
  for (let i = 0; i + 1 < sents.length; i++) {
    const text = source.text.slice(sents[i]!.start, sents[i + 1]!.end);
    out.push({ text, start: sents[i]!.start, terms: tokenize(text) });
  }
  return out;
}

export type Idf = (term: string) => number;

export function buildIdf(sources: SourceRecord[]): Idf {
  const docs = sources.flatMap((s) => sentences(s.text).map((x) => new Set(tokenize(x.text))));
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d) df.set(t, (df.get(t) ?? 0) + 1);
  const n = Math.max(1, docs.length);
  return (t) => Math.log(1 + n / (1 + (df.get(t) ?? 0)));
}

/** IDF-weighted share of the claim's key terms present in the passage. */
export function relevance(claimTerms: string[], passageTerms: string[], idf: Idf): number {
  if (claimTerms.length === 0) return 0;
  const p = new Set(passageTerms);
  let total = 0;
  let hit = 0;
  for (const t of claimTerms) {
    const w = idf(t);
    total += w;
    if (p.has(t)) hit += w;
  }
  return total === 0 ? 0 : hit / total;
}

function polarityConflict(claim: string, passage: string): string | null {
  const c = new Set(tokenize(claim));
  const p = new Set(tokenize(passage));
  for (const [a, b] of ANTONYMS) {
    const [sa, sb] = [tokenize(a)[0]!, tokenize(b)[0]!];
    if ((c.has(sa) && p.has(sb) && !p.has(sa)) || (c.has(sb) && p.has(sa) && !p.has(sb))) {
      return `Direction mismatch: the claim says “${c.has(sa) ? a : b}”, the source says “${c.has(sa) ? b : a}”.`;
    }
  }
  if (isNegated(claim) !== isNegated(passage)) {
    return "Negation mismatch: one of the claim or the passage is negated and the other is not.";
  }
  return null;
}

function numericCheck(claim: string, passage: string): { matched: boolean; conflict: string | null } {
  const cn = numbers(claim).filter((n) => n.unit !== "year");
  if (cn.length === 0) return { matched: true, conflict: null };
  const pn = numbers(passage);
  const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(a) * 0.005);
  const matched = cn.every((c) => pn.some((p) => same(c.value, p.value)));
  if (matched) return { matched: true, conflict: null };
  const clash = cn.find((c) => pn.some((p) => p.unit === c.unit && p.unit !== "year" && !same(c.value, p.value)));
  return {
    matched: false,
    conflict: clash
      ? `Numeric mismatch: the claim says ${clash.raw}, the passage gives ${pn.filter((p) => p.unit === clash.unit).map((p) => p.raw).slice(0, 3).join(", ")}.`
      : null,
  };
}

/**
 * Rule-based evidence linking for one claim. For every source, find the best
 * matching passage and classify the relationship. Cited sources always get a
 * link (so mis-citations are visible); uncited ones only when relevant.
 */
export function linkEvidence(claim: ExtractedClaim & { id: string }, sources: SourceRecord[], idf: Idf): EvidenceLink[] {
  const terms = keyTerms(claim.text);
  const links: EvidenceLink[] = [];
  for (const source of sources) {
    const cited = claim.citedIndexes.includes(source.index);
    let best: { p: Passage; r: number } | null = null;
    for (const p of passages(source)) {
      const r = relevance(terms, p.terms, idf);
      // Prefer the shorter passage on ties so quotes stay tight.
      if (!best || r > best.r + 1e-9 || (Math.abs(r - best.r) < 1e-9 && p.text.length < best.p.text.length)) best = { p, r };
    }
    const r = best ? Math.round(best.r * 100) / 100 : 0;
    if (!best || (!cited && r < LINK_THRESHOLDS.consider)) continue;

    let stance: Stance = "insufficient";
    let directness: EvidenceLink["directness"] = "indirect";
    let rationale: string;
    const num = numericCheck(claim.text, best.p.text);
    const polarity = r >= LINK_THRESHOLDS.conflict ? polarityConflict(claim.text, best.p.text) : null;

    if (r >= LINK_THRESHOLDS.conflict && (num.conflict || polarity)) {
      stance = "contradicts";
      directness = r >= LINK_THRESHOLDS.direct ? "direct" : "indirect";
      rationale = `${num.conflict ?? polarity} Keyword heuristic — open the passage to confirm.`;
    } else if (r >= LINK_THRESHOLDS.support && num.matched) {
      stance = "supports";
      directness = r >= LINK_THRESHOLDS.direct ? "direct" : "indirect";
      rationale =
        directness === "direct"
          ? `The passage contains ${Math.round(r * 100)}% of the claim's key terms${numbers(claim.text).length ? " and the same figures" : ""}.`
          : `The passage covers the same topic (${Math.round(r * 100)}% term overlap) but may not state the exact claim.`;
    } else if (cited && r < LINK_THRESHOLDS.consider) {
      rationale = "The answer cites this source, but its retrieved text does not appear to contain this claim (possible mis-citation, or the snippet is too short).";
    } else if (!num.matched) {
      rationale = "Related passage, but the claim's figures do not appear in it.";
    } else {
      rationale = `Related passage (${Math.round(r * 100)}% term overlap) — not enough to say it supports the claim.`;
    }

    links.push({
      id: `${claim.id}-${source.id}`,
      claimId: claim.id,
      sourceId: source.id,
      stance,
      directness,
      quote: best.p.text.length > 600 ? best.p.text.slice(0, 600) + "…" : best.p.text,
      quoteStart: best.p.start,
      quoteVerified: true, // taken verbatim from the source text
      relevance: r,
      cited,
      judgedBy: "rules",
      rationale,
    });
  }
  return links.sort((a, b) => stanceOrder(a.stance) - stanceOrder(b.stance) || b.relevance - a.relevance);
}

function stanceOrder(s: Stance) {
  return s === "contradicts" ? 0 : s === "supports" ? 1 : 2;
}

/**
 * Merge model judgements. A model's stance only replaces the rules' stance when
 * its quote is found verbatim in the source; unverifiable quotes are kept for
 * inspection but downgraded to "insufficient".
 */
export function applyModelJudgements(
  claimId: string,
  claimIndex: number,
  links: EvidenceLink[],
  judgements: ModelJudgement[],
  sources: SourceRecord[],
): EvidenceLink[] {
  const out = [...links];
  for (const j of judgements.filter((x) => x.claimIndex === claimIndex)) {
    const source = sources.find((s) => s.index === j.sourceIndex);
    if (!source) continue;
    const pos = findQuote(source.text, j.quote);
    const verified = pos >= 0;
    const existing = out.findIndex((l) => l.sourceId === source.id);
    const base: EvidenceLink =
      existing >= 0
        ? out[existing]!
        : {
            id: `${claimId}-${source.id}`,
            claimId,
            sourceId: source.id,
            stance: "insufficient",
            directness: "indirect",
            quote: "",
            quoteStart: null,
            quoteVerified: false,
            relevance: 0,
            cited: false,
            judgedBy: "rules",
            rationale: "",
          };
    const merged: EvidenceLink = {
      ...base,
      rulesStance: base.judgedBy === "rules" && existing >= 0 ? base.stance : base.rulesStance,
      stance: verified ? j.stance : "insufficient",
      directness: verified && j.stance !== "insufficient" ? "direct" : base.directness,
      quote: verified ? source.text.slice(pos, pos + j.quote.length) : j.quote,
      quoteStart: verified ? pos : null,
      quoteVerified: verified,
      judgedBy: "model",
      rationale: verified
        ? `Model judgement: ${j.rationale ?? j.stance}. Quote verified in the source text.`
        : `Model said “${j.stance}” but its quote was NOT found in the source text, so it is not counted.${j.rationale ? ` (Model rationale: ${j.rationale})` : ""}`,
    };
    if (existing >= 0) out[existing] = merged;
    else out.push(merged);
  }
  return out;
}

/** User reviews always win, and the previous judgement is retained for the audit trail. */
export function applyReviews(links: EvidenceLink[], reviews: UserReview[]): EvidenceLink[] {
  return links.map((l) => {
    const r = [...reviews].reverse().find((x) => x.linkId === l.id);
    if (!r) return l;
    return {
      ...l,
      rulesStance: l.rulesStance ?? (l.judgedBy === "rules" ? l.stance : undefined),
      stance: r.stance,
      judgedBy: "user",
      rationale: `Reviewed by you: “${r.stance}”${r.note ? ` — ${r.note}` : ""}. Previous ${l.judgedBy} judgement: ${l.stance}.`,
    };
  });
}
