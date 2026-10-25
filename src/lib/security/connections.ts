import "server-only";
import { isAdmin } from "@/lib/admin";
import { ConnectorError } from "@/lib/connectors/http";
import { missingSetup } from "@/lib/connectors/oauth";
import { connector } from "@/lib/connectors/registry";
import { accessToken, getConnection, noteFailure, usable, type Authed, type ConnectionRow } from "@/lib/connectors/runtime";
import type { ToolContext } from "@/lib/connectors/types";
import { ApiError } from "@/lib/http";

/**
 * The person's own connections (GitHub, Vercel, Cloudflare) as the Security Team uses them: a fresh, server-side
 * token for that person only, never sent to the browser or a model. Access to one service never implies another.
 */

export type ServiceId = "github" | "vercel" | "cloudflare";

export interface ServiceState {
  id: ServiceId;
  /** Set up on this site (credentials configured by the owner). */
  available: boolean;
  status: ConnectionRow["status"] | "not_connected";
  account: string | null;
  writeEnabled: boolean;
  scopes: string[];
  lastCheckedAt: string | null;
  lastError: string | null;
}

export async function serviceState(auth: Authed, id: ServiceId, rows?: ConnectionRow[]): Promise<ServiceState> {
  const c = connector(id);
  const row = rows ? (rows.find((r) => r.connector_id === id) ?? null) : await getConnection(auth, id).catch(() => null);
  return {
    id,
    available: !!c && missingSetup(c).length === 0,
    status: row?.status ?? "not_connected",
    account: row?.status === "connected" ? row.account_label : null,
    writeEnabled: !!row?.write_enabled,
    scopes: row?.scopes ?? [],
    lastCheckedAt: row?.last_checked_at ?? null,
    lastError: row?.last_error ?? null,
  };
}

/** A tool context with the person's live token for a service, or null when it isn't connected. */
export async function serviceContext(auth: Authed, id: ServiceId, signal?: AbortSignal): Promise<{ ctx: ToolContext; row: ConnectionRow } | null> {
  const c = connector(id);
  if (!c) return null;
  const row = await getConnection(auth, id);
  if (!usable(c, row)) return null;
  try {
    const { token, extra } = await accessToken(auth, c, row!);
    return { ctx: { token, extra, fetch, signal }, row: row! };
  } catch (err) {
    await noteFailure(auth, id, err);
    if (err instanceof ConnectorError) throw new ApiError(err.kind === "auth" ? "forbidden" : "upstream_error", err.message);
    throw err;
  }
}

/** Like serviceContext, but explains what to do when the service isn't connected. */
export async function requireService(auth: Authed, id: ServiceId, signal?: AbortSignal): Promise<{ ctx: ToolContext; row: ConnectionRow }> {
  const s = await serviceContext(auth, id, signal);
  if (!s) {
    const name = connector(id)?.meta.name ?? id;
    throw new ApiError("forbidden", `${name} isn't connected. Connect it on the Connectors page (read-only is enough for audits), then try again.`, { connect: id });
  }
  return s;
}

/**
 * The token for reading a GitHub repository: the person's own GitHub connection first; administrators may fall back
 * to the site's GITHUB_TOKEN; otherwise none (public repositories only).
 */
export async function githubReadToken(auth: Authed, signal?: AbortSignal): Promise<{ token: string | null; via: "connection" | "site_token" | "public" }> {
  const s = await serviceContext(auth, "github", signal).catch(() => null);
  if (s?.ctx.token) return { token: s.ctx.token, via: "connection" };
  if (await isAdmin(auth)) {
    const t = (process.env.GITHUB_TOKEN ?? "").trim();
    if (t) return { token: t, via: "site_token" };
  }
  return { token: null, via: "public" };
}
