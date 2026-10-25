import { requireUser } from "@/lib/auth";
import { errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { checkRunLimit, runDeploymentAudit } from "@/lib/security/runners";
import { deploymentAuditRequest } from "@/lib/security/schema";
import { assertAgentAccess } from "@/lib/agent-platform/server";
import { enforce } from "@/lib/bastion/server";

export const maxDuration = 120;

/**
 * POST /api/security/vercel/audit — audit a Vercel project's deployment security through the person's own Vercel
 * connection (NDJSON progress stream). Read-only: nothing on Vercel is changed, and variable values are never read.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    await assertAgentAccess(auth, "security");
    // The audit makes outbound requests (to Vercel, a preview URL and the production site); administrators can switch those off.
    await enforce({ db: auth.supabase, userId: auth.user.id, kind: "agent", agent: "security" }, "web.search", "deployment audit");
    const body = await parseJsonBody(req, deploymentAuditRequest);
    checkRunLimit(req, auth);
    return ndjsonStream(
      (send, signal) => runDeploymentAudit({ req, auth, send, signal, modelId: body.modelId, parentId: body.parentId }, { project: body.project, teamId: body.teamId ?? null, gate: body.gate, siteChecks: body.siteChecks }).then(() => {}),
      req.signal,
    );
  } catch (err) {
    return errorResponse(err);
  }
}
