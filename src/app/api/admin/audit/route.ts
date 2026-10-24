import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { listAdminActions } from "@/lib/admin-audit";
import { getAuth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";

/** GET /api/admin/audit — the latest administrator actions (administrators only; row-level security also refuses anyone else). */
export async function GET() {
  try {
    const auth = await requireAdmin(await getAuth());
    return NextResponse.json(await listAdminActions(auth.supabase), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
