import { NextResponse } from "next/server";
import { z } from "zod";
import { ConnectorError } from "@/lib/connectors/http";
import { missingSetup } from "@/lib/connectors/oauth";
import { CF_TOKEN_RE } from "@/lib/connectors/providers/cloudflare";
import { saveConnection } from "@/lib/connectors/runtime";
import { connectorOr404, connectorUser } from "@/lib/connectors/server";
import { audit } from "@/lib/db/security";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";

const body = z.object({ token: z.string().trim().min(20).max(300), write: z.boolean().default(false) });

/**
 * POST /api/connectors/[id]/token — connect a service that uses an API token the person created on the service
 * (Cloudflare). The token is checked with the service first, then stored sealed; it is never returned, logged or
 * passed to an AI model. Write permission is off unless the person ticks it, and every change still needs approval.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/connectors/[id]/token">) {
  try {
    const c = connectorOr404((await ctx.params).id);
    const auth = await connectorUser("connectors-token", 10);
    if (c.meta.auth !== "api_token") throw new ApiError("bad_request", `${c.meta.name} connects through its own sign-in.`);
    if (missingSetup(c).length) throw new ApiError("not_configured", `${c.meta.name} isn't set up on this site yet.`);
    const input = await parseJsonBody(req, body, 2_000);
    if (c.meta.id === "cloudflare" && !CF_TOKEN_RE.test(input.token)) throw new ApiError("bad_request", "That doesn't look like a Cloudflare API token (it's the long value shown once after you create the token, not the token's name or ID, and not a Global API Key).");
    let label: string;
    try {
      label = (await c.account!({ token: input.token, fetch, signal: req.signal }, { accessToken: input.token })).label;
    } catch (err) {
      throw err instanceof ConnectorError ? new ApiError("bad_request", err.message) : err;
    }
    const scopes = [...c.meta.readScopes, ...(input.write ? c.meta.writeScopes : [])].map((s) => s.scope);
    await saveConnection(auth, c, { label, scopes, writeEnabled: input.write, tokens: { accessToken: input.token } });
    await audit(auth.supabase, auth.user.id, "connector.connected", { detail: { connector: c.meta.id, write: input.write, label } });
    return NextResponse.json({ ok: true, label });
  } catch (err) {
    return errorResponse(err);
  }
}
