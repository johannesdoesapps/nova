import { assertAgentAccess } from "@/lib/agent-platform/server";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/db/security";
import { errorResponse } from "@/lib/http";
import { loadAegis } from "@/lib/security/aegis/server";
import { executiveReport, operationalReport, technicalReport } from "@/lib/security/aegis/state";

export const maxDuration = 30;

const KINDS = { executive: executiveReport, technical: technicalReport, operational: operationalReport } as const;

/** GET /api/security/aegis/report?type=executive|technical|operational — a Markdown report from recorded data. */
export async function GET(req: Request) {
  try {
    const auth = await requireUser();
    await assertAgentAccess(auth, "security");
    // Only the three known kinds; the name goes into the download's file name and the audit log.
    const asked = new URL(req.url).searchParams.get("type") ?? "executive";
    const type: keyof typeof KINDS = Object.hasOwn(KINDS, asked) ? (asked as keyof typeof KINDS) : "executive";
    const make = KINDS[type];
    const text = make(await loadAegis(auth.supabase, auth.user.id));
    await audit(auth.supabase, auth.user.id, "aegis.report", { detail: { type } });
    return new Response(text, {
      headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="orbis-aegis-${type}-${new Date().toISOString().slice(0, 10)}.md"` },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
