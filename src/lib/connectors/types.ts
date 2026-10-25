import "server-only";
import type { z } from "zod";
import type { Access, ConnectorItem, ConnectorMeta } from "./catalog";
import type { Fetch } from "./http";

/**
 * The interface every connector implements. Adding a service means writing
 * one of these (API calls and tools) and a catalog entry; the pages, the
 * sign-in flow, token storage, the AI's routing and confirmations work for
 * it unchanged.
 */

export interface TokenSet {
  accessToken: string;
  refreshToken?: string | null;
  /** Epoch ms. */
  expiresAt?: number | null;
  /** Scopes the provider says it granted (when it says). */
  scopes?: string[] | null;
  /** Provider extras worth keeping (e.g. Notion workspace name). */
  extra?: Record<string, string>;
}

/** OAuth 2.0 authorization-code flow settings for one provider. */
export interface OAuthConfig {
  authorizeUrl: string;
  tokenUrl: string;
  /** Where refreshes go when it isn't the token URL (Figma), and whether they send grant_type. */
  refresh?: { url?: string; grantType?: boolean };
  /** Called on disconnect when the provider supports revoking a token. */
  revoke?: (tokens: TokenSet, client: OAuthClient, f: Fetch) => Promise<void>;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** "scope" (most) or "user_scope" (Slack user tokens). */
  scopeParam?: "scope" | "user_scope";
  scopeSeparator?: string;
  /** Scopes always asked for (sign-in identity, offline access…), besides the connector's own. */
  baseScopes?: string[];
  /**
   * "base": only baseScopes go in the authorization URL. For services whose permissions are set on the app itself
   * (GitHub Apps, Vercel Apps) rather than requested as OAuth scopes; the connector's permissions are then recorded
   * as asked for, and the service still enforces the app's real permissions on every call.
   */
  urlScopes?: "all" | "base";
  pkce: boolean;
  /** How the token endpoint wants the client credentials. */
  clientAuth: "body" | "basic";
  tokenBody: "form" | "json";
  extraAuthParams?: Record<string, string>;
  /** Read the token response (defaults to the standard fields). */
  parseToken?: (json: Record<string, unknown>) => TokenSet;
}

export interface OAuthClient {
  id: string;
  secret: string;
}

export interface ToolContext {
  /** Access token (null for connectors without accounts). */
  token: string | null;
  /** Provider extras saved with the connection (e.g. HubSpot portal id). */
  extra?: Record<string, string>;
  fetch: Fetch;
  signal?: AbortSignal;
}

export interface ToolResult {
  items: ConnectorItem[];
  /** Longer text for the AI (document or message bodies), already trimmed. */
  text?: string;
  /** One line for the activity row: "4 messages", "Read “Q3 plan”"… */
  summary: string;
}

export interface ToolDef<I = Record<string, unknown>> {
  /** Unique across connectors, e.g. "gmail_search". */
  name: string;
  description: string;
  access: "read";
  input: z.ZodType<I>;
  /** Short argument description for the AI's planner, e.g. '{"query": Gmail search query}'. */
  args: string;
  run(ctx: ToolContext, input: I): Promise<ToolResult>;
}

/** A write action: proposed by the AI, shown to the user, run only after they confirm. */
export interface ActionDef<I = Record<string, unknown>> {
  name: string;
  description: string;
  access: "write";
  /** The write scope this needs. */
  scope: string;
  input: z.ZodType<I>;
  args: string;
  /** Fields the review card shows and lets the user edit, in order. */
  fields: { key: string; label: string; multiline?: boolean }[];
  /** What confirming does, in plain words, from the arguments. */
  describe(input: I): string;
  run(ctx: ToolContext, input: I): Promise<{ summary: string; url?: string | null }>;
}

export interface Connector {
  meta: ConnectorMeta;
  oauth?: OAuthConfig;
  /** Who is connected (email or workspace name), from a fresh token, plus extras to keep with the connection. */
  account?: (ctx: ToolContext, tokens: TokenSet) => Promise<{ label: string; extra?: Record<string, string> }>;
  /** A cheap call that proves the connection works. */
  health?: (ctx: ToolContext) => Promise<void>;
  tools: ToolDef[];
  actions: ActionDef[];
  /** For the AI: the tool to use when a request mentions the service but the planner isn't available. */
  defaultSearch?: string;
}

export type { Access };
