import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { getAuth } from "@/lib/auth";
import { unitEconomics, type UnitEconomicsRaw } from "@/lib/billing/unit-economics";
import { ApiError, errorResponse } from "@/lib/http";

/**
 * GET /api/admin/unit-economics?days=30 — cost per active user and per successful coding task, cost and
 * margin by plan, failed-work cost, Free tier cost and cost concentration, each with its definition, plus
 * the data that's still missing (admins only; the database function refuses everyone else too).
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAdmin(await getAuth());
    const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 30));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data, error } = await auth.supabase.rpc("admin_unit_economics", { p_since: since });
    if (error || !data) throw new ApiError("internal", "Couldn't load the unit economics.");
    return NextResponse.json({ economics: unitEconomics(data as UnitEconomicsRaw, days) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
