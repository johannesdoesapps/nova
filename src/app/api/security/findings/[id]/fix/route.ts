import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { audit, getFinding } from "@/lib/db/security";
import { codeContext, createProject } from "@/lib/code/server";
import { projectLimits, validProjectPath } from "@/lib/code/projects";
import { ApiError, errorResponse, requireUuid } from "@/lib/http";
import { findingDetails, securityFixTask } from "@/lib/security/details";
import { fetchRepoFiles } from "@/lib/security/github";

export const maxDuration = 60;

/**
 * POST /api/security/findings/[id]/fix — open a Code project with the audited repository's files so the
 * coding agent can fix one Code Guardian finding. Returns the project and the task text; the page starts
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
    const repo = await fetchRepoFiles(finding.asset.slice(7), { token: admin ? (process.env.GITHUB_TOKEN ?? "").trim() || null : null }).catch((e: Error) => {
      throw new ApiError("bad_request", e.message);
    });
    const limits = projectLimits(admin);
    let total = 0;
    const files = repo.files
      .filter((f) => validProjectPath(f.path))
      .filter((f) => (total += f.content.length) <= limits.bytes)
      .slice(0, limits.files);
    const file = finding.location.slice(0, finding.location.lastIndexOf(":")) || finding.location;
    if (!files.some((f) => f.path === file)) throw new ApiError("bad_request", `${file} isn't in the repository snapshot any more (or is over the project size limit).`);
    const project = await createProject(auth, { name: `Security fix: ${finding.title}`.slice(0, 80), template: "blank", runCommand: "", sourceRepo: null, files });
    await audit(auth.supabase, auth.user.id, "fix.project_opened", { findingId: id, detail: { projectId: project.id, repo: repo.label, ref: repo.ref } });
    return NextResponse.json({ projectId: project.id, task: securityFixTask(finding, findingDetails(finding)) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
