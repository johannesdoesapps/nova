import { NextResponse } from "next/server";
import { removeAttachment } from "@/lib/code/attachments-store";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";

type Ctx = RouteContext<"/api/code/projects/[id]/attachments/[attachmentId]">;

/** DELETE /api/code/projects/[id]/attachments/[attachmentId] — remove an attachment before its task is sent. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const p = await ctx.params;
    const auth = await codeContext("code-attach", 60);
    await removeAttachment(auth, requireUuid(p.id), requireUuid(p.attachmentId));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
