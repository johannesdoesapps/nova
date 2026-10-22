import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { planUpdate, type Shas } from "@/lib/code/github-sync";
import { byteLength, projectLimits, validProjectPath } from "@/lib/code/projects";
import { applyFileChanges, codeContext, dbError, getFiles, optionalBox } from "@/lib/code/server";
import { removeFromWorkspace, writeToWorkspace } from "@/lib/code/workspace";
import { gitBlobSha, repoFile, repoTree } from "@/lib/github/app";
import { requireRepoAccess } from "@/lib/github/server";
import { ApiError, errorResponse, requireUuid } from "@/lib/http";
import { reportError } from "@/lib/observability";

export const maxDuration = 120;

/** Run a few requests at a time. */
async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

/**
 * POST /api/code/projects/[id]/github-pull — "Update from GitHub": bring the
 * repository's default branch into a project imported from it. Files changed
 * only on GitHub are updated, files changed in Orbis are kept, and files
 * changed in both places are kept and listed (see lib/code/github-sync.ts).
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/code/projects/[id]/github-pull">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("code-pull", 6);
    const { data: row, error } = await auth.supabase.from("code_projects").select("source_repo, source_base").eq("id", id).maybeSingle();
    if (error) throw dbError(error, "code.pull.project");
    if (!row) throw new ApiError("not_found", "Project not found.");
    const repo = (row as { source_repo: string | null }).source_repo;
    if (!repo) throw new ApiError("bad_request", "This project wasn't imported from GitHub, so there's nothing to update from.");
    const token = await requireRepoAccess();
    const tree = await repoTree(token, repo);

    const files = await getFiles(auth, id);
    const local: Shas = Object.fromEntries(files.map((f) => [f.path, gitBlobSha(f.content)]));
    const remote: Shas = Object.fromEntries(tree.files.filter((f) => validProjectPath(f.path)).map((f) => [f.path, f.sha]));
    const plan = planUpdate({ base: (row as { source_base: Shas | null }).source_base, local, remote });

    // New files must still fit the project's limits; the rest are left out and listed.
    const limits = projectLimits(await isAdmin(auth));
    const sizeOf = new Map(tree.files.map((f) => [f.path, f.size]));
    let count = files.length - plan.remove.length;
    let bytes = files.reduce((n, f) => n + (plan.remove.includes(f.path) ? 0 : byteLength(f.content)), 0);
    const take: string[] = [];
    const leftOut: string[] = [];
    for (const p of plan.take) {
      const existing = files.find((f) => f.path === p);
      const grow = (sizeOf.get(p) ?? 0) - (existing ? byteLength(existing.content) : 0);
      if ((!existing && count + 1 > limits.files) || bytes + grow > limits.bytes) {
        leftOut.push(p);
        delete plan.base[p];
        continue;
      }
      take.push(p);
      bytes += grow;
      if (!existing) count++;
    }

    const fetched = await pool(take, 8, (p) => repoFile(token, repo, p).catch(() => null));
    const writes = fetched.filter((f): f is NonNullable<typeof f> => f !== null).map((f) => ({ path: f.path, content: f.content }));
    for (const p of take) if (!writes.some((w) => w.path === p)) delete plan.base[p]; // couldn't be read: try again next time
    await applyFileChanges(auth, id, [...plan.remove.map((p) => ({ path: p, content: null })), ...writes]);
    const { error: baseError } = await auth.supabase.from("code_projects").update({ source_base: plan.base }).eq("id", id);
    if (baseError) throw dbError(baseError, "code.pull.base");

    // A running workspace computer gets the same changes.
    const box = await optionalBox(auth, id).catch(() => null);
    if (box) {
      try {
        await removeFromWorkspace(box, plan.remove);
        await writeToWorkspace(box, writes);
      } catch (err) {
        reportError(err, { where: "code.pull.mirror" });
      }
    }

    return NextResponse.json({
      repo,
      branch: tree.branch,
      updated: writes.filter((w) => files.some((f) => f.path === w.path)).length,
      added: writes.filter((w) => !files.some((f) => f.path === w.path)).length,
      removed: plan.remove.length,
      keptLocal: plan.keptLocal,
      conflicts: plan.conflicts.slice(0, 50),
      leftOut: leftOut.slice(0, 50),
      leftOutCount: leftOut.length,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
