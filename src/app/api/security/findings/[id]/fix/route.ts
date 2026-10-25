import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { audit, getFinding } from "@/lib/db/security";
import { codeContext, createProject } from "@/lib/code/server";
import { byteLength, MAX_FILE_BYTES, projectLimits, validProjectPath } from "@/lib/code/projects";
import { ApiError, errorResponse, requireUuid } from "@/lib/http";
import { findingDetails, securityFixTask } from "@/lib/security/details";
import { githubReadToken } from "@/lib/security/connections";
import { fetchRepoFiles } from "@/lib/security/github";
import { engineeringKind, isEngineering } from "@/lib/security/guardian/categories";
import { buildGraph } from "@/lib/security/guardian/graph";
import { analyseImpact } from "@/lib/security/guardian/impact";
import { buildProfile } from "@/lib/security/guardian/profile";
import { repairTask } from "@/lib/security/guardian/repair";

export const maxDuration = 60;

/**
 * POST /api/security/findings/[id]/fix — open a Code project with the audited repository's files so the
 * coding agent can fix one Code Guardian finding (security, or an engineering finding with its root-cause
 * workflow and change-impact report). Returns the project and the task text; the page starts
 * the agent with plan approval and edit review on, so nothing changes without the user's approval, and
 * nothing is pushed to GitHub or deployed. Uploaded code isn't kept by Orbis, so only repository audits
 * can be fixed this way.
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/security/findings/[id]/fix">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("security-fix", 10);
    const { finding } = await getFinding(auth.supabase, auth.user.id, id);
    if (finding.agent !== "code_guardian" || !finding.location) throw new ApiError("bad_request", "Only code findings with a file location can be fixed by the coding agent.");
    if (!finding.asset.startsWith("github:"))
      throw new ApiError("bad_request", "This finding came from uploaded files, which Orbis doesn't keep. Open the code in Orbis Code (or audit it from GitHub) to fix it with the coding agent.");
    const admin = await isAdmin(auth);
    const repo = await fetchRepoFiles(finding.asset.slice(7), { token: (await githubReadToken(auth)).token }).catch((e: Error) => {
      throw new ApiError("bad_request", e.message);
    });
    const limits = projectLimits(admin);
    const file = /:\d+$/.test(finding.location) ? finding.location.slice(0, finding.location.lastIndexOf(":")) : finding.location;
    const tooBig = repo.files.find((f) => f.path === file && byteLength(f.content) > MAX_FILE_BYTES);
    if (tooBig)
      throw new ApiError(
        "bad_request",
        `${file} is larger than the 200 KB per-file limit for Code projects, so the coding agent can't edit it here. ${engineeringKind(finding.rule_id) === "dependency" ? "Run npm install on a clean checkout, review the lockfile diff and run the tests, then commit package.json and the lockfile together." : "Fix it in your editor; the finding's page lists the steps."}`,
      );
    let total = 0;
    const files = repo.files
      .filter((f) => validProjectPath(f.path) && byteLength(f.content) <= MAX_FILE_BYTES)
      .filter((f) => (total += f.content.length) <= limits.bytes)
      .slice(0, limits.files);
    if (!files.some((f) => f.path === file)) throw new ApiError("bad_request", `${file} isn't in the repository snapshot any more (or is over the project size limit).`);
    const engineering = isEngineering(finding.rule_id);
    let task: string;
    if (engineering) {
      // Impact from the same snapshot the agent will work on.
      const graph = buildGraph(repo.files);
      const impact = analyseImpact(graph, [file], buildProfile(repo.files));
      task = repairTask(finding, impact);
    } else task = securityFixTask(finding, findingDetails(finding));
    const project = await createProject(auth, { name: `${engineering ? "Repair" : "Security fix"}: ${finding.title}`.slice(0, 80), template: "blank", runCommand: "", sourceRepo: null, files });
    await audit(auth.supabase, auth.user.id, "fix.project_opened", { findingId: id, detail: { projectId: project.id, repo: repo.label, ref: repo.ref, kind: engineering ? "repair" : "security" } });
    return NextResponse.json({ projectId: project.id, task }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
