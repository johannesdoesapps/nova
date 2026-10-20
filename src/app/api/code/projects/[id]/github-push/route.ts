import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext, getFiles, getProjectRow } from "@/lib/code/server";
import { REPO_RE } from "@/lib/github/app";
import { BRANCH_RE, pushBranch } from "@/lib/github/push";
import { requireRepoAccess } from "@/lib/github/server";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { reportError } from "@/lib/observability";

export const maxDuration = 60;

const body = z.object({
  repo: z.string().regex(REPO_RE, "Choose a repository."),
  branch: z.string().regex(BRANCH_RE, "Use a branch name like orbis/my-change."),
  message: z.string().trim().min(1).max(500),
  /** The user confirmed in the dialog. */
  confirm: z.literal(true),
});

/**
 * POST /api/code/projects/[id]/github-push — push the project to a new branch
 * of one of the user's repositories (one commit on the default branch). Files
 * the agent deleted are removed on the branch; nothing else is.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/code/projects/[id]/github-push">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const input = await parseJsonBody(req, body, 4_000);
    const auth = await codeContext("code-push", 5);
    await getProjectRow(auth, id);
    const files = await getFiles(auth, id);
    if (!files.length) throw new ApiError("bad_request", "The project has no files to push.");
    // Files an agent run deleted (and that weren't put back since).
    const { data: runs } = await auth.supabase.from("code_agent_runs").select("id").eq("project_id", id).limit(500);
    const runIds = ((runs ?? []) as { id: string }[]).map((r) => r.id);
    const { data: gone } = runIds.length
      ? await auth.supabase.from("code_agent_changes").select("path").in("run_id", runIds).is("after", null).is("reverted_at", null).limit(1000)
      : { data: [] };
    const present = new Set(files.map((f) => f.path));
    const deleted = [...new Set(((gone ?? []) as { path: string }[]).map((g) => g.path))].filter((p) => !present.has(p));
    const token = await requireRepoAccess();
    let result;
    let status: "done" | "failed" = "failed";
    try {
      result = await pushBranch(token, { repo: input.repo, branch: input.branch, message: input.message, files, deleted });
      status = "done";
    } finally {
      const { error } = await auth.supabase.from("connector_actions").insert({ connector_id: "github", action: "push_branch", status, summary: `${input.repo} → ${input.branch}`.slice(0, 500) });
      if (error) reportError(error, { where: "code.push.log" });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return errorResponse(err);
  }
}
