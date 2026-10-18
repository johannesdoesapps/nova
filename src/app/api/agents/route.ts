import { NextResponse } from "next/server";
import { builtinAgents } from "@/lib/agents/builtins";
import { assertCapabilitiesAvailable, capabilityStatus } from "@/lib/agents/capabilities";
import { agentInput } from "@/lib/agents/schema";
import { getAuth, requireUser } from "@/lib/auth";
import { createAgent, listAgents } from "@/lib/db/agents";
import { errorResponse, parseJsonBody } from "@/lib/http";

/**
 * GET /api/agents — built-in agents, the caller's custom agents, and which
 * capabilities this deployment supports. Guests get built-ins only; their
 * custom agents live in the browser (`persistence: "local"`).
 */
export async function GET() {
  try {
    const auth = await getAuth();
    const agents = auth.mode === "authenticated" ? await listAgents(auth.supabase, auth.user.id) : [];
    return NextResponse.json({
      builtins: builtinAgents(),
      agents,
      capabilities: capabilityStatus(),
      persistence: auth.mode === "authenticated" ? "server" : "local",
    });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/agents — create a custom agent (signed-in users). */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, agentInput, 24_000);
    const { supabase, user } = await requireUser();
    assertCapabilitiesAvailable(body.capabilities);
    return NextResponse.json({ agent: await createAgent(supabase, user.id, body) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
