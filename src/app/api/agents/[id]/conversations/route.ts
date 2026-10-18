import { NextResponse } from "next/server";
import { isBuiltinId } from "@/lib/agents/types";
import { requireUser } from "@/lib/auth";
import { getAgent, listAgentConversations } from "@/lib/db/agents";
import { ApiError, errorResponse } from "@/lib/http";
import { uuid } from "@/lib/validation";

/** GET /api/agents/[id]/conversations — the caller's conversations with one agent. */
export async function GET(_req: Request, ctx: RouteContext<"/api/agents/[id]/conversations">) {
  try {
    const { id } = await ctx.params;
    if (!isBuiltinId(id) && !uuid.safeParse(id).success) throw new ApiError("not_found", "Agent not found.");
    const { supabase, user } = await requireUser();
    if (!isBuiltinId(id)) await getAgent(supabase, user.id, id);
    return NextResponse.json({ conversations: await listAgentConversations(supabase, user.id, id) });
  } catch (err) {
    return errorResponse(err);
  }
}
