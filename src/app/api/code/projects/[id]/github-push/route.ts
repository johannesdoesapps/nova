import { NextResponse } from "next/server";
import { z } from "zod";
import { hardSecrets, isSecretPath } from "@/lib/bastion/guards";
import { enforce } from "@/lib/bastion/server";
import { changedSinceBase, pushConflicts, type Shas } from "@/lib/code/github-sync";
import { codeContext, dbError, getFiles } from "@/lib/code/server";
import { gitBlobSha, REPO_RE, repoTree } from "@/lib/github/app";
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
  /** Push files that were also changed on GitHub anyway (the user saw the list and agreed). */
  overwrite: z.boolean().optional(),
});

/**
 * POST /api/code/projects/[id]/github-push — push the project to a new branch
 * of one of the user's repositories (one commit on the default branch). Files
 * the agent deleted are removed on the branch; nothing else is. Pushing to the
 * repository a project was imported from sends only the files changed in
 * Orbis since its last import or update, and stops (unless told to overwrite)
 * when GitHub changed any of them too, so a push never undoes work done there.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/code/projects/[id]/github-push">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const input = await parseJsonBody(req, body, 4_000);
    const auth = await codeContext("code-push", 5);
    const { data: row, error: rowError } = await auth.supabase.from("code_projects").select("source_repo, source_base").eq("id", id).maybeSingle();
    if (rowError) throw dbError(rowError, "code.push.project");
    if (!row) throw new ApiError("not_found", "Project not found.");
    let files = await getFiles(auth, id);
    if (!files.length) throw new ApiError("bad_request", "The project has no files to push.");
    // Files an agent run deleted (and that weren't put back since).
    const { data: runs } = await auth.supabase.from("code_agent_runs").select("id").eq("project_id", id).limit(500);
    const runIds = ((runs ?? []) as { id: string }[]).map((r) => r.id);
    const { data: gone } = runIds.length
      ? await auth.supabase.from("code_agent_changes").select("path").in("run_id", runIds).is("after", null).is("reverted_at", null).limit(1000)
      : { data: [] };
    const present = new Set(files.map((f) => f.path));
    let deleted = [...new Set(((gone ?? []) as { path: string }[]).map((g) => g.path))].filter((p) => !present.has(p));
    const token = await requireRepoAccess();
    const { source_repo: sourceRepo, source_base: base } = row as { source_repo: string | null; source_base: Shas | null };
    if (base && sourceRepo?.toLowerCase() === input.repo.toLowerCase()) {
      const local: Shas = Object.fromEntries(files.map((f) => [f.path, gitBlobSha(f.content)]));
      const tree = await repoTree(token, input.repo);
      const remote: Shas = Object.fromEntries(tree.files.map((f) => [f.path, f.sha]));
      const both = pushConflicts(base, local, remote);
      if (both.length && !input.overwrite) {
        throw new ApiError("conflict", `Changed on GitHub too since your last update: ${both.slice(0, 8).join(", ")}${both.length > 8 ? ` and ${both.length - 8} more` : ""}. Use Update from GitHub first, or push anyway to replace them on the new branch.`, { files: both.slice(0, 50) });
      }
      // Also remove files deleted in Orbis since the last update, unless GitHub changed them meanwhile.
      const removedHere = Object.keys(base).filter((p) => local[p] === undefined && remote[p] !== undefined && remote[p] === base[p]);
      deleted = [...new Set([...deleted, ...removedHere])];
      const changed = new Set(changedSinceBase(base, local));
      files = files.filter((f) => changed.has(f.path));
      if (!files.length && !deleted.length) throw new ApiError("bad_request", "Nothing has changed in Orbis since the last update from GitHub, so there's nothing to push.");
    }
    // Orbis Bastion: pushing is high risk and needs the user's confirmation of this push (given in the dialog);
    // files that hold credentials are never pushed, whoever asks.
    await enforce({ db: auth.supabase, userId: auth.user.id, kind: "user", agent: "github_push" }, "github.push", `${input.repo} → ${input.branch}`, { approved: input.confirm });
    const withheld = files.filter((f) => isSecretPath(f.path) || hardSecrets(f.content).length > 0).map((f) => f.path);
    files = files.filter((f) => !withheld.includes(f.path));
    if (!files.length && !deleted.length) throw new ApiError("bad_request", "Every changed file holds credentials, so there's nothing Orbis will push.");
    let result;
    let status: "done" | "failed" = "failed";
    try {
      result = await pushBranch(token, { repo: input.repo, branch: input.branch, message: input.message, files, deleted });
      status = "done";
    } finally {
      const { error } = await auth.supabase.from("connector_actions").insert({ connector_id: "github", action: "push_branch", status, summary: `${input.repo} → ${input.branch}`.slice(0, 500) });
      if (error) reportError(error, { where: "code.push.log" });
    }
    return NextResponse.json({ ok: true, ...result, withheld });
  } catch (err) {
    return errorResponse(err);
  }
}
