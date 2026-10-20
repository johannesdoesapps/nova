import { NextResponse } from "next/server";
import { z } from "zod";
import { MAX_PROJECT_BYTES, MAX_PROJECT_FILES, validProjectPath, type ProjectFile } from "@/lib/code/projects";
import { codeContext, createProject } from "@/lib/code/server";
import { REPO_RE, repoFile, repoTree } from "@/lib/github/app";
import { requireRepoAccess } from "@/lib/github/server";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";

export const maxDuration = 120;

const body = z.object({ repo: z.string().regex(REPO_RE, "Choose a repository."), name: z.string().trim().min(1).max(80).optional() });

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
 * POST /api/code/import — a new project from one of the user's GitHub
 * repositories (default branch; text files only, within the project limits).
 */
export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, body, 2_000);
    const auth = await codeContext("code-import", 5);
    const token = await requireRepoAccess();
    const tree = await repoTree(token, input.repo);
    let total = 0;
    const picked = tree.files.filter((f) => {
      if (!validProjectPath(f.path)) return false;
      if (total + f.size > MAX_PROJECT_BYTES) return false;
      total += f.size;
      return true;
    }).slice(0, MAX_PROJECT_FILES);
    if (!picked.length) throw new ApiError("bad_request", "That repository has no text files Orbis can open.");
    const read = await pool(picked, 8, (f) => repoFile(token, input.repo, f.path).catch(() => null));
    const files: ProjectFile[] = read.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => ({ path: r.path, content: r.content }));
    const left = tree.files.length - files.length;
    const project = await createProject(auth, {
      name: input.name ?? input.repo.split("/")[1]!,
      template: "github",
      runCommand: "",
      sourceRepo: input.repo,
      files,
    });
    return NextResponse.json({ project, imported: files.length, leftOut: left, truncated: tree.truncated }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
