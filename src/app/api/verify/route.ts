import { NextResponse } from "next/server";
import { getProvider, resolveModel, withTimeout } from "@/lib/ai";
import { isAutoId } from "@/lib/ai/platform";
import { requireUserIfConfigured } from "@/lib/auth";
import { extractClaims } from "@/lib/claims/extract";
import { buildJudgeMessages, parseJudgements } from "@/lib/claims/llm";
import { runClaimPipeline } from "@/lib/claims/pipeline";
import { buildSource } from "@/lib/claims/sources";
import type { ModelJudgement, SourceInput } from "@/lib/claims/types";
import { serverEnv } from "@/lib/env";
import { ApiError, clientIp, errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { limiter } from "@/lib/rate-limit";
import { webSearch } from "@/lib/search/web";
import { enforceLimits } from "@/lib/usage";
import { SEARCH_MISSING, verifyRequest, type VerifyResult } from "@/lib/verify/schema";

export const maxDuration = 60;

/**
 * POST /api/verify — the Truth Layer. Splits an answer into claims, searches
 * the web once, and judges each claim against the search results. A model's
 * judgement only counts when its quote is found verbatim in a source. Without
 * search configured nothing is marked as verified.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, verifyRequest, 200_000);
    const auth = await requireUserIfConfigured();
    const env = serverEnv();
    const now = new Date().toISOString();
    const notices: string[] = [];
    const extracted = extractClaims(body.answer).claims;

    if (!extracted.length) {
      return NextResponse.json({ searched: false, reason: "No checkable claims were found in this answer.", headline: null, claims: [], sources: [], notices } satisfies VerifyResult);
    }

    if (!env.searchKey || !["tavily", "brave"].includes(env.searchProvider)) {
      const result: VerifyResult = {
        searched: false,
        reason: SEARCH_MISSING,
        headline: null,
        claims: extracted.map((c) => ({ text: c.text, kind: c.kind, hedged: c.hedged, status: null, evidence: [] })),
        sources: [],
        notices,
      };
      return NextResponse.json(result);
    }

    await enforceLimits(req, auth, 1);
    const who = auth.mode === "authenticated" ? `u:${auth.user.id}` : `ip:${clientIp(req)}`;
    if (!limiter("search-minute", Math.max(2, Math.floor(env.ratePerMinute / 2)), 60_000).check(who, 1).ok) {
      throw new ApiError("rate_limited", "Too many checks. Please wait a moment.");
    }

    const query = (body.question || extracted[0].text).slice(0, 400);
    const found = await webSearch(query, { provider: env.searchProvider, apiKey: env.searchKey }, withTimeout(15_000, req.signal));
    const sources: SourceInput[] = found.sources.slice(0, 8).map((s) => ({ index: s.index, url: s.url, title: s.title, text: s.snippet, publishedAt: s.publishedAt, contentKind: "snippet" as const }));

    let modelJudgements: ModelJudgement[] = [];
    let modelId: string | null = null;
    let mode: "rules" | "model" = "rules";
    if (sources.length) {
      try {
        const model = await resolveModel(isAutoId(body.modelId) ? undefined : body.modelId);
        if (model.provider === "demo") {
          notices.push("No real AI model is configured, so only rule-based checks were applied.");
        } else {
          const messages = buildJudgeMessages(extracted, sources.map((s, i) => buildSource(s, i, now)));
          const r = await getProvider(model.provider).generate({ model, messages, maxOutputTokens: 4000, temperature: 0, signal: withTimeout(40_000, req.signal) });
          const parsed = parseJudgements(r.text);
          if (parsed.error) notices.push(parsed.error);
          modelJudgements = parsed.judgements;
          modelId = model.id;
          mode = "model";
        }
      } catch (err) {
        if (err instanceof ApiError && err.code !== "internal") notices.push(err.message);
        else reportError(err, { where: "verify.judge" });
        if (!notices.length) notices.push("The AI check failed, so only rule-based checks were applied.");
      }
    } else {
      notices.push("The web search returned no results for this question.");
    }

    const report = runClaimPipeline({ question: body.question, answer: body.answer, sources, now, mode, modelId, modelJudgements });
    const byId = new Map(report.sources.map((s) => [s.id, s]));
    const result: VerifyResult = {
      searched: true,
      reason: null,
      headline: report.summary.headline,
      claims: report.claims.map((c) => ({
        text: c.text,
        kind: c.kind,
        hedged: c.hedged,
        status: c.assessment.status,
        evidence: c.evidence
          .filter((e) => e.stance !== "insufficient")
          .slice(0, 3)
          .map((e) => ({ url: byId.get(e.sourceId)?.url ?? null, title: byId.get(e.sourceId)?.title ?? "Source", stance: e.stance, quote: e.quoteVerified ? e.quote : null })),
      })),
      sources: sources.map((s) => ({ url: s.url ?? "", title: s.title ?? s.url ?? "Source" })),
      notices: [...notices, "Checked against search-result snippets, not full articles. Treat results as a starting point."],
    };
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
