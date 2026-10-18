import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listClaimReports } from "@/lib/db/research";
import { errorResponse } from "@/lib/http";

/** GET /api/claims/reports — the signed-in user's saved claim reports (summaries only). */
export async function GET() {
  try {
    const auth = await requireUser();
    return NextResponse.json({ reports: await listClaimReports(auth.supabase, auth.user.id) });
  } catch (err) {
    return errorResponse(err);
  }
}
