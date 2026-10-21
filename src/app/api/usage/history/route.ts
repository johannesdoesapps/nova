import { NextResponse } from "next/server";
import { z } from "zod";
import { getAllModels } from "@/lib/ai";
import { requireUser } from "@/lib/auth";
import { ApiError, errorResponse, parseQuery } from "@/lib/http";
import { reportError } from "@/lib/observability";

const query = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });

/**
 * GET /api/usage/history?days= — the signed-in user's own requests from the
 * usage records (newest first, up to 500): when, which model (and which one
 * actually answered), the feature, the units charged and the outcome. Prompts
 * and replies aren't returned. Row-level security limits it to the caller.
 */
export async function GET(req: Request) {
  try {
    const q = parseQuery(req.url, query);
    const auth = await requireUser();
    const since = new Date(Date.now() - q.days * 86_400_000).toISOString();
    const [{ data, error }, models] = await Promise.all([
      auth.supabase
        .from("model_runs")
        .select("created_at, model_id, requested_model, served_model, fallback_from, purpose, units, status, error_code, entitlement")
        .eq("user_id", auth.user.id)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(500),
      getAllModels(),
    ]);
    if (error) {
      reportError(error, { where: "usage.history" });
      throw new ApiError("internal", "Your usage history couldn't be loaded right now.");
    }
    const names = new Map(models.map((m) => [m.id, m.displayName]));
    type Row = {
      created_at: string;
      model_id: string;
      requested_model: string | null;
      served_model: string | null;
      fallback_from: string | null;
      purpose: string | null;
      units: number | string | null;
      status: string;
      error_code: string | null;
      entitlement: string | null;
    };
    const rows = ((data ?? []) as Row[]).map((r) => ({
      at: r.created_at,
      model: names.get(r.model_id) ?? r.model_id,
      requested: r.requested_model && r.requested_model !== r.model_id ? (names.get(r.requested_model) ?? r.requested_model) : null,
      fallbackFrom: r.fallback_from ? (names.get(r.fallback_from) ?? r.fallback_from) : null,
      feature: r.purpose ?? "chat",
      units: r.units === null ? null : Number(r.units),
      status: r.status === "success" ? "success" : "error",
      errorCode: r.error_code,
      notCounted: r.entitlement === "admin_unlimited",
    }));
    return NextResponse.json({ days: q.days, rows, truncated: rows.length === 500 }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
