import { NextResponse } from "next/server";
import { z } from "zod";
import { liveProviderCheck, requireOrchestrator } from "@/lib/orchestrator/server";
import { errorResponse, parseJsonBody } from "@/lib/http";

export const maxDuration = 60;

const body = z.object({ provider: z.string().trim().min(1).max(40), modelId: z.string().trim().min(1).max(200) }).strict();

/**
 * POST /api/orchestrator/providers/check — a real, metered call of a few tokens to the provider, to confirm the
 * credentials and the model work. It takes one of the global execution slots (429 when all are busy).
 */
export async function POST(req: Request) {
  try {
    const auth = await requireOrchestrator(6);
    const { provider, modelId } = await parseJsonBody(req, body, 1_000);
    return NextResponse.json(await liveProviderCheck(auth, provider, modelId));
  } catch (err) {
    return errorResponse(err);
  }
}
