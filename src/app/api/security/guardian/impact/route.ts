import { NextResponse } from "next/server";
import { z } from "zod";
import { assertAgentAccess } from "@/lib/agent-platform/server";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/db/security";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { githubReadToken } from "@/lib/security/connections";
import { fetchRepoFiles } from "@/lib/security/github";
import { buildGraph } from "@/lib/security/guardian/graph";
import { analyseImpact } from "@/lib/security/guardian/impact";
import { buildProfile } from "@/lib/security/guardian/profile";
import { checkRunLimit } from "@/lib/security/runners";

export const maxDuration = 60;

const body = z.object({ repo: z.string().trim().min(3).max(300), files: z.array(z.string().trim().min(1).max(300)).min(1).max(20) });

/**
 * POST /api/security/guardian/impact — change-impact analysis for files in a GitHub repository: what imports them
 * (directly or through other files), which entry points and tests reach them, the risk and why, a test plan from
 * the smallest relevant tests upward, and a rollback approach for risky changes. Reads a fresh snapshot; changes
 * nothing. Uploaded code isn't kept, so only repositories can be analysed here.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    await assertAgentAccess(auth, "security");
    const input = await parseJsonBody(req, body, 20_000);
    checkRunLimit(req, auth);
    const repo = await fetchRepoFiles(input.repo.replace(/^github:/, ""), { token: (await githubReadToken(auth, req.signal)).token, signal: req.signal }).catch((e: Error) => {
      throw new ApiError("bad_request", e.message);
    });
    const have = new Set(repo.files.map((f) => f.path));
    const files = input.files.map((f) => f.replace(/^\.?\//, ""));
    const unknown = files.filter((f) => !have.has(f));
    if (unknown.length === files.length) throw new ApiError("bad_request", `None of these files are in ${repo.label} at ${repo.ref}: ${unknown.slice(0, 5).join(", ")}.`);
    const graph = buildGraph(repo.files);
    const report = analyseImpact(graph, files, buildProfile(repo.files));
    await audit(auth.supabase, auth.user.id, "impact.analysed", { detail: { repo: repo.label, ref: repo.ref, files: files.slice(0, 10), risk: report.risk } });
    return NextResponse.json({ repo: repo.label, ref: repo.ref, truncated: repo.truncated, unknown, report });
  } catch (err) {
    return errorResponse(err);
  }
}
