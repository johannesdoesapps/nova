import { NextResponse } from "next/server";
import { ConnectorError } from "@/lib/connectors/http";
import { accessToken, getConnection, noteFailure, toView, updateConnection } from "@/lib/connectors/runtime";
import { available, connectorOr404, connectorUser } from "@/lib/connectors/server";
import { ApiError, errorResponse } from "@/lib/http";
import { reportError } from "@/lib/observability";

/** POST /api/connectors/[id]/check — test the connection with a cheap call to the service and record the result. */
export async function POST(_req: Request, ctx: RouteContext<"/api/connectors/[id]/check">) {
  try {
    const c = connectorOr404((await ctx.params).id);
    const auth = await connectorUser("connectors-check", 20);
    const row = await getConnection(auth, c.meta.id);
    if (!row || row.status === "disconnected") throw new ApiError("not_found", `${c.meta.name} isn't connected.`);
    if (!available(c)) throw new ApiError("not_configured", `${c.meta.name} isn't set up on this site any more.`);
    const now = new Date().toISOString();
    try {
      const { token, extra } = await accessToken(auth, c, row);
      await c.health?.({ token, extra, fetch });
      await updateConnection(auth, c.meta.id, { status: "connected", last_error: null, last_checked_at: now });
      return NextResponse.json({ ok: true, connection: toView({ ...row, status: "connected", last_error: null, last_checked_at: now }) });
    } catch (err) {
      await noteFailure(auth, c.meta.id, err);
      if (!(err instanceof ConnectorError)) reportError(err, { where: "connectors.check", connector: c.meta.id });
      const message = err instanceof ConnectorError ? err.message : `${c.meta.name} couldn't be reached.`;
      const status = err instanceof ConnectorError && err.kind === "auth" ? "reauth_required" : "error";
      await updateConnection(auth, c.meta.id, { status, last_error: message.slice(0, 500), last_checked_at: now });
      return NextResponse.json({ ok: false, message, connection: toView({ ...row, status, last_error: message, last_checked_at: now }) });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
