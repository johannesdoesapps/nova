import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { ConnectorError } from "@/lib/connectors/http";
import { accessibleRepos } from "@/lib/connectors/providers/github";
import { ApiError, errorResponse } from "@/lib/http";
import { serviceContext, serviceState } from "@/lib/security/connections";

/**
 * GET /api/security/github/repos — the repositories the person shared with Orbis through their GitHub connection,
 * for choosing what to audit. Nothing else on their GitHub account is listed or reachable.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireUser();
    const state = await serviceState(auth, "github");
    const s = await serviceContext(auth, "github", req.signal);
    if (!s) return NextResponse.json({ connection: state, repos: [] });
    const repos = await accessibleRepos(s.ctx).catch((err) => {
      throw err instanceof ConnectorError ? new ApiError(err.kind === "auth" ? "forbidden" : "upstream_error", err.message) : err;
    });
    return NextResponse.json({ connection: state, repos: repos.slice(0, 200) });
  } catch (err) {
    return errorResponse(err);
  }
}
