import { requireUser } from "@/lib/auth";
import { errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { checkRunLimit, runHunterAgent } from "@/lib/security/runners";
import { hunterRequest } from "@/lib/security/schema";

export const maxDuration = 60;

/** POST /api/security/hunter — investigate uploaded logs and indicators (NDJSON). */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    const body = await parseJsonBody(req, hunterRequest, 3_200_000);
    checkRunLimit(req, auth);
    return ndjsonStream((send, signal) => runHunterAgent({ req, auth, send, signal, modelId: body.modelId, parentId: body.parentId }, body).then(() => {}), req.signal);
  } catch (err) {
    return errorResponse(err);
  }
}
