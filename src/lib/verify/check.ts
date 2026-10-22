import { extractClaims } from "../claims/extract";
import { buildSource } from "../claims/sources";
import { runClaimPipeline } from "../claims/pipeline";
import type { ModelJudgement, SourceInput } from "../claims/types";
import type { SearchSource } from "../search/types";
import { findingFor } from "./categories";
import { MAX_CHECKED_CLAIMS, SEARCH_MISSING, type VerifyRequest, type VerifyResult, type VerifyStep } from "./schema";

/**
 * The verification workflow, as explicit steps:
 *   1. identify the claims in what is being reviewed;
 *   2. gather evidence: the user's documents, then web search when it's set up;
 *   3. compare each claim with the evidence (a model's judgement counts only
 *      when its quote is found word-for-word in the source; keyword rules otherwise);
 *   4. report each claim's category, finding, evidence and limitations.
 * Nothing is reported as checked unless a source was actually read.
 */

export interface CheckDeps {
  /** Web search; null when it isn't set up (or the user turned it off). */
  search: ((query: string) => Promise<SearchSource[]>) | null;
  /** An AI judge; null when no real model is available. */
  judge: ((claims: { index: number; text: string }[], sources: ReturnType<typeof buildSource>[]) => Promise<{ judgements: ModelJudgement[]; error: string | null }>) | null;
  now?: string;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\[\d{1,2}\]/g, "")
    .replace(/[*_`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The text whose claims are checked, and for several responses, which response said what. */
export function textToCheck(req: Pick<VerifyRequest, "scope" | "answer" | "claims" | "responses">): { text: string; owners: (claim: string) => string[] | undefined } {
  if (req.scope === "claims") return { text: (req.claims ?? []).map((c) => (/[.!?]$/.test(c) ? c : `${c}.`)).join("\n"), owners: () => undefined };
  if (req.scope === "responses") {
    const rs = (req.responses ?? []).map((r) => ({ label: r.label, flat: norm(r.text) }));
    return {
      text: (req.responses ?? []).map((r) => r.text).join("\n\n"),
      owners: (claim) => {
        const key = norm(claim).slice(0, 60);
        return rs.filter((r) => r.flat.includes(key)).map((r) => r.label);
      },
    };
  }
  return { text: req.answer, owners: () => undefined };
}

export async function runCheck(req: VerifyRequest, deps: CheckDeps): Promise<VerifyResult> {
  const now = deps.now ?? new Date().toISOString();
  const notices: string[] = [];
  const steps: VerifyStep[] = [];
  const { text, owners } = textToCheck(req);
  const extracted = extractClaims(text).claims;

  if (!extracted.length) {
    steps.push({ id: "claims", label: "Find claims", status: "done", detail: "No checkable claims were found." });
    return { searched: false, reason: "No checkable claims were found in this text.", headline: null, claims: [], sources: [], notices, steps, retrievedAt: null, method: null };
  }
  const judged = extracted.slice(0, MAX_CHECKED_CLAIMS);
  steps.push({
    id: "claims",
    label: "Find claims",
    status: "done",
    detail: `${extracted.length} claim${extracted.length === 1 ? "" : "s"} found${extracted.length > judged.length ? `; the first ${judged.length} are checked` : ""}.`,
  });

  // Evidence: the user's own documents first, then the web.
  const sources: (SourceInput & { origin: "web" | "document" })[] = [];
  for (const d of req.documents ?? []) sources.push({ index: sources.length + 1, url: null, title: d.name, text: d.content, contentKind: "user_pasted", origin: "document" });
  steps.push(
    sources.length
      ? { id: "documents", label: "Read your documents", status: "done", detail: `${sources.length} document${sources.length === 1 ? "" : "s"} used as evidence.` }
      : { id: "documents", label: "Read your documents", status: "skipped", detail: "No documents were added." },
  );

  let searched = false;
  let reason: string | null = null;
  if (!req.web) {
    steps.push({ id: "web", label: "Search the web", status: "skipped", detail: "Web search was turned off for this check." });
  } else if (!deps.search) {
    steps.push({ id: "web", label: "Search the web", status: "skipped", detail: SEARCH_MISSING });
    if (!sources.length) reason = SEARCH_MISSING;
  } else {
    const query = (req.question || judged.map((c) => c.text).join(" ")).slice(0, 400);
    try {
      const found = await deps.search(query);
      searched = true;
      const web = found.slice(0, 8);
      for (const s of web) sources.push({ index: sources.length + 1, url: s.url, title: s.title, text: s.snippet, publishedAt: s.publishedAt, contentKind: "snippet", provider: "web", origin: "web" });
      steps.push({
        id: "web",
        label: "Search the web",
        status: "done",
        detail: web.length ? `${web.length} result${web.length === 1 ? "" : "s"} read (snippets, not full pages).` : "The search returned no results.",
      });
      if (!web.length) notices.push("The web search returned no results for this question.");
    } catch (err) {
      const msg = err instanceof Error && err.message ? err.message : "the search failed";
      steps.push({ id: "web", label: "Search the web", status: "failed", detail: `Sources couldn't be retrieved: ${msg}` });
      notices.push(`Web sources couldn't be retrieved (${msg}). Nothing was checked against the web.`);
    }
  }

  if (!sources.length) {
    reason ??= searched ? "No sources were found to check these claims against." : "No sources were available to check these claims against.";
    steps.push({ id: "compare", label: "Compare claims with evidence", status: "skipped", detail: "There was no evidence to compare against." });
    return {
      searched,
      reason,
      headline: null,
      claims: extracted.map((c) => ({
        text: c.text,
        kind: c.kind,
        hedged: c.hedged,
        status: null,
        evidence: [],
        finding: findingFor(null, { supporting: 0, contradicting: 0, publishers: 0 }, reason!),
        limitations: [],
        from: owners(c.text),
      })),
      sources: [],
      notices,
      steps,
      retrievedAt: null,
      method: null,
    };
  }

  // Compare: an AI judge when available (its quotes must be found in the source), keyword rules otherwise.
  let modelJudgements: ModelJudgement[] = [];
  let method: "model" | "rules" = "rules";
  if (deps.judge) {
    try {
      const r = await deps.judge(
        judged.map((c) => ({ index: c.index, text: c.text })),
        sources.map((s, i) => buildSource(s, i, now)),
      );
      if (r.error) notices.push(r.error);
      modelJudgements = r.judgements;
      method = "model";
    } catch (err) {
      notices.push(`The AI comparison failed (${err instanceof Error ? err.message : "unknown error"}), so only keyword rules were applied.`);
    }
  } else {
    notices.push("No AI model was available for the comparison, so only keyword rules were applied.");
  }
  steps.push({
    id: "compare",
    label: "Compare claims with evidence",
    status: "done",
    detail:
      method === "model"
        ? "An AI model judged each claim against each source; a judgement counts only when its quote appears word-for-word in the source."
        : "Keyword rules matched claims to passages (they can miss context and hedging).",
  });

  const report = runClaimPipeline({ question: req.question, answer: text, sources, now, mode: method, modelJudgements });
  const byId = new Map(report.sources.map((s, i) => [s.id, { ...s, origin: sources[i]!.origin }]));
  const checkedIdx = new Set(judged.map((c) => c.index));
  const notChecked = "Not checked: over the limit of claims checked at once. Check it on its own.";

  return {
    searched,
    reason: null,
    headline: report.summary.headline,
    claims: report.claims.map((c) => {
      const over = method === "model" && !checkedIdx.has(c.index);
      const status = over ? null : c.assessment.status;
      return {
        text: c.text,
        kind: c.kind,
        hedged: c.hedged,
        status,
        evidence: over
          ? []
          : c.evidence
              .filter((e) => e.stance !== "insufficient")
              .slice(0, 3)
              .map((e) => ({
                url: byId.get(e.sourceId)?.url ?? null,
                title: byId.get(e.sourceId)?.title ?? "Source",
                stance: e.stance,
                quote: e.quoteVerified ? e.quote : null,
                origin: byId.get(e.sourceId)?.origin,
              })),
        finding: findingFor(status, { supporting: c.assessment.supporting, contradicting: c.assessment.contradicting, publishers: c.assessment.independentSupportingPublishers }, notChecked),
        limitations: over ? [] : c.assessment.limitations,
        from: owners(c.text),
      };
    }),
    sources: sources.map((s) => ({ url: s.url ?? "", title: s.title ?? "Source", origin: s.origin })),
    notices: [...notices, ...(sources.some((s) => s.origin === "web") ? ["Web results were checked as search snippets, not full articles. Treat results as a starting point."] : [])],
    steps,
    retrievedAt: now,
    method,
  };
}
