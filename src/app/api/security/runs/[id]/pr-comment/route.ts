import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { guard } from "@/lib/bastion/server";
import { ConnectorError, callJson } from "@/lib/connectors/http";
import { audit, getRunRow, listFindings } from "@/lib/db/security";
import { publicEnv } from "@/lib/env";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { requireService } from "@/lib/security/connections";
import { classify, CLASSIFICATION_LABEL } from "@/lib/security/details";
import { prComment } from "@/lib/security/pr";
import type { Severity } from "@/lib/security/types";

const body = z.object({ confirm: z.literal(true) });

/**
 * POST /api/security/runs/[id]/pr-comment — post a pull-request audit's summary on the pull request, as the person,
 * through their GitHub connection. Only when they confirm it, only with write access they granted, once per audit.
 * The comment holds titles, severities and locations — never evidence, code or secrets.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/security/runs/[id]/pr-comment">) {
  try {
    const auth = await requireUser();
    const id = requireUuid((await ctx.params).id);
    await parseJsonBody(req, body, 200);
    const run = await getRunRow(auth.supabase, auth.user.id, id);
    const pr = run.stats.pr as { repo: string; number: number; headSha: string; introduced: number; existing: number; filesTruncated?: boolean; patchesMissing?: number } | undefined;
    if (run.agent !== "code_guardian" || run.action !== "pr_audit" || !pr) throw new ApiError("bad_request", "Only pull-request audits can be posted to a pull request.");
    if (run.status !== "completed") throw new ApiError("bad_request", "The audit hasn't finished, so there's nothing to post yet.");

    // Once per audit: a second click returns the comment already posted.
    const { data: posted } = await auth.supabase.from("security_audit").select("detail").eq("user_id", auth.user.id).eq("run_id", id).eq("action", "pr.comment").limit(1);
    const prior = (posted?.[0]?.detail as { url?: string } | undefined)?.url;
    if (prior) return NextResponse.json({ ok: true, url: prior, already: true });

    const { ctx: gh, row } = await requireService(auth, "github", req.signal);
    if (!row.write_enabled || !row.scopes.some((s) => s === "pull_requests:write" || s === "issues:write"))
      throw new ApiError("forbidden", "Posting needs write access to GitHub. Reconnect GitHub with “Also allow…” ticked (Pull requests: write), then try again.");
    const d = await guard({ db: auth.supabase, userId: auth.user.id, kind: "user", agent: "security" }, "connector.write", `github_pr_comment ${pr.repo}#${pr.number}`, { approved: true });
    if (d.outcome !== "allow") throw new ApiError("forbidden", `Blocked by Orbis Bastion: ${d.reason}`);

    const fs = await listFindings(auth.supabase, auth.user.id, { runId: id, scope: "security" });
    const text = prComment({
      pr,
      findings: fs.map((f) => ({
        title: f.title,
        severity: f.severity as Severity,
        location: f.location,
        classification: CLASSIFICATION_LABEL[classify(f)],
        introduced: (f.evidence ?? []).some((e) => e.detail.startsWith("On a line this pull request adds")),
      })),
      counts: { introduced: pr.introduced, existing: pr.existing },
      limitations: [
        "code wasn't run (static analysis only)",
        ...(pr.filesTruncated ? ["changed files beyond GitHub's first 300"] : []),
        ...(pr.patchesMissing ? [`${pr.patchesMissing} file(s) whose diff GitHub didn't provide (introduced vs existing not distinguished)`] : []),
      ],
      runUrl: `${publicEnv.siteUrl.replace(/\/$/, "")}/agents/security/runs/${id}`,
    });
    let url: string;
    try {
      const r = await callJson<{ html_url: string }>(`https://api.github.com/repos/${pr.repo}/issues/${pr.number}/comments`, {
        method: "POST",
        token: gh.token,
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
        json: { body: text },
        service: "GitHub",
        retries: 0,
        signal: req.signal,
      });
      url = r.html_url;
    } catch (err) {
      await audit(auth.supabase, auth.user.id, "pr.comment_failed", { runId: id, detail: { repo: pr.repo, number: pr.number, error: err instanceof ConnectorError ? err.message : "failed" } });
      throw err instanceof ConnectorError ? new ApiError(err.kind === "auth" ? "forbidden" : "upstream_error", err.message) : err;
    }
    await audit(auth.supabase, auth.user.id, "pr.comment", { runId: id, detail: { repo: pr.repo, number: pr.number, url, findings: fs.length } });
    return NextResponse.json({ ok: true, url });
  } catch (err) {
    return errorResponse(err);
  }
}
