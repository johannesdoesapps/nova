import { NextResponse } from "next/server";
import { z } from "zod";
import { AI_MODES } from "@/lib/connectors/catalog";
import { oauthClient } from "@/lib/connectors/oauth";
import { REGISTRY } from "@/lib/connectors/registry";
import { forgetConnection, getConnection, listConnections, storedTokens, toView, updateConnection } from "@/lib/connectors/runtime";
import { connectorOr404, connectorUser } from "@/lib/connectors/server";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { reportError } from "@/lib/observability";

type Ctx = RouteContext<"/api/connectors/[id]">;

const patch = z.object({
  aiMode: z.enum(AI_MODES.map((m) => m.id) as ["auto", "mention", "off"]).optional(),
  /** Only turning write access off is possible here; turning it on means reconnecting with the write permissions. */
  writeEnabled: z.literal(false).optional(),
});

/** PATCH /api/connectors/[id] — how the AI may use the connection, or switch write access off. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const c = connectorOr404((await ctx.params).id);
    const body = await parseJsonBody(req, patch, 1_000);
    const auth = await connectorUser();
    const row = await getConnection(auth, c.meta.id);
    if (!row || row.status === "disconnected") throw new ApiError("not_found", `${c.meta.name} isn't connected.`);
    await updateConnection(auth, c.meta.id, { ...(body.aiMode ? { ai_mode: body.aiMode } : {}), ...(body.writeEnabled === false ? { write_enabled: false } : {}) });
    return NextResponse.json({ connection: toView({ ...row, ai_mode: body.aiMode ?? row.ai_mode, write_enabled: body.writeEnabled === false ? false : row.write_enabled }) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/connectors/[id] — disconnect: revoke Orbis's access at the
 * service where it supports that, and delete the stored tokens.
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const c = connectorOr404((await ctx.params).id);
    const auth = await connectorUser();
    const row = await getConnection(auth, c.meta.id);
    if (!row || row.status === "disconnected") return NextResponse.json({ ok: true, revoked: false });
    let revoked = false;
    let note: string | null = null;
    if (c.oauth?.revoke && row.secret) {
      // Google revokes the whole grant of a client, so revoking one Google connector would end the others too.
      const siblings = c.meta.group ? (await listConnections(auth)).filter((r) => r.connector_id !== c.meta.id && r.status !== "disconnected" && REGISTRY[r.connector_id]?.meta.group === c.meta.group) : [];
      const client = oauthClient(c.oauth);
      if (siblings.length) {
        note = `Your other ${c.meta.vendor} connections still use the same sign-in, so Orbis removed this connection but didn't revoke access at ${c.meta.vendor}. Disconnect them too to revoke it.`;
      } else if (client) {
        try {
          await c.oauth.revoke(storedTokens(auth, row), client, fetch);
          revoked = true;
        } catch (err) {
          reportError(err, { where: "connectors.revoke", connector: c.meta.id });
          note = `Orbis deleted its copy of the sign-in, but ${c.meta.vendor} didn't confirm the revoke. You can also remove Orbis in your ${c.meta.vendor} account's security settings.`;
        }
      }
    } else if (c.meta.auth === "oauth2") {
      note = `Orbis deleted its copy of the sign-in. ${c.meta.vendor} has no way for apps to revoke access, so you can also remove Orbis in your ${c.meta.vendor} account settings.`;
    } else if (c.meta.auth === "github_app") {
      note = "To stop Orbis reading your repositories entirely, uninstall the Orbis app in GitHub → Settings → Applications.";
    }
    await forgetConnection(auth, c.meta.id);
    return NextResponse.json({ ok: true, revoked, note });
  } catch (err) {
    return errorResponse(err);
  }
}
