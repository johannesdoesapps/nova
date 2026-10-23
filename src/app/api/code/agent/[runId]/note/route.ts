import { NextResponse } from "next/server";
import { z } from "zod";
import { getRun } from "@/lib/code/agent/runs";
import { ENDED_STATUSES } from "@/lib/code/agent/types";
import { addPairNote } from "@/lib/code/pair/engine";
import { codeContext } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

const body = z.object({ text: z.string().trim().min(1).max(4_000) });

/**
 * POST /api/code/agent/[runId]/note — instructions for a pair task while it works. They're kept in the
 * task's activity log and given to the next agent call (the Architect or the Reviewer, whichever is next).
 */
export async function POST(req: Request, ctx: RouteContext<"/api/code/agent/[runId]/note">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const { text } = await parseJsonBody(req, body, 8_000);
    const auth = await codeContext("code-agent", 30);
    const row = await getRun(auth, runId);
    if (!row.pair) throw new ApiError("bad_request", "Instructions while it works are for pair tasks; for this task, use the prompt box.");
    if (ENDED_STATUSES.includes(row.status)) throw new ApiError("conflict", "This task has finished. Start a new task that continues it instead.");
    await addPairNote(auth, row, text);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
