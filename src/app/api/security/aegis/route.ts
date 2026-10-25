import { NextResponse } from "next/server";
import { assertAgentAccess } from "@/lib/agent-platform/server";
import { requireUser } from "@/lib/auth";
import { loadControls } from "@/lib/bastion/server";
import { summarise, type DecisionEvent } from "@/lib/bastion/view";
import { errorResponse } from "@/lib/http";
import { loadAegis } from "@/lib/security/aegis/server";

export const maxDuration = 30;

/**
 * GET /api/security/aegis — Orbis Aegis: the user's security posture assembled from every agent's recorded
 * findings and runs — prioritised risks with their reasons, cross-agent attack-path hypotheses, duplicate
 * candidates, coverage and blind spots, tasks, investigations, remediations and agent health. Read-only.
 */
export async function GET() {
  try {
    const auth = await requireUser();
    await assertAgentAccess(auth, "security");
    const [controls, { data }] = await Promise.all([
      loadControls(),
      auth.supabase.from("security_audit").select("action,detail,created_at").eq("user_id", auth.user.id).like("action", "bastion.%").order("created_at", { ascending: false }).limit(1000),
    ]);
    const b = summarise((data ?? []) as DecisionEvent[], 0);
    const bastion = { available: !!controls, lockdown: !!controls?.lockdown, decisions: b.total, denied: b.denied, needsApproval: b.needsApproval };
    return NextResponse.json(await loadAegis(auth.supabase, auth.user.id, { bastion }));
  } catch (err) {
    return errorResponse(err);
  }
}
