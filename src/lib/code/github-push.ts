import "server-only";
import { hardSecrets, isSecretPath } from "@/lib/bastion/guards";
import { enforce } from "@/lib/bastion/server";
import { gitBlobSha, repoTree } from "@/lib/github/app";
import { openPullRequest, pushBranch, type PushResult } from "@/lib/github/push";
import { githubContext, requireRepoAccess } from "@/lib/github/server";
import { ApiError } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { changedSinceBase, pushConflicts, type Shas } from "./github-sync";
import { dbError, getFiles, type Authed } from "./server";

/**
 * Pushing a Code project to a new branch of one of the user's GitHub repositories (one commit), optionally with a
 * pull request: shared by the Push to GitHub dialog and the coding agent's github_push tool (which only runs after
 * the user approved that exact push). Files the agent deleted are removed on the branch; nothing else is. Pushing
 * to the repository the project was imported from sends only what changed in Orbis since its last import or update,
 * and stops (unless told to overwrite) when GitHub changed any of the same files, so a push never undoes work done
 * there. Files holding credentials are never pushed, whoever asks.
 */

export interface PushInput {
  repo: string;
  branch: string;
  message: string;
  overwrite?: boolean;
  pullRequest?: { title: string; body: string; draft?: boolean };
}

export interface PushOutcome extends PushResult {
  ok: true;
  withheld: string[];
  pullRequest: { number: number; url: string } | null;
  pullRequestError: string | null;
}

/** Who asked: the user in the dialog, or an agent whose push the user approved. */
export type PushActor = { kind: "user" } | { kind: "agent"; agent: string; runId: string };

/** Whether this user can push now (GitHub set up, account linked, repositories chosen). Never throws. */
export async function canPush(): Promise<boolean> {
  try {
    const c = await githubContext();
    return !!(c.cfg && c.identity && c.installation);
  } catch {
    return false;
  }
}

export async function pushProject(auth: Authed, projectId: string, input: PushInput, actor: PushActor = { kind: "user" }): Promise<PushOutcome> {
  const { data: row, error: rowError } = await auth.supabase.from("code_projects").select("source_repo, source_base").eq("id", projectId).maybeSingle();
  if (rowError) throw dbError(rowError, "code.push.project");
  if (!row) throw new ApiError("not_found", "Project not found.");
  let files = await getFiles(auth, projectId);
  if (!files.length) throw new ApiError("bad_request", "The project has no files to push.");
  // Files an agent run deleted (and that weren't put back since).
  const { data: runs } = await auth.supabase.from("code_agent_runs").select("id").eq("project_id", projectId).limit(500);
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
  // Orbis Bastion: pushing is high risk and needs the user's confirmation of this push (the dialog, or their approval
  // of the agent's request).
  await enforce(
    actor.kind === "user" ? { db: auth.supabase, userId: auth.user.id, kind: "user", agent: "github_push" } : { db: auth.supabase, userId: auth.user.id, kind: "agent", agent: actor.agent, runId: actor.runId },
    "github.push",
    `${input.repo} → ${input.branch}`,
    { approved: true },
  );
  const withheld = files.filter((f) => isSecretPath(f.path) || hardSecrets(f.content).length > 0).map((f) => f.path);
  files = files.filter((f) => !withheld.includes(f.path));
  if (!files.length && !deleted.length) throw new ApiError("bad_request", "Every changed file holds credentials, so there's nothing Orbis will push.");
  let result: PushResult | undefined;
  let status: "done" | "failed" = "failed";
  try {
    result = await pushBranch(token, { repo: input.repo, branch: input.branch, message: input.message, files, deleted });
    status = "done";
  } finally {
    const { error } = await auth.supabase.from("connector_actions").insert({ connector_id: "github", action: "push_branch", status, summary: `${input.repo} → ${input.branch}`.slice(0, 500) });
    if (error) reportError(error, { where: "code.push.log" });
  }
  // The pull request is asked for in the same confirmation; if GitHub refuses it, the push still stands.
  let pullRequest: { number: number; url: string } | null = null;
  let pullRequestError: string | null = null;
  if (input.pullRequest && result) {
    let prStatus: "done" | "failed" = "failed";
    try {
      pullRequest = await openPullRequest(token, { repo: input.repo, head: input.branch, base: result.base, ...input.pullRequest });
      prStatus = "done";
    } catch (err) {
      pullRequestError = err instanceof ApiError ? err.message : "GitHub didn't open the pull request.";
    } finally {
      const { error } = await auth.supabase.from("connector_actions").insert({ connector_id: "github", action: "open_pull_request", status: prStatus, summary: `${input.repo}: ${input.branch} → ${result.base}`.slice(0, 500) });
      if (error) reportError(error, { where: "code.push.pr.log" });
    }
  }
  return { ok: true, ...result!, withheld, pullRequest, pullRequestError };
}
