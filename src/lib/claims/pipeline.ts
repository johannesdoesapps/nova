import { assessClaim } from "./assess";
import { applyModelJudgements, applyReviews, buildIdf, linkEvidence } from "./evidence";
import { extractClaims } from "./extract";
import { ReplayRecorder } from "./replay";
import { buildSource } from "./sources";
import { hash } from "./text";
import { summarize } from "./workflows";
import { CLAIM_DNA_VERSION, type Claim, type ClaimReport, type PipelineInput } from "./types";

/**
 * The Claim DNA pipeline. Pure and deterministic given its input (including
 * the clock and any recorded model judgements), which is what makes Research
 * Replay possible: re-running the same input must reproduce every step hash.
 */
export function runClaimPipeline(input: PipelineInput, id: string = crypto.randomUUID()): ClaimReport {
  const rec = new ReplayRecorder({ mode: input.mode, modelId: input.modelId ?? null, now: input.now });

  rec.step("input", "user", "Question, answer and sources received", { q: input.question, a: input.answer, n: input.sources.length }, () => ({
    question: input.question.slice(0, 200),
    answerChars: input.answer.length,
    sources: input.sources.length,
  }));

  const sources = rec.step("source_ingest", "rules", "Sources fingerprinted and reliability indicators recorded", input.sources.map((s) => [s.url ?? null, hash(s.text)]), () =>
    input.sources.map((s, i) => buildSource(s, i, input.now)),
    (out) => out.map((s) => ({ id: s.id, publisher: s.publisher, type: s.reliability.sourceType, hash: s.contentHash })),
  );

  const extracted = rec.step("claim_extraction", "rules", "Answer split into claims; citations and inference labels parsed", input.answer, () =>
    extractClaims(input.answer).claims.map((c) => ({ ...c, id: `C${c.index}` })),
    (out) => out.map((c) => ({ id: c.id, kind: c.kind, origin: c.origin, text: c.text.slice(0, 90) })),
  );

  const idf = buildIdf(sources);
  let linked = rec.step("evidence_linking", "rules", "Each claim matched against every source passage (term overlap, figures, polarity)", { c: extracted.map((c) => c.text), s: sources.map((s) => s.contentHash) }, () =>
    extracted.map((c) => ({ claim: c, links: linkEvidence(c, sources, idf) })),
    (out) => out.map((x) => ({ id: x.claim.id, links: x.links.map((l) => `${l.sourceId}:${l.stance}`) })),
  );

  const judgements = input.modelJudgements ?? [];
  if (input.mode === "model") {
    linked = rec.step(
      "model_judgement",
      "model",
      judgements.length ? `Model judged ${judgements.length} claim–source pairs; quotes verified against source text` : "Model judgement requested but returned nothing usable",
      judgements,
      () => linked.map((x) => ({ claim: x.claim, links: applyModelJudgements(x.claim.id, x.claim.index, x.links, judgements, sources) })),
      (out) => out.flatMap((x) => x.links.filter((l) => l.judgedBy === "model").map((l) => `${l.id}:${l.stance}:${l.quoteVerified ? "verified" : "unverified"}`)),
      false,
      input.modelMeta && input.modelId
        ? { id: input.modelId, servedModel: input.modelMeta.servedModel, temperature: input.modelMeta.temperature, promptHash: input.modelMeta.promptHash }
        : undefined,
      input.modelMeta?.durationMs,
    );
  }

  const reviews = input.reviews ?? [];
  if (reviews.length) {
    linked = rec.step("user_review", "user", `${reviews.length} evidence judgement(s) reviewed by the user`, reviews, () =>
      linked.map((x) => ({ claim: x.claim, links: applyReviews(x.links, reviews) })),
      (out) => out.flatMap((x) => x.links.filter((l) => l.judgedBy === "user").map((l) => `${l.id}:${l.stance}`)),
    );
  }

  const claims: Claim[] = rec.step("assessment", "rules", "Statuses, evidence basis, limitations and heuristic estimates computed", linked.map((x) => x.links), () =>
    linked.map(({ claim, links }) => ({
      id: claim.id,
      index: claim.index,
      text: claim.text,
      span: claim.span,
      kind: claim.kind,
      origin: claim.origin,
      hedged: claim.hedged,
      citedSourceIds: claim.citedIndexes.filter((i) => sources.some((s) => s.index === i)).map((i) => `S${i}`),
      evidence: links,
      assessment: assessClaim(claim, links, sources),
    })),
    (out) => out.map((c) => ({ id: c.id, status: c.assessment.status, basis: c.assessment.basis })),
  );

  const summary = rec.step("summary", "rules", "Report summary", claims.map((c) => c.assessment.status), () => summarize(claims, sources), (s) => s);

  return {
    id,
    version: CLAIM_DNA_VERSION,
    question: input.question,
    answer: input.answer,
    createdAt: input.now,
    mode: input.mode,
    modelId: input.modelId ?? null,
    sources,
    claims,
    summary,
    reviews,
    modelJudgements: judgements,
    replay: rec.log(),
  };
}

/** Rebuild the pipeline input from a stored report (used by replay and by re-assessment after reviews). */
export function inputFromReport(r: ClaimReport): PipelineInput {
  const modelEvent = r.replay.events.find((e) => e.step === "model_judgement");
  return {
    question: r.question,
    answer: r.answer,
    now: r.replay.config.now,
    mode: r.mode,
    modelId: r.modelId,
    modelJudgements: r.modelJudgements,
    modelMeta: modelEvent?.model
      ? { servedModel: modelEvent.model.servedModel, temperature: modelEvent.model.temperature, promptHash: modelEvent.model.promptHash, durationMs: modelEvent.durationMs }
      : undefined,
    reviews: r.reviews,
    sources: r.sources.map((s) => ({
      index: s.index,
      url: s.url,
      title: s.title,
      text: s.text,
      publishedAt: s.publishedAt,
      author: s.author,
      contentKind: s.contentKind,
      provider: s.provenance[0]?.actor === "search_provider" ? s.provenance[0].action.replace(/^Retrieved by | web search$/g, "") : null,
    })),
  };
}
