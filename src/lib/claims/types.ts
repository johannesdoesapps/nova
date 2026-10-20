/**
 * Claim DNA data model.
 *
 * Design rule: nothing in here is "truth". A claim's status describes the
 * relationship between the claim and the evidence Orbis could see, and every
 * judgement records who made it (rules, a model, or the user) so the UI can
 * show its provenance and limits.
 */

export const CLAIM_DNA_VERSION = "claim-dna/1";

export type ClaimKind =
  | "factual"
  | "statistical"
  | "causal"
  | "predictive"
  | "comparative"
  | "definitional"
  | "opinion";

/** What the answer itself signals about the claim. */
export type ClaimOrigin =
  /** The answer attaches a citation marker such as [2]. */
  | "cited"
  /** The answer labels it as interpretation/background, or uses inference language. */
  | "ai_inference"
  /** A plain assertion with no citation and no inference label. */
  | "uncited";

export type Stance = "supports" | "contradicts" | "insufficient";
export type Directness = "direct" | "indirect";
export type JudgedBy = "rules" | "model" | "user";

export type ClaimStatus =
  | "supported"
  | "partially_supported"
  | "contested"
  | "contradicted"
  | "insufficient"
  | "not_checkable";

/** How the claim relates to evidence: stated by a source, inferred, or neither. */
export type EvidenceBasis = "direct" | "inference" | "none";

export type SourceType =
  | "government"
  | "academic"
  | "preprint"
  | "reference"
  | "news"
  | "company"
  | "blog_forum"
  | "user_provided"
  | "unknown";

export interface ProvenanceStep {
  at: string;
  actor: "search_provider" | "user" | "orbis" | "model";
  action: string;
  detail?: string;
}

/**
 * Observable reliability indicators. Deliberately not collapsed into a single
 * score: a .gov page can be wrong and a blog can be right, so the UI shows the
 * facts and lets the reader weigh them.
 */
export interface ReliabilityIndicators {
  sourceType: SourceType;
  hasDate: boolean;
  ageDays: number | null;
  https: boolean;
  contentKind: "snippet" | "full_text" | "user_pasted";
  textLength: number;
  flags: string[];
}

export interface SourceRecord {
  id: string; // "S1"
  index: number; // citation number used in the answer
  url: string | null;
  title: string;
  publisher: string;
  author: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  contentKind: ReliabilityIndicators["contentKind"];
  text: string;
  contentHash: string;
  reliability: ReliabilityIndicators;
  provenance: ProvenanceStep[];
}

export interface EvidenceLink {
  id: string; // "C3-S1"
  claimId: string;
  sourceId: string;
  stance: Stance;
  directness: Directness;
  /** Exact passage from the source text (or the model's quote, see quoteVerified). */
  quote: string;
  quoteStart: number | null;
  /** True only when `quote` was found verbatim (whitespace/case-normalised) in the source text. */
  quoteVerified: boolean;
  /** Share of the claim's key terms that appear in the passage (0–1). Topic overlap, not truth. */
  relevance: number;
  /** True when the answer cited this source for this claim. */
  cited: boolean;
  judgedBy: JudgedBy;
  rationale: string;
  /** The rule-based judgement, kept when a model or user overrides it. */
  rulesStance?: Stance;
}

/**
 * A heuristic or model-judged estimate. Always rendered with its method and
 * caveat, as a coarse band, and never labelled as a probability of truth.
 */
export interface SupportEstimate {
  value: number; // 0–1, internal; the UI leads with `band`
  band: "weak" | "moderate" | "strong";
  method: string;
  judgedBy: JudgedBy;
  caveat: string;
}

export interface Assessment {
  status: ClaimStatus;
  basis: EvidenceBasis;
  supporting: number;
  contradicting: number;
  independentSupportingPublishers: number;
  estimate: SupportEstimate | null;
  limitations: string[];
  explanation: string[];
}

export interface Claim {
  id: string; // "C1"
  index: number;
  text: string;
  /** Character span in the normalised answer text. */
  span: { start: number; end: number };
  kind: ClaimKind;
  origin: ClaimOrigin;
  hedged: boolean;
  citedSourceIds: string[];
  evidence: EvidenceLink[];
  assessment: Assessment;
}

export interface ReportSummary {
  total: number;
  byStatus: Record<ClaimStatus, number>;
  byBasis: Record<EvidenceBasis, number>;
  miscitations: number;
  snippetOnly: boolean;
  headline: string;
}

export type ReplayStep =
  | "input"
  | "source_ingest"
  | "claim_extraction"
  | "evidence_linking"
  | "model_judgement"
  | "user_review"
  | "assessment"
  | "summary";

export interface ReplayEvent {
  seq: number;
  step: ReplayStep;
  actor: "user" | "rules" | "model";
  description: string;
  inputHash: string;
  outputHash: string;
  /** Small, human-readable snapshot of what the step produced. */
  output: unknown;
  deterministic: boolean;
  durationMs: number;
  model?: { id: string; servedModel: string | null; temperature: number | null; promptHash: string };
}

export interface ReplayLog {
  pipelineVersion: string;
  config: { mode: "rules" | "model"; modelId: string | null; now: string };
  events: ReplayEvent[];
}

/** A model's evidence judgement, recorded verbatim so replays can reuse it. */
export interface ModelJudgement {
  claimIndex: number;
  sourceIndex: number;
  stance: Stance;
  quote: string;
  rationale?: string;
}

export interface UserReview {
  linkId: string;
  stance: Stance;
  note?: string;
  at: string;
}

export interface SourceInput {
  index?: number;
  url?: string | null;
  title?: string;
  text: string;
  publishedAt?: string | null;
  author?: string | null;
  contentKind?: ReliabilityIndicators["contentKind"];
  provider?: string | null;
}

export interface PipelineInput {
  question: string;
  answer: string;
  sources: SourceInput[];
  /** Fixed clock so age-based limitations replay identically. */
  now: string;
  mode: "rules" | "model";
  modelId?: string | null;
  modelJudgements?: ModelJudgement[];
  modelMeta?: { servedModel: string | null; temperature: number | null; promptHash: string; durationMs: number };
  reviews?: UserReview[];
}

export interface ClaimReport {
  id: string;
  version: typeof CLAIM_DNA_VERSION;
  question: string;
  answer: string;
  createdAt: string;
  mode: "rules" | "model";
  modelId: string | null;
  sources: SourceRecord[];
  claims: Claim[];
  summary: ReportSummary;
  reviews: UserReview[];
  modelJudgements: ModelJudgement[];
  replay: ReplayLog;
}
