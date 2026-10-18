import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import type { ClaimReport } from "@/lib/claims/types";
import { deleteClaimReport, getClaimReport, saveClaimReport } from "@/lib/db/research";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { uuid } from "@/lib/validation";
import { storedReport } from "@/lib/validation-research";

type Ctx = RouteContext<"/api/claims/reports/[id]">;

async function idFrom(ctx: Ctx) {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError("bad_request", "Invalid report id.");
  return id;
}

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const auth = await requireUser();
    return NextResponse.json({ report: await getClaimReport(auth.supabase, auth.user.id, await idFrom(ctx)) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** PUT — store a report after user reviews (re-assessed in the browser by the same pure pipeline). */
export async function PUT(req: Request, ctx: Ctx) {
  try {
    const id = await idFrom(ctx);
    const body = await parseJsonBody(req, storedReport, 2_000_000);
    if (body.id !== id) throw new ApiError("bad_request", "Report id does not match the URL.");
    const auth = await requireUser();
    await saveClaimReport(auth.supabase, auth.user.id, body as unknown as ClaimReport);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const auth = await requireUser();
    await deleteClaimReport(auth.supabase, auth.user.id, await idFrom(ctx));
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
