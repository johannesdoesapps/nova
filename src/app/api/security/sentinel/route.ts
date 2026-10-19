import { requireUser } from "@/lib/auth";
import { errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { checkRunLimit, runSentinelAgent } from "@/lib/security/runners";
import { sentinelRequest } from "@/lib/security/schema";

export const maxDuration = 60;

/** POST /api/security/sentinel — scan a verified website (NDJSON progress stream). */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    const body = await parseJsonBody(req, sentinelRequest);
    checkRunLimit(req, auth);
    return ndjsonStream((send, signal) => runSentinelAgent({ req, auth, send, signal, modelId: body.modelId, parentId: body.parentId }, body).then(() => {}), req.signal);
  } catch (err) {
    return errorResponse(err);
  }
}
