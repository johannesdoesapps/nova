import { NextResponse } from "next/server";
import { probePreview } from "@/lib/code/preview";
import { codeContext, getProjectRow, optionalBox, previewUrl } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";

type Ctx = RouteContext<"/api/code/projects/[id]/preview">;

/**
 * GET /api/code/projects/[id]/preview — whether the project's site answers
 * on the preview port right now (asked, not assumed), whether its server
 * job is running, and the preview address. Null when the computer is off.
 */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("code-poll", 240);
    await getProjectRow(auth, id);
    const box = await optionalBox(auth, id);
    if (!box) return NextResponse.json({ preview: null });
    const p = await probePreview(box);
    return NextResponse.json({ preview: { http: p.http, running: p.running, exitCode: p.exitCode, otherPorts: p.otherPorts, url: previewUrl(box) } });
  } catch (err) {
    return errorResponse(err);
  }
}
