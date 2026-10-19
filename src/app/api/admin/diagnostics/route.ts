import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { getAuth } from "@/lib/auth";
import { ApiError, errorResponse } from "@/lib/http";

/**
 * GET /api/admin/diagnostics?limit=&email= — recent requests with the model
 * chosen, why, units charged, fallbacks and errors (admins only). Metadata
 * only: prompts and replies are never returned.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireAdmin(await getAuth());
    const url = new URL(req.url);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
    const email = url.searchParams.get("email")?.trim().slice(0, 200) || null;
    const { data, error } = await auth.supabase.rpc("admin_request_log", { p_limit: limit, p_email: email });
    if (error) throw new ApiError("internal", "Couldn't load the request log.");
    return NextResponse.json({ requests: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
