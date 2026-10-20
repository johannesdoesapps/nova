import { listRepos } from "@/lib/github/app";
import { requireRepoAccess } from "@/lib/github/server";
import { errorResponse } from "@/lib/http";

/** GET /api/github/repos — repositories the user let NOVA read. */
export async function GET() {
  try {
    return Response.json({ repos: await listRepos(await requireRepoAccess()) });
  } catch (err) {
    return errorResponse(err);
  }
}
