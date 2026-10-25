import { requireUser } from "@/lib/auth";
import { getFinding, listTargets } from "@/lib/db/security";
import { ApiError, errorResponse, ndjsonStream, requireUuid } from "@/lib/http";
import { PR_ASSET_RE } from "@/lib/security/pr";
import { checkRunLimit, runCloudflareAudit, runDeploymentAudit, runGuardianAgent, runSentinelAgent } from "@/lib/security/runners";

// An audit maps the site (crawl capped at 45 s by its budget) before the AI report, so allow up to two minutes.
export const maxDuration = 120;

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
    // Application Protection findings are re-checked by reading the same configuration again.
    if (finding.agent === "sentinel" && (finding.asset.startsWith("cloudflare:") || finding.asset.startsWith("cloudflare-account:"))) {
      checkRunLimit(req, auth);
      const zone = finding.asset.startsWith("cloudflare:") ? finding.asset.slice("cloudflare:".length) : null;
      return ndjsonStream((send, signal) => runCloudflareAudit({ req, auth, send, signal }, { zone }).then(() => {}), req.signal);
    }
    const vercel = /^vercel:(personal|team_[A-Za-z0-9]+)\/([A-Za-z0-9._-]+)$/.exec(finding.asset);
    if (finding.agent === "sentinel" && vercel) {
      checkRunLimit(req, auth);
      return ndjsonStream((send, signal) => runDeploymentAudit({ req, auth, send, signal }, { project: vercel[2]!, teamId: vercel[1] === "personal" ? null : vercel[1]!, siteChecks: false }).then(() => {}), req.signal);
    }
    if (finding.agent === "sentinel") {
      const target = (await listTargets(auth.supabase, auth.user.id)).find((t) => t.hostname === finding.asset);
      if (!target) throw new ApiError("bad_request", `${finding.asset} is no longer in your targets. Add and verify it to re-check.`);
      checkRunLimit(req, auth);
      const scope = /^(exposure\.|surface\.api-|surface\.error-)/.test(finding.rule_id) ? "active" : "passive";
      // Findings from the site map need the mapping pass to be seen again; only locations it re-fetches can be cleared.
      const mode = finding.rule_id.startsWith("surface.") ? ("deep" as const) : undefined;
      return ndjsonStream((send, signal) => runSentinelAgent({ req, auth, send, signal }, { targetId: target.id, scope, mode, timeBudget: "short" }).then(() => {}), req.signal);
    }
    if (finding.agent === "code_guardian" && finding.asset.startsWith("github:")) {
      checkRunLimit(req, auth);
      // A pull-request finding is re-checked against the pull request's latest commit, scoped to its changed files.
      const pr = PR_ASSET_RE.exec(finding.asset);
      const source = pr ? { type: "github_pr" as const, repo: pr[1]!, number: Number(pr[2]) } : { type: "github" as const, repo: finding.asset.slice(7) };
      return ndjsonStream(
        (send, signal) => runGuardianAgent({ req, auth, send, signal }, { source, asset: "", aiReview: false, proposeFixes: false }).then(() => {}),
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
