import "server-only";
import { z } from "zod";
import { connectorMeta } from "../catalog";
import { call, callJson, clip, ConnectorError, htmlToText } from "../http";
import type { ActionDef, Connector, OAuthConfig, ToolContext, ToolDef } from "../types";

/**
 * Microsoft OneDrive and Outlook through Microsoft Graph, with one Entra app
 * registration (MICROSOFT_OAUTH_CLIENT_ID / _SECRET) for work, school and
 * personal accounts.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

const MS_OAUTH: OAuthConfig = {
  authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
  tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
  clientIdEnv: "MICROSOFT_OAUTH_CLIENT_ID",
  clientSecretEnv: "MICROSOFT_OAUTH_CLIENT_SECRET",
  baseScopes: ["offline_access", "User.Read"],
  pkce: true,
  clientAuth: "body",
  tokenBody: "form",
  extraAuthParams: { response_mode: "query", prompt: "select_account" },
};

async function msAccount(ctx: ToolContext) {
  const me = await callJson<{ mail?: string; userPrincipalName?: string; displayName?: string }>(`${GRAPH}/me?$select=mail,userPrincipalName,displayName`, { token: ctx.token, service: "Microsoft", signal: ctx.signal }, ctx.fetch);
  return { label: me.mail ?? me.userPrincipalName ?? me.displayName ?? "Microsoft account" };
}

// ---------------------------------------------------------------- OneDrive

type DriveItem = { id: string; name: string; webUrl?: string; lastModifiedDateTime?: string; size?: number; file?: { mimeType?: string }; folder?: unknown };
const TEXTY = /^(text\/|application\/(json|xml|javascript|x-yaml|csv))|\.(txt|md|csv|json|xml|ya?ml|log|ini|toml)$/i;

const oneDriveSearch: ToolDef<{ query: string; limit?: number }> = {
  name: "onedrive_search",
  description: "Search the user's OneDrive files by name and content. Returns names, links, dates and item ids.",
  access: "read",
  input: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(10).optional() }),
  args: '{"query": words to find, "limit"?: 1-10}',
  async run(ctx, { query, limit }) {
    const q = query.replace(/'/g, "''");
    const r = await callJson<{ value?: DriveItem[] }>(
      `${GRAPH}/me/drive/root/search(q='${encodeURIComponent(q)}')?$top=${limit ?? 8}&$select=id,name,webUrl,lastModifiedDateTime,size,file,folder`,
      { token: ctx.token, service: "OneDrive", signal: ctx.signal },
      ctx.fetch,
    );
    const items = r.value ?? [];
    return {
      summary: `${items.length} file${items.length === 1 ? "" : "s"}`,
      items: items.map((i) => ({
        connectorId: "onedrive",
        title: i.name,
        url: i.webUrl ?? null,
        snippet: `${i.folder ? "Folder" : (i.file?.mimeType ?? "File")} · edited ${i.lastModifiedDateTime?.slice(0, 10) ?? "?"}`,
        read: i.folder ? undefined : { tool: "onedrive_read", args: { itemId: i.id } },
      })),
    };
  },
};

const oneDriveRead: ToolDef<{ itemId: string }> = {
  name: "onedrive_read",
  description: "Read a OneDrive text file (txt, md, csv, json…) by item id from onedrive_search. Word, Excel and PowerPoint files can't be read as text.",
  access: "read",
  input: z.object({ itemId: z.string().regex(/^[A-Za-z0-9!._-]{5,120}$/, "Use an item id from a OneDrive search.") }),
  args: '{"itemId": item id from onedrive_search}',
  async run(ctx, { itemId }) {
    const meta = await callJson<DriveItem>(`${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}?$select=id,name,webUrl,size,file`, { token: ctx.token, service: "OneDrive", signal: ctx.signal }, ctx.fetch);
    if (!meta.file || !(TEXTY.test(meta.file.mimeType ?? "") || TEXTY.test(meta.name)) || (meta.size ?? 0) > 2_000_000) {
      throw new ConnectorError("bad_request", `Orbis can't read “${meta.name}” as text. It can read text files such as .txt, .md, .csv and .json from OneDrive.`);
    }
    const text = await (await call(`${GRAPH}/me/drive/items/${encodeURIComponent(itemId)}/content`, { token: ctx.token, service: "OneDrive", signal: ctx.signal, headers: { accept: "*/*" } }, ctx.fetch)).text();
    return {
      summary: `Read “${clip(meta.name, 60)}”`,
      items: [{ connectorId: "onedrive", title: meta.name, url: meta.webUrl ?? null, snippet: clip(text.replace(/\s+/g, " "), 280) }],
      text: clip(text, 20_000),
    };
  },
};

// ---------------------------------------------------------------- Outlook

type Mail = { id: string; subject?: string; webLink?: string; receivedDateTime?: string; bodyPreview?: string; from?: { emailAddress?: { name?: string; address?: string } }; toRecipients?: { emailAddress?: { address?: string } }[]; body?: { contentType?: string; content?: string } };
const sender = (m: Mail) => m.from?.emailAddress?.name ?? m.from?.emailAddress?.address ?? "unknown sender";

const outlookSearch: ToolDef<{ query: string; limit?: number }> = {
  name: "outlook_search",
  description: "Search the user's Outlook mail (words, from:, subject:). Returns sender, subject, date, preview and message id.",
  access: "read",
  input: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(10).optional() }),
  args: '{"query": search words, "limit"?: 1-10}',
  async run(ctx, { query, limit }) {
    const search = `"${query.replace(/["\\]/g, " ")}"`;
    const r = await callJson<{ value?: Mail[] }>(
      `${GRAPH}/me/messages?$search=${encodeURIComponent(search)}&$top=${limit ?? 8}&$select=id,subject,from,receivedDateTime,bodyPreview,webLink`,
      { token: ctx.token, service: "Outlook", signal: ctx.signal },
      ctx.fetch,
    );
    const mails = r.value ?? [];
    return {
      summary: `${mails.length} message${mails.length === 1 ? "" : "s"}`,
      items: mails.map((m) => ({
        connectorId: "outlook",
        title: m.subject || "(no subject)",
        url: m.webLink ?? null,
        snippet: `${sender(m)} · ${m.receivedDateTime ?? ""} · ${clip(m.bodyPreview ?? "", 220)}`,
        meta: sender(m),
        read: { tool: "outlook_read", args: { messageId: m.id } },
      })),
    };
  },
};

const outlookRead: ToolDef<{ messageId: string }> = {
  name: "outlook_read",
  description: "Read one Outlook message's full text by message id from outlook_search.",
  access: "read",
  input: z.object({ messageId: z.string().regex(/^[A-Za-z0-9=_+/-]{10,300}$/, "Use a message id from an Outlook search.") }),
  args: '{"messageId": message id from outlook_search}',
  async run(ctx, { messageId }) {
    const m = await callJson<Mail>(`${GRAPH}/me/messages/${encodeURIComponent(messageId)}?$select=subject,from,toRecipients,receivedDateTime,body,webLink`, { token: ctx.token, service: "Outlook", signal: ctx.signal, headers: { Prefer: 'outlook.body-content-type="text"' } }, ctx.fetch);
    const body = m.body?.contentType === "html" ? htmlToText(m.body.content ?? "") : (m.body?.content ?? "");
    return {
      summary: `Read “${clip(m.subject || "(no subject)", 60)}”`,
      items: [{ connectorId: "outlook", title: m.subject || "(no subject)", url: m.webLink ?? null, snippet: clip(body.replace(/\s+/g, " "), 240), meta: sender(m) }],
      text: clip(`From: ${sender(m)}\nTo: ${(m.toRecipients ?? []).map((r) => r.emailAddress?.address).join(", ")}\nDate: ${m.receivedDateTime}\n\n${body}`, 20_000),
    };
  },
};

const emails = z
  .string()
  .trim()
  .min(3)
  .max(500)
  .refine((s) => s.split(",").every((a) => /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(a.trim())), "Use email addresses, separated by commas.");

const outlookDraft: ActionDef<{ to: string; subject: string; body: string }> = {
  name: "outlook_create_draft",
  description: "Save an email draft in the user's Outlook Drafts folder (it is NOT sent).",
  access: "write",
  scope: "Mail.ReadWrite",
  input: z.object({ to: emails, subject: z.string().trim().max(250), body: z.string().max(20_000) }),
  args: '{"to": email address(es), "subject": text, "body": plain text}',
  fields: [
    { key: "to", label: "To" },
    { key: "subject", label: "Subject" },
    { key: "body", label: "Message", multiline: true },
  ],
  describe: (i) => `Save a draft to ${i.to} in your Outlook. It won't be sent.`,
  async run(ctx, i) {
    const m = await callJson<Mail>(
      `${GRAPH}/me/messages`,
      { method: "POST", token: ctx.token, json: { subject: i.subject, body: { contentType: "Text", content: i.body }, toRecipients: i.to.split(",").map((a) => ({ emailAddress: { address: a.trim() } })) }, service: "Outlook", signal: ctx.signal, retries: 0 },
      ctx.fetch,
    );
    return { summary: `Draft saved in Outlook (to ${i.to}).`, url: m.webLink ?? null };
  },
};

export const oneDrive: Connector = {
  meta: connectorMeta("onedrive")!,
  oauth: MS_OAUTH,
  account: msAccount,
  health: async (ctx) => void (await callJson(`${GRAPH}/me/drive?$select=id`, { token: ctx.token, service: "OneDrive", signal: ctx.signal }, ctx.fetch)),
  tools: [oneDriveSearch as ToolDef, oneDriveRead as ToolDef],
  actions: [],
  defaultSearch: "onedrive_search",
};

export const outlook: Connector = {
  meta: connectorMeta("outlook")!,
  oauth: MS_OAUTH,
  account: msAccount,
  health: async (ctx) => void (await callJson(`${GRAPH}/me/mailFolders/inbox?$select=id`, { token: ctx.token, service: "Outlook", signal: ctx.signal }, ctx.fetch)),
  tools: [outlookSearch as ToolDef, outlookRead as ToolDef],
  actions: [outlookDraft as unknown as ActionDef],
  defaultSearch: "outlook_search",
};
