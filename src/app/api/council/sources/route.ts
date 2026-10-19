import { NextResponse } from "next/server";
import { z } from "zod";
import { withTimeout } from "@/lib/ai";
import { requireUserIfConfigured } from "@/lib/auth";
import { serverEnv } from "@/lib/env";
import { ApiError, clientIp, errorResponse, parseJsonBody } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import { webSearch } from "@/lib/search/web";

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
    if (!env.searchKey || !["tavily", "brave"].includes(env.searchProvider)) {
      return NextResponse.json({ available: false, reason: "Web search isn't set up on this site (SEARCH_PROVIDER and SEARCH_API_KEY).", sources: [] });
    }
    const who = auth.mode === "authenticated" ? `u:${auth.user.id}` : `ip:${clientIp(req)}`;
    const ok = limiter("search-minute", Math.max(2, Math.floor(env.ratePerMinute / 2)), 60_000).check(who, 1);
    if (!ok.ok) throw new ApiError("rate_limited", "Too many searches. Please wait a moment.");
    const r = await webSearch(question.slice(0, 400), { provider: env.searchProvider, apiKey: env.searchKey }, withTimeout(15_000, req.signal));
    return NextResponse.json({ available: true, sources: r.sources.slice(0, 8).map(({ index, url, title, snippet }) => ({ index, url, title, snippet })) });
  } catch (err) {
    return errorResponse(err);
  }
}
