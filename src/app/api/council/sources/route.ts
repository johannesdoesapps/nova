import { NextResponse } from "next/server";
import { searchBackend, searchWeb } from "@/lib/search/live";
import { z } from "zod";
import { resolveModel, withTimeout } from "@/lib/ai";
import { requireUserIfConfigured } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import { ApiError, clientIp, errorResponse, parseJsonBody } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import { enforceLimits, planLimits, recordRun, releaseUsage } from "@/lib/usage";

const body = z.object({ question: z.string().trim().min(2).max(2000) });

/**
 * POST /api/council/sources — one shared web search so every model sees the
 * same evidence. Reports plainly when search isn't configured.
 */
export async function POST(req: Request) {
  try {
    const { question } = await parseJsonBody(req, body);
    const auth = await requireUserIfConfigured();
    const env = serverEnv();
    if (!searchBackend()) {
      return NextResponse.json({ available: false, reason: "Web search isn't set up on this site (SEARCH_PROVIDER and SEARCH_API_KEY).", sources: [] });
    }
    const who = auth.mode === "authenticated" ? `u:${auth.user.id}` : `ip:${clientIp(req)}`;
    const ok = limiter("search-minute", Math.max(2, Math.floor(env.ratePerMinute / 2)), 60_000).check(who, 1);
    if (!ok.ok) throw new ApiError("rate_limited", "Too many searches. Please wait a moment.");
    // A search is billable: it counts against the plan's monthly searches and the AI allowance.
    if (auth.mode === "authenticated" && (await planLimits(auth)).webSearchesLeft === 0) {
      return NextResponse.json({ available: false, reason: "Your plan's web searches for this month are used up.", sources: [] });
    }
    await enforceLimits(req, auth, 1, undefined, { purpose: "web_search", inputTokens: 0, maxOutputTokens: 0 });
    const started = performance.now();
    const r = await searchWeb(question.slice(0, 400), { auth, signal: withTimeout(30_000, req.signal), purpose: "council" }).catch(async (err) => {
      await releaseUsage(auth);
      throw err;
    });
    await recordRun(auth, { model: await resolveModel(), prompt: question.slice(0, 400), response: "(web search)", latencyMs: performance.now() - started, usage: { inputTokens: 0, outputTokens: 0, estimated: false }, status: "success", purpose: "web_search", routingReason: "Council shared search", tools: ["web_search"] });
    return NextResponse.json({ available: true, sources: r.sources.slice(0, 8).map(({ index, url, title, snippet }) => ({ index, url, title, snippet })) });
  } catch (err) {
    return errorResponse(err);
  }
}
