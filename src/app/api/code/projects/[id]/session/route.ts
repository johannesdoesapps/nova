import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext, extendSession, getProjectRow, liveSession, optionalBox, previewUrl, startSession, stopSession, workspaceAllowance } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

export const maxDuration = 120;

type Ctx = RouteContext<"/api/code/projects/[id]/session">;

/** GET /api/code/projects/[id]/session — whether the computer is running, until when, and time left this month. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext();
    await getProjectRow(auth, id);
    const [live, a] = await Promise.all([liveSession(auth, id), workspaceAllowance(auth)]);
    const box = live ? await optionalBox(auth, id) : null;
    return NextResponse.json({
      session: live && box ? { ...live, previewUrl: previewUrl(box) } : null,
      allowance: { used: a.used, limit: a.limit, left: a.left, blockMinutes: a.blockMinutes, resetsAt: a.resetsAt },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.object({ action: z.enum(["start", "extend", "stop"]) });

/** POST /api/code/projects/[id]/session — start the computer, give it another block of time, or stop it. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const { action } = await parseJsonBody(req, body, 1_000);
    const auth = await codeContext("code-session", 20);
    const project = await getProjectRow(auth, id);
    if (action === "stop") {
      await stopSession(auth, id);
      return NextResponse.json({ session: null });
    }
    const s = action === "start" ? await startSession(auth, project) : await extendSession(auth, project);
    const { allowance, ...session } = s;
    return NextResponse.json({ session, allowance });
  } catch (err) {
    return errorResponse(err);
  }
}
