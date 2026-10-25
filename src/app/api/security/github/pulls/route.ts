import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { callJson, ConnectorError } from "@/lib/connectors/http";
import { requireRepo } from "@/lib/connectors/providers/github";
import { ApiError, errorResponse } from "@/lib/http";
import { requireService } from "@/lib/security/connections";

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/** GET /api/security/github/pulls?repo=owner/name — open pull requests of a repository shared with Orbis. */
export async function GET(req: Request) {
  try {
    const auth = await requireUser();
    const repo = new URL(req.url).searchParams.get("repo") ?? "";
    if (!REPO.test(repo)) throw new ApiError("bad_request", "Use owner/name.");
    const { ctx } = await requireService(auth, "github", req.signal);
    try {
      await requireRepo(ctx, repo);
      const pulls = await callJson<{ number: number; title: string; draft?: boolean; user?: { login?: string }; head: { ref: string; sha: string }; base: { ref: string }; updated_at: string; html_url: string }[]>(
        `https://api.github.com/repos/${repo}/pulls?state=open&per_page=30&sort=updated&direction=desc`,
        { token: ctx.token, headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, service: "GitHub", signal: req.signal },
      );
      return NextResponse.json({
        pulls: pulls.map((p) => ({ number: p.number, title: p.title.slice(0, 200), draft: !!p.draft, author: p.user?.login ?? null, head: p.head.ref.slice(0, 120), headSha: p.head.sha, base: p.base.ref.slice(0, 120), updatedAt: p.updated_at, url: p.html_url })),
      });
    } catch (err) {
      throw err instanceof ConnectorError ? new ApiError(err.kind === "auth" ? "forbidden" : err.kind === "permission" ? "forbidden" : "upstream_error", err.message) : err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}
