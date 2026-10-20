import { NextResponse } from "next/server";
import { z } from "zod";
import { getModels } from "@/lib/ai";
import { getModelDetail, HUB_REPO_ID } from "@/lib/discovery/huggingface";
import { serverEnv } from "@/lib/env";
import { ApiError, clientIp, errorResponse, parseQuery } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";

const query = z.object({ id: z.string().regex(HUB_REPO_ID).max(200) });

/** GET /api/discover/model?id=org/name — model detail + whether Orbis can run it. */
export async function GET(req: Request) {
  try {
    if (!limiter("discover", 60, 60_000).check(clientIp(req)).ok) {
      throw new ApiError("rate_limited", "Too many discovery requests. Please slow down.");
    }
    const { id } = parseQuery(req.url, query);
    const [detail, registry] = await Promise.all([getModelDetail(id, serverEnv().huggingfaceKey), getModels()]);
    const runnable = registry.find((m) => m.provider === "huggingface" && m.providerModelId === id) ?? null;
    return NextResponse.json({
      model: detail,
      orbis: runnable
        ? { runnable: runnable.available, registryId: runnable.id, reason: runnable.available ? null : runnable.unavailableReason }
        : { runnable: false, registryId: null, reason: "This model is not in Orbis's model registry, so it cannot be run here yet." },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
