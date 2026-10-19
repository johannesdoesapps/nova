import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { audit, getTarget, setTargetVerified } from "@/lib/db/security";
import { ApiError, errorResponse } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import { proveOwnership } from "@/lib/security/authz";

export const maxDuration = 30;

/** POST /api/security/targets/[id]/verify — check the ownership token now. */
export async function POST(req: Request, ctx: RouteContext<"/api/security/targets/[id]/verify">) {
  try {
    const auth = await requireUser();
    if (!limiter("target-verify", 10, 60_000).check(auth.user.id, 1).ok) throw new ApiError("rate_limited", "Too many checks. Please wait a minute.");
    const { id } = await ctx.params;
    const target = await getTarget(auth.supabase, auth.user.id, id);
    const proof = await proveOwnership(target, auth, req.signal);
    await setTargetVerified(auth.supabase, target.id, proof.ok ? proof.method : null);
    await audit(auth.supabase, auth.user.id, proof.ok ? "target.verified" : "target.verify_failed", { detail: { hostname: target.hostname, method: proof.ok ? proof.method : null } });
    return NextResponse.json(proof.ok ? { verified: true, method: proof.method } : { verified: false, reason: proof.reason });
  } catch (err) {
    return errorResponse(err);
  }
}
