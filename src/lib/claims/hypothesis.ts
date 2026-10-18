import { keyTerms } from "./text";
import type { ClaimReport } from "./types";

/**
 * Hypothesis Arena: competing explanations, each with testable predictions.
 * There are no win probabilities. A hypothesis is "weakened" when its
 * predictions meet inconsistent evidence, and the arena refuses to name a
 * leader until enough discriminating predictions have actually been tested.
 */

export type PredictionStatus = "untested" | "consistent" | "inconsistent" | "ambiguous";

export interface PredictionEvidence {
  claimId?: string;
  sourceId?: string;
  note: string;
  stance: "consistent" | "inconsistent" | "ambiguous";
  addedBy: "user" | "rules" | "model";
}

export interface Prediction {
  id: string;
  /** "If H is true, we should observe…" */
  expectation: string;
  /** How someone could check it (data to look at, experiment, search). */
  test: string;
  status: PredictionStatus;
  evidence: PredictionEvidence[];
}

export interface Hypothesis {
  id: string;
  label: string;
  statement: string;
  origin: "user" | "model" | "template";
  predictions: Prediction[];
}

export interface Arena {
  id: string;
  question: string;
  reportId: string | null;
  createdAt: string;
  updatedAt: string;
  hypotheses: Hypothesis[];
  notes: string;
}

export const MIN_DISCRIMINATING_TESTS = 2;

export function newArena(question: string, reportId: string | null = null, now = new Date().toISOString()): Arena {
  return { id: crypto.randomUUID(), question, reportId, createdAt: now, updatedAt: now, hypotheses: [], notes: "" };
}

/** Template starter set: the stated explanation, an alternative, and chance/measurement. Clearly labelled. */
export function templateHypotheses(question: string): Hypothesis[] {
  const topic = question.replace(/\?+$/, "").trim() || "the observed pattern";
  const h = (id: string, label: string, statement: string, preds: [string, string][]): Hypothesis => ({
    id,
    label,
    statement,
    origin: "template",
    predictions: preds.map(([expectation, test], i) => ({ id: `${id}-P${i + 1}`, expectation, test, status: "untested", evidence: [] })),
  });
  return [
    h("H1", "Main explanation", `The commonly given explanation for “${topic}” is correct.`, [
      ["Independent sources using different methods report the same effect.", "Look for at least two independent studies or datasets."],
      ["The effect is larger where the proposed cause is stronger (dose–response).", "Compare groups or periods with different exposure levels."],
    ]),
    h("H2", "Alternative cause / confounder", `A different factor explains “${topic}”, and the usual explanation is a correlation.`, [
      ["The effect shrinks or disappears after controlling for the alternative factor.", "Find analyses that adjust for likely confounders."],
      ["The effect appears even where the proposed cause is absent.", "Look for counter-examples or natural experiments."],
    ]),
    h("H3", "Chance or measurement artefact", `“${topic}” reflects noise, selection or how it was measured.`, [
      ["Results do not replicate, or vary widely between samples.", "Search for replications and meta-analyses."],
      ["Changing the measurement definition changes the result.", "Check methodology sections for definition changes."],
    ]),
  ];
}

/** A prediction discriminates when no rival hypothesis makes a near-identical prediction. */
export function isDiscriminating(arena: Arena, hypothesisId: string, prediction: Prediction): boolean {
  const mine = new Set(keyTerms(prediction.expectation));
  return !arena.hypotheses
    .filter((h) => h.id !== hypothesisId)
    .some((h) =>
      h.predictions.some((p) => {
        const theirs = keyTerms(p.expectation);
        if (!theirs.length || !mine.size) return false;
        const overlap = theirs.filter((t) => mine.has(t)).length / Math.max(mine.size, theirs.length);
        return overlap >= 0.7;
      }),
    );
}

export function statusFromEvidence(evidence: PredictionEvidence[]): PredictionStatus {
  if (!evidence.length) return "untested";
  const c = evidence.filter((e) => e.stance === "consistent").length;
  const i = evidence.filter((e) => e.stance === "inconsistent").length;
  if (c && i) return "ambiguous";
  if (i) return "inconsistent";
  if (c) return "consistent";
  return "ambiguous";
}

export interface Standing {
  hypothesisId: string;
  label: string;
  tested: number;
  consistent: number;
  inconsistent: number;
  untested: number;
  discriminatingTested: number;
  standing: "untested" | "unrefuted" | "weakened" | "mixed";
}

export function standings(arena: Arena): Standing[] {
  return arena.hypotheses.map((h) => {
    const tested = h.predictions.filter((p) => p.status !== "untested");
    const consistent = tested.filter((p) => p.status === "consistent").length;
    const inconsistent = tested.filter((p) => p.status === "inconsistent").length;
    const discriminatingTested = tested.filter((p) => isDiscriminating(arena, h.id, p)).length;
    const standing: Standing["standing"] =
      tested.length === 0 ? "untested" : inconsistent && consistent ? "mixed" : inconsistent ? "weakened" : "unrefuted";
    return {
      hypothesisId: h.id,
      label: h.label,
      tested: tested.length,
      consistent,
      inconsistent,
      untested: h.predictions.length - tested.length,
      discriminatingTested,
      standing,
    };
  });
}

export interface ArenaVerdict {
  leader: string | null;
  message: string;
}

/** Only names a leader when it alone is unrefuted and enough discriminating tests were run. */
export function verdict(arena: Arena): ArenaVerdict {
  const s = standings(arena);
  if (s.length < 2) return { leader: null, message: "Add at least two competing hypotheses." };
  const totalDiscriminating = s.reduce((n, x) => n + x.discriminatingTested, 0);
  if (totalDiscriminating < MIN_DISCRIMINATING_TESTS)
    return {
      leader: null,
      message: `Not enough evidence to favour any hypothesis: ${totalDiscriminating} of the required ${MIN_DISCRIMINATING_TESTS} discriminating predictions have been tested.`,
    };
  const standing = s.filter((x) => x.standing === "unrefuted");
  if (standing.length === 1 && s.filter((x) => x !== standing[0]).every((x) => x.inconsistent > 0))
    return {
      leader: standing[0]!.hypothesisId,
      message: `${standing[0]!.label} is the only hypothesis whose tested predictions all held up. This is provisional — new evidence can overturn it.`,
    };
  return { leader: null, message: "No single hypothesis is clearly favoured by the tested predictions. Test predictions that the hypotheses disagree on." };
}

/**
 * Suggest which report claims bear on which predictions (term overlap). These
 * are suggestions for the user to accept or reject, never applied automatically.
 */
export function suggestEvidence(arena: Arena, report: ClaimReport, min = 0.34) {
  const out: { hypothesisId: string; predictionId: string; claimId: string; overlap: number; claimStatus: string; text: string }[] = [];
  for (const h of arena.hypotheses)
    for (const p of h.predictions) {
      const pt = new Set(keyTerms(`${p.expectation} ${h.statement}`));
      for (const c of report.claims) {
        const ct = keyTerms(c.text);
        if (!ct.length) continue;
        const overlap = ct.filter((t) => pt.has(t)).length / ct.length;
        if (overlap >= min && !p.evidence.some((e) => e.claimId === c.id))
          out.push({ hypothesisId: h.id, predictionId: p.id, claimId: c.id, overlap: Math.round(overlap * 100) / 100, claimStatus: c.assessment.status, text: c.text });
      }
    }
  return out.sort((a, b) => b.overlap - a.overlap).slice(0, 20);
}
