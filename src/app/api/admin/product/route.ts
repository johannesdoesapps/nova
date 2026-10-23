import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { productReport, type CodeFunnel, type RawMetrics } from "@/lib/analytics/metrics";
import { getAuth } from "@/lib/auth";
import { ApiError, errorResponse } from "@/lib/http";

/**
 * GET /api/admin/product?days=30 — the product measurement plan's figures
 * (activation, retention, workflow completion, satisfaction, limits…),
 * computed in the database from real records; administrators only. Figures
 * that can't be worked out yet say so rather than showing a number.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAdmin(await getAuth());
    const days = Math.min(365, Math.max(1, Number(new URL(req.url).searchParams.get("days")) || 30));
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const [{ data, error }, code] = await Promise.all([auth.supabase.rpc("admin_product_metrics", { p_since: since }), auth.supabase.rpc("admin_code_funnel", { p_since: since })]);
    if (error || !data) throw new ApiError("internal", "Couldn't load the product figures.");
    const raw = { ...(data as RawMetrics), code: code.error ? null : (code.data as CodeFunnel) };
    return NextResponse.json({ days, raw, rows: productReport(raw) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
