import { NextResponse } from "next/server";
import { searchModels } from "@/lib/discovery/huggingface";
import { serverEnv } from "@/lib/env";
import { clientIp, errorResponse, ApiError, parseQuery } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import { discoverQuery } from "@/lib/validation";

/** GET /api/discover — search Hugging Face Hub models (real Hub API responses, cached 5 min). */
export async function GET(req: Request) {
  try {
    if (!limiter("discover", 60, 60_000).check(clientIp(req)).ok) {
      throw new ApiError("rate_limited", "Too many discovery requests. Please slow down.");
    }
    const q = parseQuery(req.url, discoverQuery);
    const page = await searchModels(q, serverEnv().huggingfaceKey);
    return NextResponse.json(page, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (err) {
    return errorResponse(err);
  }
}
