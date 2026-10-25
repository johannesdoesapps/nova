import { NextResponse } from "next/server";
import { connectorOr404, connectorUser } from "@/lib/connectors/server";
import { saveConnection } from "@/lib/connectors/runtime";
import { ApiError, errorResponse } from "@/lib/http";

/**
 * POST /api/connectors/[id]/enable — turn on a connector that doesn't use
 * OAuth: public-data ones (no account).
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/connectors/[id]/enable">) {
  try {
    const c = connectorOr404((await ctx.params).id);
    const auth = await connectorUser();
    if (c.meta.auth === "none") {
      await saveConnection(auth, c, { label: "Public data (no account)", scopes: [], writeEnabled: false, tokens: null });
      return NextResponse.json({ ok: true });
    }
    throw new ApiError("bad_request", `${c.meta.name} connects through its own sign-in.`);
  } catch (err) {
    return errorResponse(err);
  }
}
