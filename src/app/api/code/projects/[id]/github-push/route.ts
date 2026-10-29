import { NextResponse } from "next/server";
import { z } from "zod";
import { pushProject } from "@/lib/code/github-push";
import { codeContext } from "@/lib/code/server";
import { REPO_RE } from "@/lib/github/app";
import { BRANCH_RE } from "@/lib/github/push";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

export const maxDuration = 60;

const body = z.object({
  repo: z.string().regex(REPO_RE, "Choose a repository."),
  branch: z.string().regex(BRANCH_RE, "Use a branch name like orbis/my-change."),
  message: z.string().trim().min(1).max(500),
  /** The user confirmed in the dialog. */
  confirm: z.literal(true),
  /** Push files that were also changed on GitHub anyway (the user saw the list and agreed). */
  overwrite: z.boolean().optional(),
  /** Also open a pull request from the new branch into the default branch (confirmed in the same dialog). */
  pullRequest: z.object({ title: z.string().trim().min(1).max(250), body: z.string().max(20_000).default(""), draft: z.boolean().optional() }).optional(),
});

/**
 * POST /api/code/projects/[id]/github-push — push the project to a new branch of one of the user's repositories
 * (one commit on the default branch), and optionally open a pull request. See src/lib/code/github-push.ts.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/code/projects/[id]/github-push">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("code-push", 5);
    // Room for a pull request description of up to 20,000 characters (up to 4 bytes each, JSON-escaped).
    const input = await parseJsonBody(req, body, 90_000);
    return NextResponse.json(await pushProject(auth, id, input));
  } catch (err) {
    return errorResponse(err);
  }
}
