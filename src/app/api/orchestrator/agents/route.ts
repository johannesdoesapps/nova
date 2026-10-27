import { NextResponse } from "next/server";
import { createAgent, listAgents, requireOrchestrator } from "@/lib/orchestrator/server";
import { agentCreateSchema } from "@/lib/orchestrator/types";
import { errorResponse, parseJsonBody } from "@/lib/http";

/** GET /api/orchestrator/agents — the administrator's agent profiles (enabled and disabled). */
export async function GET() {
  try {
    const auth = await requireOrchestrator();
    return NextResponse.json({ agents: await listAgents(auth) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/orchestrator/agents — create an agent profile. The provider, model and tools are checked first:
 * unknown ones are refused, and warnings (for example a model that can't call tools) come back with the profile.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireOrchestrator(30);
    const input = await parseJsonBody(req, agentCreateSchema, 40_000);
    return NextResponse.json(await createAgent(auth, input), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
