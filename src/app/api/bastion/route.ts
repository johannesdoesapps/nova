import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { requireUser } from "@/lib/auth";
import { ENFORCEMENT_POINTS } from "@/lib/bastion/coverage";
import { loadControls } from "@/lib/bastion/server";
import { policyTable, summarise, type DecisionEvent } from "@/lib/bastion/view";
import { errorResponse } from "@/lib/http";

/**
 * GET /api/bastion — Orbis Bastion for the signed-in user: the protections in force, the policy as it applies
 * now, where it's enforced (and where it isn't), and the decisions Bastion made on this user's actions.
 */
export async function GET() {
  try {
    const auth = await requireUser();
    const [controls, admin, { data }] = await Promise.all([
      loadControls(),
      isAdmin(auth),
      auth.supabase.from("security_audit").select("action,detail,created_at").eq("user_id", auth.user.id).like("action", "bastion.%").order("created_at", { ascending: false }).limit(1000),
    ]);
    return NextResponse.json(
      {
        available: !!controls,
        controls: controls
          ? { version: controls.version, updatedAt: controls.updatedAt, lockdown: controls.lockdown, suspendedAgents: controls.suspendedAgents, blockedCapabilities: controls.blockedCapabilities }
          : null,
        policy: policyTable(controls),
        enforcement: ENFORCEMENT_POINTS,
        summary: summarise((data ?? []) as DecisionEvent[]),
        admin,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
