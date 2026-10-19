import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { audit, deleteTarget } from "@/lib/db/security";
import { errorResponse, requireUuid } from "@/lib/http";

/** DELETE /api/security/targets/[id] — stop scanning a website. Findings are kept. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/security/targets/[id]">) {
  try {
    const auth = await requireUser();
    const id = requireUuid((await ctx.params).id);
    await deleteTarget(auth.supabase, auth.user.id, id);
    await audit(auth.supabase, auth.user.id, "target.removed", { detail: { id } });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
