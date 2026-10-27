import { after, NextResponse } from "next/server";
import { z } from "zod";
import { driveInBackground, workerAuthorized } from "@/lib/code/agent/background";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";

// One worker call takes steps for up to WORKER_STEP_MS, then hands over to a fresh call.
export const maxDuration = 300;

const body = z.object({ runId: z.uuid() });

/**
 * POST /api/code/agent/worker — keep a coding task going without its page (src/lib/code/agent/background.ts).
 * Called only by Orbis itself, with the worker secret. It answers at once and works afterwards; it never trusts
 * anything but the run's id: the owner, the run's state and whether it may run in the background come from the
 * database.
 */
export async function POST(req: Request) {
  try {
    if (!workerAuthorized(req)) throw new ApiError("unauthorized", "Not allowed.");
    const { runId } = await parseJsonBody(req, body, 200);
    const origin = new URL(req.url).origin;
    after(() => driveInBackground(runId, origin).catch(() => undefined));
    return NextResponse.json({ accepted: true }, { status: 202 });
  } catch (err) {
    return errorResponse(err);
  }
}
