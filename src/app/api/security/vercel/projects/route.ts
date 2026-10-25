import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { callJson, ConnectorError } from "@/lib/connectors/http";
import { scopes } from "@/lib/connectors/providers/vercel";
import { ApiError, errorResponse } from "@/lib/http";
import { serviceContext, serviceState } from "@/lib/security/connections";

/**
 * GET /api/security/vercel/projects — the person's Vercel projects (personal account and teams Orbis is installed
 * on), for choosing what to audit. Read with their own connection; nothing else is listed.
 */
export async function GET(req: Request) {
  try {
    const auth = await requireUser();
    const connection = await serviceState(auth, "vercel");
    const s = await serviceContext(auth, "vercel", req.signal);
    if (!s) return NextResponse.json({ connection, projects: [], refused: [] });
    const projects: { id: string; name: string; teamId: string | null; scope: string; framework: string | null; repo: string | null }[] = [];
    const refused: string[] = [];
    for (const sc of await scopes(s.ctx)) {
      try {
        const r = await callJson<{ projects?: { id: string; name: string; framework?: string | null; link?: { org?: string; repo?: string } }[] }>(
          `https://api.vercel.com/v10/projects?limit=50${sc.teamId ? `&teamId=${encodeURIComponent(sc.teamId)}` : ""}`,
          { token: s.ctx.token, service: "Vercel", signal: req.signal },
        );
        for (const p of r.projects ?? []) projects.push({ id: p.id, name: p.name, teamId: sc.teamId, scope: sc.name, framework: p.framework ?? null, repo: p.link?.org && p.link.repo ? `${p.link.org}/${p.link.repo}` : null });
      } catch (err) {
        if (err instanceof ConnectorError && (err.kind === "permission" || err.kind === "not_found")) refused.push(sc.name);
        else throw err;
      }
    }
    return NextResponse.json({ connection, projects: projects.slice(0, 200), refused });
  } catch (err) {
    return errorResponse(err instanceof ConnectorError ? new ApiError(err.kind === "auth" ? "forbidden" : "upstream_error", err.message) : err);
  }
}
