import { NextResponse } from "next/server";
import { getProvider, resolveModel, withTimeout } from "@/lib/ai";
import { isAutoId } from "@/lib/ai/platform";
import { requireUserIfConfigured } from "@/lib/auth";
import { extractClaims } from "@/lib/claims/extract";
import { buildJudgeMessages, parseJudgements } from "@/lib/claims/llm";
import { serverEnv } from "@/lib/env";
import { ApiError, clientIp, errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { limiter } from "@/lib/rate-limit";
import { webSearch } from "@/lib/search/web";
import { enforceLimits, planLimits, recordRun } from "@/lib/usage";
import { runCheck, textToCheck, type CheckDeps } from "@/lib/verify/check";
import { verifyRequest } from "@/lib/verify/schema";

export const maxDuration = 60;

/**
 * POST /api/verify — the verification workflow. Finds the claims in an answer,
 * chosen claims, a document or several responses; gathers evidence from the
 * user's documents and (when set up) one web search; and compares each claim
 * with it. A model's judgement only counts when its quote is found verbatim
 * in a source. Without any source, nothing is marked as checked.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, verifyRequest, 300_000);
    const auth = await requireUserIfConfigured();
    const env = serverEnv();
    const searchReady = !!env.searchKey && ["tavily", "brave"].includes(env.searchProvider);
    const willSearch = body.web && searchReady;
    const hasClaims = extractClaims(textToCheck(body).text).claims.length > 0;
    const mayJudge = hasClaims && (willSearch || !!body.documents?.length);

    // The judge model is chosen up front so plan access, cost and the plan's web searches are checked before anything runs.
    const judge = mayJudge ? await resolveModel(isAutoId(body.modelId) ? undefined : body.modelId).catch(() => null) : null;
    const realJudge = judge && judge.provider !== "demo" ? judge : null;
    if (mayJudge) {
      const limits = auth.mode === "authenticated" ? await planLimits(auth) : null;
      if (willSearch && limits?.webSearchesLeft === 0) throw new ApiError("quota_exceeded", "Your plan's web searches for this month are used up. Turn off web search to check against your own documents, or wait until it renews.", { scope: "web_search" });
      const chars = textToCheck(body).text.length + (body.documents ?? []).reduce((n, d) => n + d.content.length, 0);
      await enforceLimits(req, auth, 1, realJudge ? [realJudge] : undefined, { purpose: "verify", inputTokens: Math.ceil(chars / 4) + 3000 });
      const who = auth.mode === "authenticated" ? `u:${auth.user.id}` : `ip:${clientIp(req)}`;
      if (!limiter("search-minute", Math.max(2, Math.floor(env.ratePerMinute / 2)), 60_000).check(who, 1).ok) throw new ApiError("rate_limited", "Too many checks. Please wait a moment.");
    }

    let modelUsed = false;
    const deps: CheckDeps = {
      search: willSearch ? async (q) => (await webSearch(q, { provider: env.searchProvider, apiKey: env.searchKey }, withTimeout(15_000, req.signal))).sources : null,
      judge: realJudge
        ? async (claims, sources) => {
            const messages = buildJudgeMessages(claims, sources);
            const started = performance.now();
            const base = { model: realJudge, prompt: (body.question || claims[0]?.text || "").slice(0, 400), purpose: "verify" as const, requestedModel: body.modelId ?? null, routingReason: "Verification judge", tools: willSearch ? ["web_search"] : [] };
            try {
              const r = await getProvider(realJudge.provider).generate({ model: realJudge, messages, maxOutputTokens: 4000, temperature: 0, signal: withTimeout(40_000, req.signal) });
              modelUsed = true;
              await recordRun(auth, { ...base, response: r.text, latencyMs: performance.now() - started, usage: r.usage, status: "success" });
              return parseJudgements(r.text);
            } catch (err) {
              modelUsed = true;
              await recordRun(auth, { ...base, response: "", latencyMs: performance.now() - started, usage: { inputTokens: null, outputTokens: null, estimated: true }, status: "error", error: err instanceof Error ? err.message : "failed" });
              if (!(err instanceof ApiError)) reportError(err, { where: "verify.judge" });
              throw err;
            }
          }
        : null,
    };
    const result = await runCheck(body, deps);
    // A web search that wasn't followed by a model call is still counted against the plan's searches.
    if (result.searched && !modelUsed && realJudge) {
      await recordRun(auth, { model: realJudge, prompt: body.question.slice(0, 400) || "(verification)", response: "(web search only)", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0, estimated: false }, status: "success", purpose: "verify", requestedModel: body.modelId ?? null, routingReason: "Verification web search", tools: ["web_search"] });
    }
    return NextResponse.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
