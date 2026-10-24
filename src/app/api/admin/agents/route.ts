import { NextResponse } from "next/server";
import { z } from "zod";
import { AGENT_IDS } from "@/lib/agent-platform/registry";
import { parsePlatformSettings } from "@/lib/ai/platform";
import { requireAdmin } from "@/lib/admin";
import { getAuth } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";

const body = z.object({ agent: z.enum(AGENT_IDS), paused: z.boolean() });

/**
 * POST /api/admin/agents — pause or resume a task agent for everyone (administrators only; the settings
 * table's row-level security also refuses anyone else). A paused agent can't start new tasks, whoever or
 * whatever starts them (its page, the Orbis Agent, a workflow); tasks already running carry on.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(await getAuth());
    const { agent, paused } = await parseJsonBody(req, body, 200);
    const { data, error } = await auth.supabase.from("app_settings").select("settings").eq("id", 1).maybeSingle();
    if (error || !data) throw new ApiError("internal", "Couldn't read the platform settings.");
    const raw = ((data as { settings: unknown }).settings ?? {}) as Record<string, unknown>;
    const current = parsePlatformSettings(raw).pausedAgents;
    const pausedAgents = paused ? [...new Set([...current, agent])] : current.filter((a) => a !== agent);
    // Only this field changes; everything else in the settings is kept as stored.
    const { data: saved, error: saveError } = await auth.supabase
      .from("app_settings")
      .update({ settings: { ...raw, pausedAgents }, updated_by: auth.user.id })
      .eq("id", 1)
      .select("id");
    if (saveError || !saved?.length) throw new ApiError("internal", "The change couldn't be saved.");
    return NextResponse.json({ pausedAgents });
  } catch (err) {
    return errorResponse(err);
  }
}
