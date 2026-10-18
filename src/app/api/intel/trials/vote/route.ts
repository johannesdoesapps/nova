import { NextResponse } from "next/server";
import { requireUserIfConfigured } from "@/lib/auth";
import { saveTrial } from "@/lib/db/research";
import { unseal } from "@/lib/intel/seal";
import type { TrialRecord } from "@/lib/intel/types";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { trialVoteRequest } from "@/lib/validation-research";
import type { SealedTrial } from "@/lib/intel/trials";

/**
 * POST /api/intel/trials/vote — record the vote, then reveal which model was
 * which (plus latency and cost). Signed-in users' trials are stored; guests get
 * the record back to keep in their browser.
 */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, trialVoteRequest, 40_000);
    const auth = await requireUserIfConfigured();
    const t = unseal<SealedTrial>(body.token);
    const me = auth.mode === "authenticated" ? auth.user.id : null;
    if (t.userId !== me) throw new ApiError("forbidden", "This trial belongs to a different session.");

    const trial: TrialRecord = {
      id: t.id,
      createdAt: t.createdAt,
      category: t.category as TrialRecord["category"],
      prompt: t.prompt,
      promptHash: t.promptHash,
      testItemId: t.testItemId,
      arms: t.arms,
      winner: body.winner,
      ratings: body.ratings,
      note: body.note ?? null,
      redactions: t.redactions,
    };
    let saved = false;
    if (auth.mode === "authenticated") {
      await saveTrial(auth.supabase, auth.user.id, trial);
      saved = true;
    }
    return NextResponse.json({ trial, saved });
  } catch (err) {
    return errorResponse(err);
  }
}
