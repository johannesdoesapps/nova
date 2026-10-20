import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth";
import { publicEnv } from "@/lib/env";
import { ConnectorError } from "@/lib/connectors/http";
import { beginAuthorization, STATE_COOKIE } from "@/lib/connectors/oauth";
import { available, connectorOr404 } from "@/lib/connectors/server";
import { ApiError } from "@/lib/http";

const back = (req: Request, params: Record<string, string>) => NextResponse.redirect(new URL(`/connectors?${new URLSearchParams(params)}`, req.url), 303);

/**
 * GET /api/connectors/[id]/connect?write=1 — start connecting: send the user
 * to the service's own sign-in and consent page (OAuth 2.0). The state and
 * PKCE verifier go in a signed, HTTP-only cookie checked on the way back.
 * `write=1` also asks for the connector's write permissions.
 */
export async function GET(req: Request, ctx: RouteContext<"/api/connectors/[id]/connect">) {
  const { id } = await ctx.params;
  let c;
  try {
    c = connectorOr404(id);
  } catch {
    return back(req, { error: "There's no such connector." });
  }
  const auth = await getAuth();
  if (auth.mode !== "authenticated") return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent("/connectors")}`, req.url), 303);
  if (c.meta.auth !== "oauth2") return back(req, { connector: c.meta.id, error: `${c.meta.name} is connected from the Connectors page.` });
  if (!available(c)) return back(req, { connector: c.meta.id, error: `${c.meta.name} isn't set up on this site yet.` });
  try {
    const write = new URL(req.url).searchParams.get("write") === "1" && c.meta.writeScopes.length > 0;
    const { url, cookie } = beginAuthorization(c, { userId: auth.user.id, write, siteUrl: publicEnv.siteUrl });
    const res = NextResponse.redirect(url, 303);
    res.cookies.set(STATE_COOKIE, cookie, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/connectors", maxAge: 600 });
    return res;
  } catch (err) {
    const msg = err instanceof ConnectorError || err instanceof ApiError ? err.message : "Connecting couldn't start. Please try again.";
    return back(req, { connector: c.meta.id, error: msg });
  }
}
