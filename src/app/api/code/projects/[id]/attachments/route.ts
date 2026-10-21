import { NextResponse } from "next/server";
import { attachmentInput } from "@/lib/code/attachments";
import { addAttachment } from "@/lib/code/attachments-store";
import { codeContext, getProjectRow } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

type Ctx = RouteContext<"/api/code/projects/[id]/attachments">;

/**
 * POST /api/code/projects/[id]/attachments — upload one file or image for the
 * next task: { kind: "text", name, content } or { kind: "image", name,
 * mediaType, data (base64) }. Checked here from its contents; kept until a
 * task uses it (or a day passes).
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const body = await parseJsonBody(req, attachmentInput, 3_600_000);
    const auth = await codeContext("code-attach", 60);
    await getProjectRow(auth, id);
    return NextResponse.json({ attachment: await addAttachment(auth, id, body) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
