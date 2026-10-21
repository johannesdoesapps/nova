import { NextResponse } from "next/server";
import { getRun, listChanges, listEvents, runOptions, toRunView } from "@/lib/code/agent/runs";
import { runAttachments } from "@/lib/code/attachments-store";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";

/** GET /api/code/agent/[runId]?after=seq — the run, its activity after an event number, the files it changed, and (first read) its attachments. */
export async function GET(req: Request, ctx: RouteContext<"/api/code/agent/[runId]">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const after = Math.max(0, Number(new URL(req.url).searchParams.get("after") ?? 0) || 0);
    const auth = await codeContext("code-agent-read", 240);
    const row = await getRun(auth, runId);
    // Attachment names and sizes (never contents), on the first read only: they don't change.
    const withAttachments = after === 0 && !!runOptions(row).attachments;
    const [events, changes, attachments] = await Promise.all([listEvents(auth, runId, after), listChanges(auth, runId), withAttachments ? runAttachments(auth, runId) : Promise.resolve(undefined)]);
    return NextResponse.json({ run: toRunView(row), events, changes, ...(attachments ? { attachments } : {}) });
  } catch (err) {
    return errorResponse(err);
  }
}
