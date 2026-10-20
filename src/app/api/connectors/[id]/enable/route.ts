import { NextResponse } from "next/server";
import { connectorOr404, connectorUser } from "@/lib/connectors/server";
import { saveConnection } from "@/lib/connectors/runtime";
import { githubContext } from "@/lib/github/server";
import { ApiError, errorResponse } from "@/lib/http";

/**
 * POST /api/connectors/[id]/enable — turn on a connector that doesn't use
 * OAuth: public-data ones (no account), and GitHub once the user has linked
 * their GitHub account and installed Orbis's GitHub App (checked here with
 * GitHub, never taken from the browser).
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/connectors/[id]/enable">) {
  try {
    const c = connectorOr404((await ctx.params).id);
    const auth = await connectorUser();
    if (c.meta.auth === "none") {
      await saveConnection(auth, c, { label: "Public data (no account)", scopes: [], writeEnabled: false, tokens: null });
      return NextResponse.json({ ok: true });
    }
    if (c.meta.auth === "github_app") {
      const gh = await githubContext();
      if (!gh.cfg) throw new ApiError("not_configured", "GitHub isn't set up on this site yet.");
      if (!gh.identity) throw new ApiError("forbidden", "Connect your GitHub account first.", { step: "link" });
      if (!gh.installation) throw new ApiError("forbidden", "Choose which repositories Orbis may read first.", { step: "install" });
      await saveConnection(auth, c, { label: `@${gh.identity.login}`, scopes: c.meta.readScopes.map((p) => p.scope), writeEnabled: false, tokens: null });
      return NextResponse.json({ ok: true });
    }
    throw new ApiError("bad_request", `${c.meta.name} connects through its own sign-in.`);
  } catch (err) {
    return errorResponse(err);
  }
}
