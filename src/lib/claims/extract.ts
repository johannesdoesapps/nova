import { sentences } from "./text";
import type { ClaimKind, ClaimOrigin } from "./types";

export interface ExtractedClaim {
  index: number;
  text: string;
  span: { start: number; end: number };
  kind: ClaimKind;
  origin: ClaimOrigin;
  hedged: boolean;
  citedIndexes: number[];
}

const INFERENCE_LABEL = /^\s*(?:\*\*)?(interpretation|background(?: \(not from sources\))?|analysis|my (?:view|take|assessment)|inference|note)\s*:?(?:\*\*)?\s*:?/i;
const INFERENCE_LANGUAGE =
  /\b(this suggests|which suggests|suggests that|implies|imply|likely|probably|presumably|it seems|appears to|may indicate|could indicate|therefore|thus|hence|it follows|we can infer|this means that|in other words)\b/i;
const HEDGES = /\b(may|might|could|possibly|perhaps|likely|unlikely|probably|suggests?|appears?|seems?|reportedly|estimated|approximately|around|roughly)\b/i;

const KIND_RULES: [ClaimKind, RegExp][] = [
  ["opinion", /\b(i think|i believe|in my (?:view|opinion)|should|ought to|best|worst|recommend|beautiful|great|terrible|important to)\b/i],
  ["predictive", /\b(will|is expected to|are expected to|forecast|projected|predicts?|by (?:19|20)\d\d|going to|outlook)\b/i],
  ["causal", /\b(causes?|caused|leads? to|led to|results? in|resulted in|because|due to|drives?|driven by|contributes? to|triggers?|reduces?|increases?|prevents?)\b/i],
  ["statistical", /\d|\b(percent|majority|minority|half|third|quarter|average|median|rate)\b/i],
  ["comparative", /\b(more|less|fewer|greater|higher|lower|better|worse|faster|slower|larger|smaller)\b.*\bthan\b|\b(compared (?:to|with)|outperforms?|versus|vs\.?)\b/i],
  ["definitional", /\b(is defined as|refers to|is a term for|means|is known as|is a type of|is an? (?:kind|form) of)\b/i],
];

export function classifyKind(text: string): ClaimKind {
  for (const [kind, re] of KIND_RULES) if (re.test(text)) return kind;
  return "factual";
}

/** Strip Markdown decoration while keeping character positions stable enough for display. */
export function normalizeAnswer(answer: string): string {
  return answer
    .replace(/\r\n/g, "\n")
    .replace(/\n\s*\**follow-?ups:?\**\s*\n[\s\S]*$/i, "") // drop the follow-up questions block
    .replace(/```[\s\S]*?```/g, " ") // code blocks are not claims
    .replace(/^#{1,6}\s+.*$/gm, "") // headings
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, "") // list markers
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1");
}

function isClaimLike(s: string): boolean {
  const words = s.replace(/\[\d{1,2}\]/g, "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 4) return false;
  if (/\?\s*$/.test(s)) return false; // questions are not assertions
  if (/^(here(?:'s| is| are)|in summary|to summarise|to summarize|let me|sure[,!]|great question|demo mode)/i.test(s.trim())) return false;
  if (/^(sources?|references?|follow-?ups?)\s*:?$/i.test(s.trim())) return false;
  return /[a-z]/i.test(s);
}

/**
 * Split compound sentences where the answer attaches different citations to
 * different clauses, e.g. "X rose 8% [1], and Y fell by a third [2]." becomes
 * two claims, each checked against its own source.
 */
export function splitAtCitations(s: { text: string; start: number; end: number }): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  const re = /(\[\d{1,2}\])+\s*(?:[,;]\s*(?:and|but|while|whereas)?|\s(?:and|but|while|whereas))\s+(?=\S)/g;
  let from = 0;
  for (const m of s.text.matchAll(re)) {
    const cut = m.index! + m[0].match(/^(\[\d{1,2}\])+/)![0].length;
    const piece = s.text.slice(from, cut).trim();
    if (piece.split(/\s+/).length >= 4) {
      out.push({ text: piece, start: s.start + from, end: s.start + cut });
      from = m.index! + m[0].length;
    }
  }
  const rest = s.text.slice(from).trim();
  if (out.length && rest.split(/\s+/).length < 4) {
    const last = out.pop()!;
    out.push({ text: s.text.slice(last.start - s.start).trim(), start: last.start, end: s.end });
  } else if (rest) out.push({ text: rest.charAt(0).toUpperCase() + rest.slice(1), start: s.start + from, end: s.end });
  return out.length ? out : [s];
}

/**
 * Break an answer into atomic-ish claims: one per sentence, with citation
 * markers parsed out and an origin label derived from how the answer frames it.
 * Sentences inside an "Interpretation:" / "Background:" paragraph inherit that label.
 */
export function extractClaims(answer: string): { normalized: string; claims: ExtractedClaim[] } {
  const normalized = normalizeAnswer(answer);
  const claims: ExtractedClaim[] = [];
  // Track paragraph-level inference labels.
  const paragraphs: { start: number; end: number; inference: boolean }[] = [];
  let offset = 0;
  for (const p of normalized.split(/\n\s*\n/)) {
    const start = normalized.indexOf(p, offset);
    paragraphs.push({ start, end: start + p.length, inference: INFERENCE_LABEL.test(p) });
    offset = start + p.length;
  }

  for (const s of sentences(normalized).flatMap(splitAtCitations)) {
    const labelled = INFERENCE_LABEL.test(s.text);
    const text = s.text.replace(INFERENCE_LABEL, "").trim();
    if (!isClaimLike(text)) continue;
    const citedIndexes = [...new Set([...text.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1])))];
    const clean = text.replace(/\s*\[\d{1,2}\]/g, "").trim();
    const inParagraphLabel = paragraphs.some((p) => p.inference && s.start >= p.start && s.start <= p.end);
    const origin: ClaimOrigin =
      labelled || inParagraphLabel || (citedIndexes.length === 0 && INFERENCE_LANGUAGE.test(clean))
        ? "ai_inference"
        : citedIndexes.length
          ? "cited"
          : "uncited";
    claims.push({
      index: claims.length + 1,
      text: clean,
      span: { start: s.start, end: s.end },
      kind: classifyKind(clean),
      origin,
      hedged: HEDGES.test(clean),
      citedIndexes,
    });
  }
  return { normalized, claims };
}
