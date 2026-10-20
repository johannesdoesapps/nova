import { NextResponse } from "next/server";
import { getRun, listChanges, listEvents, toRunView } from "@/lib/code/agent/runs";
import { codeContext } from "@/lib/code/server";
import { errorResponse, requireUuid } from "@/lib/http";

/** GET /api/code/agent/[runId]?after=seq — the run, its activity after an event number, and the files it changed. */
export async function GET(req: Request, ctx: RouteContext<"/api/code/agent/[runId]">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const after = Math.max(0, Number(new URL(req.url).searchParams.get("after") ?? 0) || 0);
    const auth = await codeContext("code-agent-read", 240);
    const row = await getRun(auth, runId);
    const [events, changes] = await Promise.all([listEvents(auth, runId, after), listChanges(auth, runId)]);
    return NextResponse.json({ run: toRunView(row), events, changes });
  } catch (err) {
    return errorResponse(err);
  }
}
