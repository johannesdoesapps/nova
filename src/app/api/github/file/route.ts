import { z } from "zod";
import { REPO_RE, repoFile, safePath } from "@/lib/github/app";
import { requireRepoAccess } from "@/lib/github/server";
import { errorResponse, parseQuery } from "@/lib/http";

const query = z.object({ repo: z.string().regex(REPO_RE), path: z.string().refine(safePath, "Invalid path") });

/** GET /api/github/file?repo=owner/name&path=src/index.ts — one text file, to add to a message. */
export async function GET(req: Request) {
  try {
    const { repo, path } = parseQuery(req.url, query);
    return Response.json(await repoFile(await requireRepoAccess(), repo, path));
  } catch (err) {
    return errorResponse(err);
  }
}
