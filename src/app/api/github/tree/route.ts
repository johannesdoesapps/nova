import { z } from "zod";
import { REPO_RE, repoTree } from "@/lib/github/app";
import { requireRepoAccess } from "@/lib/github/server";
import { errorResponse, parseQuery } from "@/lib/http";

const query = z.object({ repo: z.string().regex(REPO_RE) });

/** GET /api/github/tree?repo=owner/name — text files on the default branch (up to 100 KB each). */
export async function GET(req: Request) {
  try {
    const { repo } = parseQuery(req.url, query);
    return Response.json(await repoTree(await requireRepoAccess(), repo));
  } catch (err) {
    return errorResponse(err);
  }
}
