import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { limiter } from "@/lib/rate-limit";

const body = z.object({ email: z.string().trim().max(320) }).strict();

const REFUSED: Record<string, { code: "forbidden" | "conflict"; message: string }> = {
  "42501": { code: "forbidden", message: "Administrators can't delete their account here. Remove admin access first." },
  "55000": { code: "conflict", message: "Cancel your paid plan first, then delete your account." },
};

/**
 * POST /api/account/delete — delete the signed-in account and everything in
 * it, for good. The user types their email address to confirm; the database
 * deletes only the caller's own account (delete_own_account), then they're
 * signed out.
 */
export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, body, 2_000);
    const auth = await requireUser();
    if (!limiter("account-delete", 5, 60 * 60_000).check(`u:${auth.user.id}`, 1).ok) throw new ApiError("rate_limited", "Too many attempts. Please try again later.");
    if (!auth.user.email || input.email.toLowerCase() !== auth.user.email.toLowerCase()) throw new ApiError("bad_request", "Type your account's email address exactly to confirm.");
    const { error } = await auth.supabase.rpc("delete_own_account");
    if (error) {
      const refused = error.code ? REFUSED[error.code] : undefined;
      if (refused) throw new ApiError(refused.code, refused.message);
      // The database function isn't installed yet (PostgREST: no such function).
      if (error.code === "PGRST202") throw new ApiError("not_configured", "Account deletion isn't switched on yet. Nothing was removed. Please try again later.");
      reportError(error, { where: "account.delete" });
      throw new ApiError("internal", "Your account couldn't be deleted right now. Nothing was removed. Please try again.");
    }
    await auth.supabase.auth.signOut().catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
