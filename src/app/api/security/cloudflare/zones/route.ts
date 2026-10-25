import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { ConnectorError } from "@/lib/connectors/http";
import { ApiError, errorResponse } from "@/lib/http";
import { listZones } from "@/lib/security/cloudflare-audit";
import { serviceContext, serviceState } from "@/lib/security/connections";

/** GET /api/security/cloudflare/zones — the connection's state and the zones its token can read. */
export async function GET(req: Request) {
  try {
    const auth = await requireUser();
    const connection = await serviceState(auth, "cloudflare");
    const s = await serviceContext(auth, "cloudflare", req.signal);
    if (!s) return NextResponse.json({ connection, zones: [] });
    const zones = await listZones(s.ctx).catch((err) => {
      throw err instanceof ConnectorError ? new ApiError(err.kind === "auth" || err.kind === "permission" ? "forbidden" : "upstream_error", err.message) : err;
    });
    return NextResponse.json({ connection, zones: zones.map((z) => ({ id: z.id, name: z.name, status: z.paused ? "paused" : z.status, plan: z.plan })) });
  } catch (err) {
    return errorResponse(err);
  }
}
