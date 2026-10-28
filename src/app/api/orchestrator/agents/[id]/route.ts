import { after, NextResponse } from "next/server";
import { kickOrchestrator } from "@/lib/orchestrator/background";
import { deleteAgent, getAgent, requireOrchestrator, updateAgent } from "@/lib/orchestrator/server";
import { agentUpdateSchema } from "@/lib/orchestrator/types";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

type Ctx = RouteContext<"/api/orchestrator/agents/[id]">;

/** GET /api/orchestrator/agents/[id] — one agent profile. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await requireOrchestrator();
    return NextResponse.json({ agent: await getAgent(auth, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/orchestrator/agents/[id] — change a profile, including enabling or disabling it (`{"enabled": false}`)
 * or switching its model. Tasks already running keep the model they started with; the next attempt uses the new one.
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await requireOrchestrator(30);
    const patch = await parseJsonBody(req, agentUpdateSchema, 40_000);
    const updated = await updateAgent(auth, id, patch);
    // Enabling an agent (or changing what it takes) queues the tasks that were waiting for it: start a worker.
    if (updated.agent.enabled) {
      const origin = new URL(req.url).origin;
      after(() => kickOrchestrator(origin));
    }
    return NextResponse.json(updated);
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/orchestrator/agents/[id] — remove a profile. Refused while one of its attempts is running. Its tasks
 * and attempts are kept (with the agent's name and model recorded on them); queued tasks locked to it become blocked.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await requireOrchestrator(30);
    return NextResponse.json(await deleteAgent(auth, id));
  } catch (err) {
    return errorResponse(err);
  }
}
