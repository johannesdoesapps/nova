import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listComparisons, saveComparison } from "@/lib/db";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { saveComparisonRequest } from "@/lib/validation";

/** GET /api/comparisons — the user's saved comparisons. */
export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    return NextResponse.json({ comparisons: await listComparisons(supabase, user.id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/comparisons — save a Model Battle result (optionally into a project). */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, saveComparisonRequest, 400_000);
    const { supabase, user } = await requireUser();
    const saved = await saveComparison(supabase, user.id, {
      prompt: body.prompt,
      projectId: body.projectId,
      selectedModels: body.results.map((r) => r.modelId),
      metadata: { preferredModelId: body.preferredModelId ?? null, results: body.results },
    });
    return NextResponse.json({ comparison: saved }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
