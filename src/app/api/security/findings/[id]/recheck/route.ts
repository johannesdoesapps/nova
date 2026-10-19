import { requireUser } from "@/lib/auth";
import { getFinding, listTargets } from "@/lib/db/security";
import { ApiError, errorResponse, ndjsonStream, requireUuid } from "@/lib/http";
import { checkRunLimit, runGuardianAgent, runSentinelAgent } from "@/lib/security/runners";

export const maxDuration = 60;

/**
 * POST /api/security/findings/[id]/recheck — re-run the tool that produced a
 * finding against the same asset and update its verification from the
 * actual result. Only possible where the asset can be re-fetched.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/security/findings/[id]/recheck">) {
  try {
    const auth = await requireUser();
    const id = requireUuid((await ctx.params).id);
    const { finding } = await getFinding(auth.supabase, auth.user.id, id);
    if (finding.agent === "sentinel") {
      const target = (await listTargets(auth.supabase, auth.user.id)).find((t) => t.hostname === finding.asset);
      if (!target) throw new ApiError("bad_request", `${finding.asset} is no longer in your targets. Add and verify it to re-check.`);
      checkRunLimit(req, auth);
      const scope = finding.rule_id.startsWith("exposure.") ? "active" : "passive";
      return ndjsonStream((send, signal) => runSentinelAgent({ req, auth, send, signal }, { targetId: target.id, scope }).then(() => {}), req.signal);
    }
    if (finding.agent === "code_guardian" && finding.asset.startsWith("github:")) {
      checkRunLimit(req, auth);
      return ndjsonStream(
        (send, signal) => runGuardianAgent({ req, auth, send, signal }, { source: { type: "github", repo: finding.asset.slice(7) }, asset: "", aiReview: false, proposeFixes: false }).then(() => {}),
        req.signal,
      );
    }
    throw new ApiError(
      "bad_request",
      finding.agent === "code_guardian"
        ? "This finding came from uploaded files. Run Audit code again with the updated files under the same project name to re-check it."
        : "Log findings can't be re-checked automatically. Investigate newer logs to see whether the activity continues.",
    );
  } catch (err) {
    return errorResponse(err);
  }
}
