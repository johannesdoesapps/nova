import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { checkRunLimit, runCloudflareAudit } from "@/lib/security/runners";
import { assertAgentAccess } from "@/lib/agent-platform/server";
import { enforce } from "@/lib/bastion/server";

export const maxDuration = 120;

const body = z.object({ zone: z.string().trim().regex(/^[A-Za-z0-9.-]{1,253}$/).nullable().optional(), modelId: z.string().min(1).max(120).optional() });

/** POST /api/security/cloudflare/audit — read-only review of the person's Cloudflare zones (NDJSON progress stream). */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    await assertAgentAccess(auth, "security");
    await enforce({ db: auth.supabase, userId: auth.user.id, kind: "agent", agent: "security" }, "connector.read", "cloudflare review");
    const input = await parseJsonBody(req, body);
    checkRunLimit(req, auth);
    return ndjsonStream((send, signal) => runCloudflareAudit({ req, auth, send, signal, modelId: input.modelId }, { zone: input.zone ?? null }).then(() => {}), req.signal);
  } catch (err) {
    return errorResponse(err);
  }
}
