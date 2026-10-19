import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getRun } from "@/lib/db/security";
import { errorResponse, requireUuid } from "@/lib/http";

/** GET /api/security/runs/[id] — a run with its steps, report, child runs and findings. */
export async function GET(_req: Request, ctx: RouteContext<"/api/security/runs/[id]">) {
  try {
    const auth = await requireUser();
    const id = requireUuid((await ctx.params).id);
    return NextResponse.json(await getRun(auth.supabase, auth.user.id, id));
  } catch (err) {
    return errorResponse(err);
  }
}
