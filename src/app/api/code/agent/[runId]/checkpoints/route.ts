import { NextResponse } from "next/server";
import { z } from "zod";
import { restoreCheckpoint } from "@/lib/code/agent/engine";
import { listCheckpoints } from "@/lib/code/agent/runs";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

/** GET /api/code/agent/[runId]/checkpoints — the run's checkpoints (labels, times and which files each holds). */
export async function GET(_req: Request, ctx: RouteContext<"/api/code/agent/[runId]/checkpoints">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const auth = await codeContext("code-agent-read", 240);
    const checkpoints = (await listCheckpoints(auth, runId)).map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt, paths: Object.keys(c.files) }));
    return NextResponse.json({ checkpoints });
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.object({ checkpointId: z.string().uuid(), force: z.boolean().optional() });

/**
 * POST /api/code/agent/[runId]/checkpoints — restore a checkpoint: the files
 * the run changed go back to it. Files changed since by someone else are
 * reported as conflicts and left alone unless `force` is set.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/code/agent/[runId]/checkpoints">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const input = await parseJsonBody(req, body, 1_000);
    const auth = await codeContext("code-agent", 30);
    return NextResponse.json(await restoreCheckpoint(auth, runId, input.checkpointId, { force: input.force }));
  } catch (err) {
    return errorResponse(err);
  }
}
