import "server-only";
import { z } from "zod";
import { connectorMeta, type ConnectorItem } from "../catalog";
import { callJson, ConnectorError } from "../http";
import type { Connector, ToolContext, ToolDef } from "../types";

/**
 * Cloudflare, connected with an API token the person creates and scopes in their own Cloudflare dashboard (Cloudflare
 * has no OAuth for third-party apps). The token is checked with Cloudflare's official verify endpoint, stored sealed,
 * and used only server-side. What it can reach is decided by its permissions on Cloudflare; Orbis records what was
 * asked for and reports any area Cloudflare refuses as "missing permission", never as "secure".
 */

export const CF_API = "https://api.cloudflare.com/client/v4";
const SERVICE = "Cloudflare";

/** Cloudflare API tokens: 40 characters today; allow a little room for longer formats. */
export const CF_TOKEN_RE = /^[A-Za-z0-9_-]{32,200}$/;

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
  result_info?: { total_count?: number; total_pages?: number };
}

/** A Cloudflare API GET, unwrapped. A refused call names the permission area so the person knows what to add. */
export async function cf<T>(ctx: ToolContext, path: string, area?: string): Promise<{ result: T; info?: Envelope<T>["result_info"] }> {
  try {
    const r = await callJson<Envelope<T>>(`${CF_API}${path}`, { token: ctx.token, service: SERVICE, signal: ctx.signal }, ctx.fetch);
    if (!r.success) throw new ConnectorError("unavailable", `Cloudflare: ${r.errors?.[0]?.message?.slice(0, 160) ?? "request failed"}`);
    return { result: r.result, info: r.result_info };
  } catch (err) {
    if (err instanceof ConnectorError && (err.kind === "permission" || err.status === 403))
      throw new ConnectorError("permission", `The token doesn't have permission to read ${area ?? "this"}.`, 403);
    throw err;
  }
}

/** Whether the token is valid and active. Account-owned tokens can't use /user/tokens/verify, so a zone read stands in. */
export async function verifyToken(ctx: ToolContext): Promise<{ status: string; expiresOn: string | null; zones: number | null }> {
  let status = "active";
  let expiresOn: string | null = null;
  try {
    const v = await cf<{ status: string; expires_on?: string }>(ctx, "/user/tokens/verify");
    status = v.result.status;
    expiresOn = v.result.expires_on ?? null;
  } catch (err) {
    if (!(err instanceof ConnectorError)) throw err;
    // Cloudflare answers a malformed token with 400.
    if (err.kind === "bad_request") throw new ConnectorError("auth", "Cloudflare didn't accept this token. Check you copied all of it.");
    if (err.kind !== "auth" && err.kind !== "permission") throw err;
    // Maybe an account-owned token: valid if it can read zones.
  }
  if (status !== "active") throw new ConnectorError("auth", `Cloudflare says this token is ${status}. Create a new one and connect again.`);
  const z = await cf<unknown[]>(ctx, "/zones?per_page=1", "zones").catch((err) => {
    if (err instanceof ConnectorError && err.kind === "auth") throw new ConnectorError("auth", "Cloudflare didn't accept this token. Check you copied all of it, and that it hasn't expired or been revoked.");
    if (err instanceof ConnectorError && err.kind === "permission") return null;
    throw err;
  });
  return { status, expiresOn, zones: z ? (z.info?.total_count ?? z.result.length) : null };
}

const listZones: ToolDef<{ name?: string }> = {
  name: "cloudflare_list_zones",
  description: "List the Cloudflare zones (domains) the connected token can read, with plan, status and whether traffic is proxied.",
  access: "read",
  input: z.object({ name: z.string().trim().max(253).optional() }),
  args: '{"name"?: domain to look for}',
  async run(ctx, i) {
    const r = await cf<{ id: string; name: string; status: string; paused?: boolean; plan?: { name?: string }; account?: { name?: string } }[]>(ctx, `/zones?per_page=50${i.name ? `&name=${encodeURIComponent(i.name)}` : ""}`, "zones");
    const items: ConnectorItem[] = r.result.map((zn) => ({
      connectorId: "cloudflare",
      title: zn.name,
      url: `https://dash.cloudflare.com/?to=/:account/${encodeURIComponent(zn.name)}`,
      snippet: `${zn.status}${zn.paused ? " (paused: Cloudflare isn't protecting it)" : ""} · ${zn.plan?.name ?? "plan unknown"}${zn.account?.name ? ` · ${zn.account.name}` : ""}`,
      meta: zn.id,
    }));
    return { summary: `${items.length} zone${items.length === 1 ? "" : "s"}`, items };
  },
};

export const cloudflare: Connector = {
  meta: connectorMeta("cloudflare")!,
  async account(ctx) {
    const v = await verifyToken(ctx);
    return { label: `API token${v.zones != null ? ` · ${v.zones} zone${v.zones === 1 ? "" : "s"}` : " · no zone access"}${v.expiresOn ? ` · expires ${v.expiresOn.slice(0, 10)}` : ""}` };
  },
  async health(ctx) {
    await verifyToken(ctx);
  },
  tools: [listZones as ToolDef],
  actions: [],
  defaultSearch: "cloudflare_list_zones",
};
