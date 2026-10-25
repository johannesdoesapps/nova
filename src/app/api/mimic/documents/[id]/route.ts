import { NextResponse } from "next/server";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";
import { deleteDocument } from "@/lib/mimic/server";

type Ctx = RouteContext<"/api/mimic/documents/[id]">;

/** DELETE /api/mimic/documents/[id] — delete an invoice from the inbox. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("mimic-write", 60);
    await deleteDocument(auth, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
