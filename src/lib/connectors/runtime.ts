import "server-only";
import type { AuthContext } from "@/lib/auth";
import { ApiError } from "@/lib/http";
import { reportError } from "@/lib/observability";
import { githubAppConfig } from "@/lib/github/app";
import { requireRepoAccess } from "@/lib/github/server";
import type { AiMode, ConnectionView, ConnectorItem } from "./catalog";
import { open, seal, tokenBinding } from "./crypto";
import { ConnectorError, type Fetch } from "./http";
import { missingSetup, needsRefresh, refreshTokens } from "./oauth";
import { actionByName, connector, REGISTRY, toolByName } from "./registry";
import type { ActionDef, Connector, TokenSet, ToolDef, ToolResult } from "./types";

/**
 * Using connections on the server: reading a user's connection rows (through
 * their own session, so row-level security applies), opening and refreshing
 * tokens, running tools and confirmed actions with permission checks, and
 * keeping each connection's status honest (reconnect needed, error).
 */

export type Authed = Extract<AuthContext, { mode: "authenticated" }>;

export interface ConnectionRow {
  connector_id: string;
  status: ConnectionView["status"];
  account_label: string | null;
  scopes: string[];
  write_enabled: boolean;
  ai_mode: AiMode;
  secret: string | null;
  token_expires_at: string | null;
  last_error: string | null;
  connected_at: string | null;
  last_checked_at: string | null;
  last_used_at: string | null;
}

const COLS = "connector_id, status, account_label, scopes, write_enabled, ai_mode, secret, token_expires_at, last_error, connected_at, last_checked_at, last_used_at";

export function toView(r: ConnectionRow): ConnectionView {
  return {
    connectorId: r.connector_id,
    status: r.status,
    accountLabel: r.account_label,
    scopes: r.scopes ?? [],
    writeEnabled: r.write_enabled,
    aiMode: r.ai_mode,
    lastError: r.last_error,
    connectedAt: r.connected_at,
    lastCheckedAt: r.last_checked_at,
    lastUsedAt: r.last_used_at,
  };
}

export async function listConnections(auth: Authed): Promise<ConnectionRow[]> {
  const { data, error } = await auth.supabase.from("connector_accounts").select(COLS).limit(100);
  if (error) {
    reportError(error, { where: "connectors.list" });
    throw new ApiError("upstream_error", "Your connections couldn't be loaded right now.");
  }
  return (data ?? []) as ConnectionRow[];
}

export async function getConnection(auth: Authed, connectorId: string): Promise<ConnectionRow | null> {
  const { data, error } = await auth.supabase.from("connector_accounts").select(COLS).eq("connector_id", connectorId).maybeSingle();
  if (error) {
    reportError(error, { where: "connectors.get" });
    throw new ApiError("upstream_error", "The connection couldn't be loaded right now.");
  }
  return (data as ConnectionRow | null) ?? null;
}

export async function updateConnection(auth: Authed, connectorId: string, patch: Partial<Omit<ConnectionRow, "connector_id">>): Promise<void> {
  const { error } = await auth.supabase.from("connector_accounts").update({ ...patch, updated_at: new Date().toISOString() }).eq("connector_id", connectorId);
  if (error) reportError(error, { where: "connectors.update" });
}

/** Save a new or renewed connection: tokens sealed for this user and connector. */
export async function saveConnection(
  auth: Authed,
  c: Connector,
  v: { label: string; scopes: string[]; writeEnabled: boolean; tokens: TokenSet | null; aiMode?: AiMode },
): Promise<void> {
  const now = new Date().toISOString();
  const row = {
    connector_id: c.meta.id,
    status: "connected",
    account_label: v.label.slice(0, 200),
    scopes: v.scopes.slice(0, 50),
    write_enabled: v.writeEnabled,
    secret: v.tokens ? seal(JSON.stringify(v.tokens), tokenBinding(auth.user.id, c.meta.id)) : null,
    token_expires_at: v.tokens?.expiresAt ? new Date(v.tokens.expiresAt).toISOString() : null,
    last_error: null,
    connected_at: now,
    last_checked_at: now,
    updated_at: now,
    ...(v.aiMode ? { ai_mode: v.aiMode } : {}),
  };
  // user_id comes from the column default (auth.uid()); users can't set it.
  const { error } = await auth.supabase.from("connector_accounts").upsert(row, { onConflict: "user_id,connector_id" });
  if (error) {
    reportError(error, { where: "connectors.save" });
    throw new ApiError("upstream_error", "The connection couldn't be saved. Please try again.");
  }
}

/** Remove the stored tokens and mark the connection disconnected (the row stays so the page can say so). */
export async function forgetConnection(auth: Authed, connectorId: string): Promise<void> {
  const { error } = await auth.supabase
    .from("connector_accounts")
    .update({ status: "disconnected", secret: null, token_expires_at: null, scopes: [], write_enabled: false, last_error: null, updated_at: new Date().toISOString() })
    .eq("connector_id", connectorId);
  if (error) {
    reportError(error, { where: "connectors.forget" });
    throw new ApiError("upstream_error", "The connection couldn't be removed right now. Please try again.");
  }
}

export function storedTokens(auth: Authed, row: ConnectionRow): TokenSet {
  if (!row.secret) throw new ConnectorError("auth", "This connection has no saved sign-in. Please reconnect.");
  try {
    return JSON.parse(open(row.secret, tokenBinding(auth.user.id, row.connector_id))) as TokenSet;
  } catch {
    throw new ConnectorError("auth", "This connection's saved sign-in can't be used any more. Please reconnect.");
  }
}

/** A usable access token for a connection: refreshed (and re-saved) when it's about to expire. */
export async function accessToken(auth: Authed, c: Connector, row: ConnectionRow, f: Fetch = fetch): Promise<{ token: string | null; extra?: Record<string, string> }> {
  if (c.meta.auth === "none") return { token: null };
  if (c.meta.auth === "github_app") {
    try {
      return { token: await requireRepoAccess() };
    } catch (err) {
      throw new ConnectorError("auth", err instanceof Error ? err.message : "GitHub isn't connected.");
    }
  }
  let tokens = storedTokens(auth, row);
  if (needsRefresh(tokens)) {
    tokens = await refreshTokens(c, tokens, f);
    await updateConnection(auth, c.meta.id, {
      secret: seal(JSON.stringify(tokens), tokenBinding(auth.user.id, c.meta.id)),
      token_expires_at: tokens.expiresAt ? new Date(tokens.expiresAt).toISOString() : null,
    });
  }
  return { token: tokens.accessToken, extra: tokens.extra };
}

/** Record what a failure means for the connection, so the page can offer the fix. */
export async function noteFailure(auth: Authed, connectorId: string, err: unknown): Promise<void> {
  if (!(err instanceof ConnectorError)) return;
  if (err.kind === "auth") await updateConnection(auth, connectorId, { status: "reauth_required", last_error: err.message.slice(0, 500) });
  else if (err.kind === "unavailable" || err.kind === "permission") await updateConnection(auth, connectorId, { last_error: err.message.slice(0, 500) });
}

// ---------------------------------------------------------------- running tools

/** Results of recent identical calls, briefly, so a question and its follow-up don't call the service twice. */
const cache = new Map<string, { at: number; result: ToolResult }>();
const CACHE_MS = 60_000;

/** Whether a connector can be used by this user now (set up on the site and connected). */
export function usable(c: Connector, row: ConnectionRow | null): boolean {
  if (missingSetup(c).length) return false;
  if (c.meta.auth === "github_app") return !!githubAppConfig() && row?.status === "connected";
  return row?.status === "connected";
}

export interface ToolRun {
  connectorId: string;
  tool: string;
  ok: boolean;
  result?: ToolResult;
  error?: string;
}

export async function runTool(auth: Authed, name: string, args: unknown, opts: { rows?: ConnectionRow[]; signal?: AbortSignal; fetch?: Fetch } = {}): Promise<ToolRun> {
  const found = toolByName(name);
  if (!found) return { connectorId: "?", tool: name, ok: false, error: `Unknown tool ${name}.` };
  const { connector: c, tool } = found;
  const row = opts.rows ? (opts.rows.find((r) => r.connector_id === c.meta.id) ?? null) : await getConnection(auth, c.meta.id);
  if (!usable(c, row)) {
    const why = missingSetup(c).length ? `${c.meta.name} isn't set up on this site.` : row?.status === "reauth_required" ? `${c.meta.name} needs reconnecting.` : `${c.meta.name} isn't connected.`;
    return { connectorId: c.meta.id, tool: name, ok: false, error: why };
  }
  const parsed = (tool as ToolDef<unknown>).input.safeParse(args);
  if (!parsed.success) return { connectorId: c.meta.id, tool: name, ok: false, error: `Invalid request for ${c.meta.name}: ${parsed.error.issues[0]?.message ?? "bad arguments"}.` };
  const key = `${auth.user.id}:${name}:${JSON.stringify(parsed.data)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { connectorId: c.meta.id, tool: name, ok: true, result: hit.result };
  try {
    const { token, extra } = await accessToken(auth, c, row!, opts.fetch);
    const result = await (tool as ToolDef<unknown>).run({ token, extra, fetch: opts.fetch ?? fetch, signal: opts.signal }, parsed.data);
    cache.set(key, { at: Date.now(), result });
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
    if (c.meta.auth !== "github_app") void updateConnection(auth, c.meta.id, { last_used_at: new Date().toISOString(), ...(row!.last_error ? { last_error: null } : {}) });
    return { connectorId: c.meta.id, tool: name, ok: true, result };
  } catch (err) {
    await noteFailure(auth, c.meta.id, err);
    if (!(err instanceof ConnectorError) && !(err instanceof ApiError)) reportError(err, { where: `connectors.tool.${name}` });
    return { connectorId: c.meta.id, tool: name, ok: false, error: err instanceof ConnectorError || err instanceof ApiError ? err.message : `${c.meta.name} couldn't complete that request.` };
  }
}

/** Search one or more connected services at once (the page's search box). */
export async function searchConnected(auth: Authed, query: string, ids: string[] | null, signal?: AbortSignal): Promise<{ items: ConnectorItem[]; runs: ToolRun[] }> {
  const rows = await listConnections(auth);
  const targets = Object.values(REGISTRY).filter(
    (c) => c.defaultSearch && (ids ? ids.includes(c.meta.id) : true) && usable(c, rows.find((r) => r.connector_id === c.meta.id) ?? null),
  );
  const runs = await Promise.all(targets.map((c) => runTool(auth, c.defaultSearch!, defaultArgs(c, query), { rows, signal })));
  return { items: runs.flatMap((r) => r.result?.items ?? []), runs };
}

/** Arguments for a connector's default search from plain words. */
export function defaultArgs(c: Connector, query: string): Record<string, unknown> {
  const q = query.slice(0, 190);
  if (c.meta.id === "hubspot") return { object: "contacts", query: q };
  if (c.meta.id === "google_calendar") return { query: q };
  return { query: q };
}

// ---------------------------------------------------------------- confirmed actions

export interface ActionOutcome {
  ok: boolean;
  summary: string;
  url?: string | null;
}

/**
 * Run a write action the user confirmed: only when write access is turned on
 * for that connection and the needed permission was granted. Every attempt is
 * logged (without content).
 */
export async function runAction(auth: Authed, name: string, args: unknown, f: Fetch = fetch): Promise<ActionOutcome> {
  const found = actionByName(name);
  if (!found) throw new ApiError("bad_request", "Unknown action.");
  const { connector: c, action } = found;
  const row = await getConnection(auth, c.meta.id);
  if (!usable(c, row)) throw new ApiError("forbidden", `${c.meta.name} isn't connected.`);
  if (!row!.write_enabled) throw new ApiError("forbidden", `${c.meta.name} is connected read-only. To allow this, reconnect it with “Also allow creating and sending” turned on.`);
  if (c.meta.auth === "oauth2" && !row!.scopes.includes(action.scope)) {
    throw new ApiError("forbidden", `${c.meta.name} wasn't given permission for this. Reconnect it and allow write access.`);
  }
  const parsed = (action as ActionDef<unknown>).input.safeParse(args);
  if (!parsed.success) throw new ApiError("bad_request", parsed.error.issues[0]?.message ?? "Check the details and try again.");
  let outcome: ActionOutcome;
  try {
    const { token, extra } = await accessToken(auth, c, row!, f);
    const r = await (action as ActionDef<unknown>).run({ token, extra, fetch: f }, parsed.data);
    outcome = { ok: true, summary: r.summary, url: r.url ?? null };
  } catch (err) {
    await noteFailure(auth, c.meta.id, err);
    if (!(err instanceof ConnectorError) && !(err instanceof ApiError)) reportError(err, { where: `connectors.action.${name}` });
    outcome = { ok: false, summary: err instanceof ConnectorError || err instanceof ApiError ? err.message : `${c.meta.name} couldn't do that. Nothing was changed.` };
  }
  const { error } = await auth.supabase.from("connector_actions").insert({ connector_id: c.meta.id, action: name, status: outcome.ok ? "done" : "failed", summary: outcome.summary.slice(0, 500) });
  if (error) reportError(error, { where: "connectors.action.log" });
  return outcome;
}

export { connector };
