import { NextResponse } from "next/server";
import { builtinAgent } from "@/lib/agents/builtins";
import { assertCapabilitiesAvailable } from "@/lib/agents/capabilities";
import { agentPatch } from "@/lib/agents/schema";
import { isBuiltinId } from "@/lib/agents/types";
import { requireUser } from "@/lib/auth";
import { deleteAgent, getAgent, updateAgent } from "@/lib/db/agents";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { uuid } from "@/lib/validation";

async function customId(ctx: RouteContext<"/api/agents/[id]">) {
  const { id } = await ctx.params;
  if (isBuiltinId(id)) throw new ApiError("forbidden", "Built-in agents can't be changed. Duplicate it to make your own version.");
  if (!uuid.safeParse(id).success) throw new ApiError("not_found", "Agent not found.");
  return id;
}

export async function GET(_req: Request, ctx: RouteContext<"/api/agents/[id]">) {
  try {
    const { id } = await ctx.params;
    if (isBuiltinId(id)) return NextResponse.json({ agent: builtinAgent(id) });
    if (!uuid.safeParse(id).success) throw new ApiError("not_found", "Agent not found.");
    const { supabase, user } = await requireUser();
    return NextResponse.json({ agent: await getAgent(supabase, user.id, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request, ctx: RouteContext<"/api/agents/[id]">) {
  try {
    const id = await customId(ctx);
    const body = await parseJsonBody(req, agentPatch, 24_000);
    const { supabase, user } = await requireUser();
    if (body.capabilities) assertCapabilitiesAvailable(body.capabilities);
    return NextResponse.json({ agent: await updateAgent(supabase, user.id, id, body) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE — removes the agent and all of its conversations. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/agents/[id]">) {
  try {
    const id = await customId(ctx);
    const { supabase, user } = await requireUser();
    await deleteAgent(supabase, user.id, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
