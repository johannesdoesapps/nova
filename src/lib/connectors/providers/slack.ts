import "server-only";
import { z } from "zod";
import { connectorMeta } from "../catalog";
import { call, clip, ConnectorError, type Fetch } from "../http";
import type { ActionDef, Connector, ToolContext, ToolDef } from "../types";

/**
 * Slack, with a user token (Sign in with Slack, OAuth v2 user scopes), so
 * Orbis sees only what the user can see. Slack's Web API answers 200 with
 * {ok: false, error} on failure; those errors are mapped here.
 */

const API = "https://slack.com/api";

const SLACK_ERRORS: Record<string, ConnectorError["kind"]> = {
  not_authed: "auth",
  invalid_auth: "auth",
  token_revoked: "auth",
  token_expired: "auth",
  account_inactive: "auth",
  missing_scope: "permission",
  not_allowed_token_type: "permission",
  channel_not_found: "not_found",
  not_in_channel: "permission",
  ratelimited: "rate_limited",
};

export async function slackApi<T>(method: string, ctx: Pick<ToolContext, "token" | "signal">, params: Record<string, string>, f: Fetch): Promise<T> {
  const res = await call(`${API}/${method}`, { method: "POST", token: ctx.token, form: params, service: "Slack", signal: ctx.signal }, f);
  const j = (await res.json()) as { ok: boolean; error?: string } & T;
  if (!j.ok) {
    const kind = SLACK_ERRORS[j.error ?? ""] ?? "bad_request";
    const msg =
      kind === "auth" ? "Slack didn't accept the saved sign-in. Reconnect Slack on the Connectors page." :
      kind === "permission" ? "Slack refused: the connection doesn't have permission for that." :
      kind === "not_found" ? "Slack couldn't find that channel." :
      kind === "rate_limited" ? "Slack is limiting requests right now. Try again in a minute." :
      "Slack rejected the request.";
    throw new ConnectorError(kind, msg);
  }
  return j;
}

type Match = { text?: string; username?: string; user?: string; permalink?: string; ts?: string; channel?: { id?: string; name?: string; is_im?: boolean } };

const slackSearch: ToolDef<{ query: string; limit?: number }> = {
  name: "slack_search",
  description: "Search Slack messages the user can see (supports Slack modifiers like in:#channel, from:@name, after:2026-01-01). Returns author, channel, time, text and link.",
  access: "read",
  input: z.object({ query: z.string().trim().min(1).max(300), limit: z.number().int().min(1).max(20).optional() }),
  args: '{"query": Slack search query, "limit"?: 1-20}',
  async run(ctx, { query, limit }) {
    const r = await slackApi<{ messages?: { matches?: Match[] } }>("search.messages", ctx, { query, count: String(limit ?? 10), sort: "timestamp", sort_dir: "desc" }, ctx.fetch);
    const matches = r.messages?.matches ?? [];
    return {
      summary: `${matches.length} message${matches.length === 1 ? "" : "s"}`,
      items: matches.map((m) => ({
        connectorId: "slack",
        title: `${m.channel?.is_im ? "Direct message" : `#${m.channel?.name ?? "channel"}`} · ${m.username ?? m.user ?? "someone"}`,
        url: m.permalink ?? null,
        snippet: `${m.ts ? new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace("T", " ") : ""} · ${clip((m.text ?? "").replace(/\s+/g, " "), 400)}${m.channel?.id ? ` · channel ${m.channel.id}` : ""}`,
        meta: m.channel?.name,
      })),
    };
  },
};

const slackPost: ActionDef<{ channel: string; text: string; channelName?: string }> = {
  name: "slack_post_message",
  description: "Post a message as the user to a Slack channel or conversation (by channel id from slack_search).",
  access: "write",
  scope: "chat:write",
  input: z.object({ channel: z.string().regex(/^[CDG][A-Z0-9]{6,20}$/, "Use a channel id (from a Slack search)."), text: z.string().trim().min(1).max(4000), channelName: z.string().max(100).optional() }),
  args: '{"channel": channel id from slack_search, "channelName"?: name for display, "text": message}',
  fields: [
    { key: "channelName", label: "Channel" },
    { key: "text", label: "Message", multiline: true },
  ],
  describe: (i) => `Post this message as you in ${i.channelName ? `#${i.channelName.replace(/^#/, "")}` : `channel ${i.channel}`}. Everyone in that conversation will see it.`,
  async run(ctx, i) {
    const r = await slackApi<{ channel?: string; ts?: string }>("chat.postMessage", ctx, { channel: i.channel, text: i.text }, ctx.fetch);
    const link = r.ts ? await slackApi<{ permalink?: string }>("chat.getPermalink", ctx, { channel: i.channel, message_ts: r.ts }, ctx.fetch).then((p) => p.permalink ?? null).catch(() => null) : null;
    return { summary: `Posted to ${i.channelName ? `#${i.channelName.replace(/^#/, "")}` : "Slack"}.`, url: link };
  },
};

export const slack: Connector = {
  meta: connectorMeta("slack")!,
  oauth: {
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    clientIdEnv: "SLACK_CLIENT_ID",
    clientSecretEnv: "SLACK_CLIENT_SECRET",
    scopeParam: "user_scope",
    scopeSeparator: ",",
    pkce: false,
    clientAuth: "body",
    tokenBody: "form",
    parseToken(j) {
      const u = (j.authed_user ?? {}) as Record<string, unknown>;
      if (typeof u.access_token !== "string") throw new ConnectorError("auth", "Slack didn't return a user token.");
      const expiresIn = Number(u.expires_in);
      const team = (j.team ?? {}) as { name?: string; id?: string };
      return {
        accessToken: u.access_token,
        refreshToken: typeof u.refresh_token === "string" ? u.refresh_token : null,
        expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
        scopes: typeof u.scope === "string" ? u.scope.split(",") : null,
        extra: { ...(team.name ? { team: team.name } : {}), ...(team.id ? { teamId: team.id } : {}) },
      };
    },
    async revoke(tokens, _client, f) {
      await slackApi("auth.revoke", { token: tokens.accessToken }, {}, f);
    },
  },
  async account(ctx, tokens) {
    const r = await slackApi<{ user?: string; team?: string }>("auth.test", ctx, {}, ctx.fetch);
    return { label: `${r.user ?? "you"} · ${r.team ?? tokens.extra?.team ?? "Slack"}` };
  },
  health: async (ctx) => void (await slackApi("auth.test", ctx, {}, ctx.fetch)),
  tools: [slackSearch as ToolDef],
  actions: [slackPost as unknown as ActionDef],
  defaultSearch: "slack_search",
};
