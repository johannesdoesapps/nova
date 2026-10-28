import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { errorResponse, parseQuery } from "@/lib/http";
import { usageEstimate } from "@/lib/usage-estimate";
import { ESTIMATED_FEATURES, type EstimatedFeature } from "@/lib/usage-glance";

const query = z.object({ feature: z.enum(Object.keys(ESTIMATED_FEATURES) as [EstimatedFeature, ...EstimatedFeature[]]) });

/**
 * GET /api/usage/estimate?feature= — what one run of a costly task (a coding task, research, a code review…)
 * usually uses, as a share of the signed-in user's week, from their own recent runs or, before they have any,
 * everyone's; and how much of the week is left. Shares only.
 */
export async function GET(req: Request) {
  try {
    const q = parseQuery(req.url, query);
    const auth = await requireUser();
    return NextResponse.json(await usageEstimate(auth, q.feature), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
