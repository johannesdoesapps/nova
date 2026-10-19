import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { getAuth } from "@/lib/auth";
import { financeReport, type FinanceSummary } from "@/lib/billing/finance";
import { getBilling } from "@/lib/entitlements";
import { ApiError, errorResponse } from "@/lib/http";

/**
 * GET /api/admin/finance?days=30 — revenue, AI costs, margins by plan, model
 * usage, heaviest users against their budgets, projections and alerts
 * (admins only). Figures are estimates from recorded usage and the configured
 * fee and hosting assumptions; Stripe remains the source of truth for money.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAdmin(await getAuth());
    const days = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 30));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const [{ data, error }, billing] = await Promise.all([auth.supabase.rpc("admin_finance_summary_v3", { p_since: since }), getBilling()]);
    if (error || !data) throw new ApiError("internal", "Couldn't load the finance figures.");
    return NextResponse.json({ report: financeReport(data as FinanceSummary, billing, days), billing }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
