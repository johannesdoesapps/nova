import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth";
import { publicEnv } from "@/lib/env";
import { ConnectorError } from "@/lib/connectors/http";
import { checkCallback, exchangeCode, grantedScopes, STATE_COOKIE } from "@/lib/connectors/oauth";
import { connector } from "@/lib/connectors/registry";
import { saveConnection } from "@/lib/connectors/runtime";
import { reportError } from "@/lib/observability";

/**
 * GET /api/connectors/callback — where every service sends the user back
 * after they allow (or refuse) access. Checks the signed state cookie (same
 * request, same user, not expired), exchanges the code for tokens on the
 * server, records who connected and which permissions were actually granted,
 * and stores the tokens sealed. Nothing is marked connected unless all of
 * that worked.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const jar = await cookies();
  const raw = jar.get(STATE_COOKIE)?.value;
  const done = (params: Record<string, string>) => {
    const res = NextResponse.redirect(new URL(`/connectors?${new URLSearchParams(params)}`, req.url), 303);
    res.cookies.set(STATE_COOKIE, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/api/connectors", maxAge: 0 });
    return res;
  };

  const auth = await getAuth();
  if (auth.mode !== "authenticated") return done({ error: "Please sign in, then connect again." });
  const check = checkCallback(raw, url.searchParams.get("state"), auth.user.id);
  if (!check.ok) return done({ error: check.reason });
  const c = connector(check.payload.c);
  if (!c?.oauth) return done({ error: "There's no such connector." });

  const providerError = url.searchParams.get("error");
  if (providerError) {
    return done({ connector: c.meta.id, error: providerError === "access_denied" ? `You didn't allow access, so ${c.meta.name} wasn't connected.` : `${c.meta.name} didn't complete the sign-in, so it wasn't connected.` });
  }
  const code = url.searchParams.get("code");
  if (!code || code.length > 2000) return done({ connector: c.meta.id, error: `${c.meta.name} didn't send a sign-in code. Please try again.` });

  try {
    const tokens = await exchangeCode(c, code, check.payload.v, publicEnv.siteUrl);
    const who = c.account ? await c.account({ token: tokens.accessToken, extra: tokens.extra, fetch }, tokens) : { label: c.meta.name };
    tokens.extra = { ...tokens.extra, ...who.extra };
    const requested = [...c.meta.readScopes, ...(check.payload.w ? c.meta.writeScopes : [])].map((p) => p.scope);
    // Use what the service says it granted (people can untick permissions); fall back to what was asked for.
    const granted = grantedScopes(requested, tokens.scopes);
    const writeEnabled = check.payload.w && c.meta.writeScopes.some((p) => granted.includes(p.scope));
    await saveConnection(auth, c, { label: who.label, scopes: granted, writeEnabled, tokens });
    return done({ connected: c.meta.id });
  } catch (err) {
    if (!(err instanceof ConnectorError)) reportError(err, { where: "connectors.callback", connector: c.meta.id });
    return done({ connector: c.meta.id, error: err instanceof ConnectorError ? err.message : `${c.meta.name} couldn't be connected. Please try again.` });
  }
}
