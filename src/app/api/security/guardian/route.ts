import { requireUser } from "@/lib/auth";
import { errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { checkRunLimit, runGuardianAgent } from "@/lib/security/runners";
import { guardianRequest } from "@/lib/security/schema";
import { assertAgentAccess } from "@/lib/agent-platform/server";

export const maxDuration = 60;

/** POST /api/security/guardian — audit uploaded code or a GitHub repository (NDJSON). */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    await assertAgentAccess(auth, "security");
    const body = await parseJsonBody(req, guardianRequest, 3_400_000);
    checkRunLimit(req, auth);
    return ndjsonStream((send, signal) => runGuardianAgent({ req, auth, send, signal, modelId: body.modelId, parentId: body.parentId }, body).then(() => {}), req.signal);
  } catch (err) {
    return errorResponse(err);
  }
}
