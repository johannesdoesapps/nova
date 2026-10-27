import { NextResponse } from "next/server";
import { getSettings, requireOrchestrator, updateSettings } from "@/lib/orchestrator/server";
import { settingsSchema } from "@/lib/orchestrator/types";
import { errorResponse, parseJsonBody } from "@/lib/http";

/** GET /api/orchestrator/settings — the concurrency limit (1–3) and what each of the three slots is doing. */
export async function GET() {
  try {
    const auth = await requireOrchestrator();
    return NextResponse.json(await getSettings(auth));
  } catch (err) {
    return errorResponse(err);
  }
}

/** PATCH /api/orchestrator/settings — `{"maxConcurrency": 1 | 2 | 3}`. Never above 3 (the database refuses it too). */
export async function PATCH(req: Request) {
  try {
    const auth = await requireOrchestrator(20);
    const { maxConcurrency } = await parseJsonBody(req, settingsSchema, 200);
    return NextResponse.json(await updateSettings(auth, maxConcurrency));
  } catch (err) {
    return errorResponse(err);
  }
}
