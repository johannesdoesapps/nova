import { NextResponse } from "next/server";
import { codeContext } from "@/lib/code/server";
import { ApiError, errorResponse, requireUuid } from "@/lib/http";
import { deleteReview, getReview, toView } from "@/lib/review/server";

type Ctx = RouteContext<"/api/review/[id]">;

/**
 * GET /api/review/[id] — the review, its findings and progress. With ?file=path, also that reviewed file's
 * content (to show a finding in context or its suggested fix).
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("review-read", 240);
    const row = await getReview(auth, id);
    const path = new URL(req.url).searchParams.get("file");
    let file: { path: string; content: string; lineNos: number[] | null } | null = null;
    if (path) {
      const f = row.files.find((x) => x.path === path);
      if (!f) throw new ApiError("not_found", "That file isn't part of this review.");
      file = { path: f.path, content: f.content, lineNos: f.lineNos ?? null };
    }
    return NextResponse.json({ review: toView(row), file }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/review/[id] — delete the review and its stored snapshot. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("review-write", 60);
    await getReview(auth, id);
    await deleteReview(auth, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
