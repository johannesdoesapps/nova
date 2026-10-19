import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { addTarget, audit, listTargets } from "@/lib/db/security";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { VERIFY_PATH } from "@/lib/security/authz";
import { normalizeHost } from "@/lib/security/net";
import { targetCreate } from "@/lib/security/schema";

/** GET /api/security/targets — websites the user has added for Sentinel. */
export async function GET() {
  try {
    const auth = await requireUser();
    return NextResponse.json({ targets: await listTargets(auth.supabase, auth.user.id), verifyPath: VERIFY_PATH });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/security/targets — add a website; it must be verified before scanning. */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    const { host } = await parseJsonBody(req, targetCreate);
    let hostname: string;
    try {
      hostname = normalizeHost(host);
    } catch (e) {
      throw new ApiError("bad_request", (e as Error).message);
    }
    const existing = await listTargets(auth.supabase, auth.user.id);
    if (existing.length >= 20) throw new ApiError("bad_request", "You can add up to 20 websites.");
    const target = await addTarget(auth.supabase, auth.user.id, hostname);
    await audit(auth.supabase, auth.user.id, "target.added", { detail: { hostname } });
    return NextResponse.json({ target, verifyPath: VERIFY_PATH }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
