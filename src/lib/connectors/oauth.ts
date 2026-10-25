import "server-only";
import { createHash } from "node:crypto";
import { connectorKeyConfigured, randomToken, sign, verify } from "./crypto";
import { call, ConnectorError, type Fetch } from "./http";
import type { Connector, OAuthClient, OAuthConfig, TokenSet } from "./types";

/**
 * The OAuth 2.0 authorization-code flow, shared by every OAuth connector:
 * an authorization URL with a random state (and PKCE where the provider
 * supports it), the state and verifier kept in a signed, HTTP-only cookie,
 * and the code exchanged for tokens on the server with the client secret.
 */

export const STATE_COOKIE = "orbis_connect";
const STATE_TTL_MS = 10 * 60_000;

export function oauthClient(cfg: OAuthConfig, env: Record<string, string | undefined> = process.env): OAuthClient | null {
  const id = env[cfg.clientIdEnv]?.trim();
  const secret = env[cfg.clientSecretEnv]?.trim();
  return id && secret ? { id, secret } : null;
}

/** What's missing before a connector can be used on this site (empty when ready). */
export function missingSetup(c: Connector, env: Record<string, string | undefined> = process.env): string[] {
  if (c.meta.auth === "none") return [];
  const missing = c.meta.setup.env.filter((k) => !env[k]?.trim());
  if (!connectorKeyConfigured(env)) missing.unshift("ORBIS_CONNECTOR_KEY");
  return missing;
}

export function redirectUri(siteUrl: string): string {
  return `${siteUrl.replace(/\/$/, "")}/api/connectors/callback`;
}

export interface StatePayload {
  /** Connector id. */
  c: string;
  /** Random state echoed by the provider. */
  s: string;
  /** PKCE verifier. */
  v: string | null;
  /** The user who started it. */
  u: string;
  /** Write access requested. */
  w: boolean;
  /** Expiry, epoch ms. */
  t: number;
}

export function scopesFor(c: Connector, write: boolean): string[] {
  const own = [...c.meta.readScopes, ...(write ? c.meta.writeScopes : [])].map((p) => p.scope);
  // Notion's permissions are set on the connection itself, not requested in the URL.
  if (c.meta.id === "notion") return [];
  if (c.oauth?.urlScopes === "base") return [...(c.oauth.baseScopes ?? [])];
  return [...new Set([...(c.oauth?.baseScopes ?? []), ...own])];
}

/** The URL to send the user to, and the signed cookie value to set. */
export function beginAuthorization(c: Connector, opts: { userId: string; write: boolean; siteUrl: string; now?: number; env?: Record<string, string | undefined> }): { url: string; cookie: string } {
  const cfg = c.oauth;
  if (!cfg) throw new ConnectorError("bad_request", `${c.meta.name} doesn't use OAuth.`);
  const client = oauthClient(cfg, opts.env);
  if (!client || !connectorKeyConfigured(opts.env)) throw new ConnectorError("not_configured", `${c.meta.name} isn't set up on this site yet.`);
  const state = randomToken(24);
  const verifier = cfg.pkce ? randomToken(48) : null;
  const params = new URLSearchParams({ client_id: client.id, redirect_uri: redirectUri(opts.siteUrl), response_type: "code", state, ...(cfg.extraAuthParams ?? {}) });
  const scopes = scopesFor(c, opts.write);
  if (scopes.length) params.set(cfg.scopeParam ?? "scope", scopes.join(cfg.scopeSeparator ?? " "));
  if (verifier) {
    params.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    params.set("code_challenge_method", "S256");
  }
  const payload: StatePayload = { c: c.meta.id, s: state, v: verifier, u: opts.userId, w: opts.write, t: (opts.now ?? Date.now()) + STATE_TTL_MS };
  return { url: `${cfg.authorizeUrl}?${params}`, cookie: sign(Buffer.from(JSON.stringify(payload)).toString("base64url"), opts.env) };
}

/** Check the callback against the cookie: same state, same user, not expired. Returns the payload or a reason. */
export function checkCallback(cookie: string | undefined, state: string | null, userId: string, now = Date.now(), env?: Record<string, string | undefined>): { ok: true; payload: StatePayload } | { ok: false; reason: string } {
  if (!cookie || !state) return { ok: false, reason: "The connection request expired or was started in another browser. Please try again." };
  const raw = verify(cookie, env);
  if (!raw) return { ok: false, reason: "The connection request couldn't be verified. Please try again." };
  let p: StatePayload;
  try {
    p = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, reason: "The connection request couldn't be read. Please try again." };
  }
  if (p.s !== state) return { ok: false, reason: "The connection request didn't match. Please try again." };
  if (p.u !== userId) return { ok: false, reason: "You were signed in as someone else when this connection started. Please try again." };
  if (p.t < now) return { ok: false, reason: "The connection request expired. Please try again." };
  return { ok: true, payload: p };
}

export function standardToken(json: Record<string, unknown>, now = Date.now()): TokenSet {
  const access = json.access_token;
  if (typeof access !== "string" || !access) throw new ConnectorError("auth", "The service didn't return an access token.");
  const expiresIn = Number(json.expires_in);
  return {
    accessToken: access,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : null,
    scopes: typeof json.scope === "string" ? json.scope.split(/[ ,]+/).filter(Boolean) : null,
  };
}

async function tokenRequest(c: Connector, client: OAuthClient, params: Record<string, string>, f: Fetch, url?: string): Promise<TokenSet> {
  const cfg = c.oauth!;
  const headers: Record<string, string> = {};
  const body: Record<string, string> = { ...params };
  if (cfg.clientAuth === "basic") headers.authorization = `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString("base64")}`;
  else Object.assign(body, { client_id: client.id, client_secret: client.secret });
  const res = await call(url ?? cfg.tokenUrl, { method: "POST", headers, ...(cfg.tokenBody === "json" ? { json: body } : { form: body }), service: c.meta.name, retries: 1 }, f).catch((err) => {
    // A rejected code or refresh token means the user has to connect again.
    if (err instanceof ConnectorError && (err.status === 400 || err.status === 401)) throw new ConnectorError("auth", `${c.meta.name} didn't accept the sign-in. Please connect again.`, err.status);
    throw err;
  });
  const json = (await res.json()) as Record<string, unknown>;
  // Some providers (Slack) answer 200 with ok:false.
  if (json.ok === false) throw new ConnectorError("auth", `${c.meta.name} didn't accept the sign-in. Please connect again.`);
  return (cfg.parseToken ?? standardToken)(json);
}

export function exchangeCode(c: Connector, code: string, verifier: string | null, siteUrl: string, f: Fetch = fetch, env?: Record<string, string | undefined>): Promise<TokenSet> {
  const client = oauthClient(c.oauth!, env);
  if (!client) throw new ConnectorError("not_configured", `${c.meta.name} isn't set up on this site yet.`);
  return tokenRequest(c, client, { grant_type: "authorization_code", code, redirect_uri: redirectUri(siteUrl), ...(verifier ? { code_verifier: verifier } : {}) }, f);
}

export async function refreshTokens(c: Connector, tokens: TokenSet, f: Fetch = fetch, env?: Record<string, string | undefined>): Promise<TokenSet> {
  const client = oauthClient(c.oauth!, env);
  if (!client) throw new ConnectorError("not_configured", `${c.meta.name} isn't set up on this site yet.`);
  if (!tokens.refreshToken) throw new ConnectorError("auth", `${c.meta.name}'s sign-in expired. Please reconnect.`);
  const r = c.oauth!.refresh;
  const params: Record<string, string> = r?.grantType === false ? { refresh_token: tokens.refreshToken } : { grant_type: "refresh_token", refresh_token: tokens.refreshToken };
  const next = await tokenRequest(c, client, params, f, r?.url);
  // Providers that don't rotate refresh tokens leave it out of the response.
  return { ...next, refreshToken: next.refreshToken ?? tokens.refreshToken, scopes: next.scopes ?? tokens.scopes, extra: { ...tokens.extra, ...next.extra } };
}

/** Whether a token should be refreshed before use (expired or within a minute of it). */
export const needsRefresh = (t: TokenSet, now = Date.now()) => !!t.expiresAt && t.expiresAt - now < 60_000;

/**
 * Which requested scopes were granted. Services report scopes in their own
 * form (Microsoft may prefix the resource URL), and people can untick
 * permissions, so this matches by suffix. When a service doesn't report
 * scopes, what was requested is assumed.
 */
export function grantedScopes(requested: string[], reported: string[] | null | undefined): string[] {
  if (!reported?.length) return requested;
  const have = reported.map((s) => s.toLowerCase());
  return requested.filter((s) => have.some((h) => h === s.toLowerCase() || h.endsWith(`/${s.toLowerCase()}`)));
}

/** The permissions to record for a new connection: what the service reports, or what was asked for when its permissions live on the app. */
export function recordedScopes(c: Connector, requested: string[], reported: string[] | null | undefined): string[] {
  return c.oauth?.urlScopes === "base" ? requested : grantedScopes(requested, reported);
}
