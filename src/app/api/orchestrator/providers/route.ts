import { NextResponse } from "next/server";
import { providerStatus } from "@/lib/orchestrator/providers";
import { requireOrchestrator } from "@/lib/orchestrator/server";
import { errorResponse } from "@/lib/http";

/**
 * GET /api/orchestrator/providers — which providers have credentials on the server (configured or not, and the
 * name of the environment variable needed). It never returns a key, and "configured" doesn't mean a call works:
 * use POST /api/orchestrator/providers/check for that.
 */
export async function GET() {
  try {
    await requireOrchestrator();
    return NextResponse.json({ providers: await providerStatus() });
  } catch (err) {
    return errorResponse(err);
  }
}
