import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { listSiteScans } from "@/lib/db/security";
import { errorResponse, ndjsonStream, parseJsonBody, parseQuery } from "@/lib/http";
import { checkRunLimit, runWebsiteScan } from "@/lib/security/runners";
import { siteScanRequest } from "@/lib/security/schema";
import { assertAgentAccess } from "@/lib/agent-platform/server";
import { enforce } from "@/lib/bastion/server";

// TLS probing (up to ~90 short handshakes within a 50 s budget) plus HTTP and DNS checks.
export const maxDuration = 120;

/** POST /api/security/sitescan — SSL/TLS and website security scan of a verified target (NDJSON progress stream). */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    await assertAgentAccess(auth, "security");
    // Orbis Bastion: scans make outbound connections (to the user's verified site); an administrator can switch those off.
    await enforce({ db: auth.supabase, userId: auth.user.id, kind: "agent", agent: "security" }, "web.search", "website security scan");
    const body = await parseJsonBody(req, siteScanRequest);
    checkRunLimit(req, auth);
    return ndjsonStream((send, signal) => runWebsiteScan({ req, auth, send, signal }, body).then(() => {}), req.signal);
  } catch (err) {
    return errorResponse(err);
  }
}

const historyQuery = z.object({ host: z.string().trim().max(253).optional(), limit: z.coerce.number().int().min(1).max(100).default(40) });

/** GET /api/security/sitescan — scan history (newest first; overview only). */
export async function GET(req: Request) {
  try {
    const auth = await requireUser();
    const q = parseQuery(req.url, historyQuery);
    const runs = await listSiteScans(auth.supabase, auth.user.id, { host: q.host?.toLowerCase(), limit: q.limit });
    return NextResponse.json({
      scans: runs.map((r) => ({ id: r.id, host: r.asset, scope: r.scope, status: r.status, error: r.error, startedAt: r.started_at, finishedAt: r.finished_at, overview: r.stats.overview ?? null })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
