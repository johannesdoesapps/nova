import { NextResponse } from "next/server";
import { searchDatasets } from "@/lib/discovery/huggingface";
import { serverEnv } from "@/lib/env";
import { ApiError, clientIp, errorResponse, parseQuery } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import { discoverQuery } from "@/lib/validation";

/** GET /api/discover/datasets — search Hugging Face Hub datasets. */
export async function GET(req: Request) {
  try {
    if (!limiter("discover", 60, 60_000).check(clientIp(req)).ok) {
      throw new ApiError("rate_limited", "Too many discovery requests. Please slow down.");
    }
    const q = parseQuery(req.url, discoverQuery);
    const page = await searchDatasets(q, serverEnv().huggingfaceKey);
    return NextResponse.json(page, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (err) {
    return errorResponse(err);
  }
}
