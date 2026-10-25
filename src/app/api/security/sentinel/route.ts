import { requireUser } from "@/lib/auth";
import { errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { checkRunLimit, runSentinelAgent } from "@/lib/security/runners";
import { sentinelRequest } from "@/lib/security/schema";
import { assertAgentAccess } from "@/lib/agent-platform/server";
import { enforce } from "@/lib/bastion/server";

// An audit maps the site (crawl capped at 45 s by its budget) before the AI report, so allow up to two minutes.
export const maxDuration = 120;

/** POST /api/security/sentinel — scan a verified website (NDJSON progress stream). */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    await assertAgentAccess(auth, "security");
    // Orbis Bastion: scans make outbound requests (to the user's verified site); an administrator can switch those off.
    await enforce({ db: auth.supabase, userId: auth.user.id, kind: "agent", agent: "security" }, "web.search", "security scan");
    const body = await parseJsonBody(req, sentinelRequest);
    checkRunLimit(req, auth);
    return ndjsonStream((send, signal) => runSentinelAgent({ req, auth, send, signal, modelId: body.modelId, parentId: body.parentId }, body).then(() => {}), req.signal);
  } catch (err) {
    return errorResponse(err);
  }
}
