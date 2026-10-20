import "server-only";
import { z } from "zod";
import { connectorMeta } from "../catalog";
import { call, callJson, clip, ConnectorError, htmlToText } from "../http";
import { standardToken } from "../oauth";
import type { ActionDef, Connector, OAuthConfig, ToolContext, ToolDef } from "../types";

/**
 * Google Drive, Gmail and Google Calendar, through Google's REST APIs with
 * one OAuth client (GOOGLE_OAUTH_CLIENT_ID / _SECRET). Each connector is a
 * separate grant with only its own scopes.
 */

const GOOGLE_OAUTH: OAuthConfig = {
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
  clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
  baseScopes: ["openid", "email"],
  pkce: true,
  clientAuth: "body",
  tokenBody: "form",
  // A refresh token every time, so the connection keeps working after an hour.
  extraAuthParams: { access_type: "offline", prompt: "consent" },
  parseToken: (j) => standardToken(j),
  async revoke(tokens, _client, f) {
    await call("https://oauth2.googleapis.com/revoke", { method: "POST", form: { token: tokens.refreshToken ?? tokens.accessToken }, service: "Google", retries: 0 }, f);
  },
};

async function googleAccount(ctx: ToolContext): Promise<{ label: string }> {
  const u = await callJson<{ email?: string; name?: string }>("https://openidconnect.googleapis.com/v1/userinfo", { token: ctx.token, service: "Google", signal: ctx.signal }, ctx.fetch);
  return { label: u.email ?? u.name ?? "Google account" };
}

const limit = z.number().int().min(1).max(10).optional();

// ---------------------------------------------------------------- Drive

const DRIVE = "https://www.googleapis.com/drive/v3";
type DriveFile = { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string; owners?: { displayName?: string }[]; size?: string };

/** Escape a value for Drive's query language. */
export const driveQuote = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const KIND: Record<string, string> = {
  "application/vnd.google-apps.document": "Google Doc",
  "application/vnd.google-apps.spreadsheet": "Google Sheet",
  "application/vnd.google-apps.presentation": "Google Slides",
  "application/vnd.google-apps.folder": "Folder",
  "application/pdf": "PDF",
};
const kindOf = (m: string) => KIND[m] ?? m.split("/").pop() ?? m;
const day = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 10) : "");

const driveSearch: ToolDef<{ query: string; limit?: number }> = {
  name: "drive_search",
  description: "Search Google Drive files by name and content. Returns file names, types, dates and links.",
  access: "read",
  input: z.object({ query: z.string().trim().min(1).max(200), limit }),
  args: '{"query": words to find in file names or contents, "limit"?: 1-10}',
  async run(ctx, { query, limit: n }) {
    const q = `trashed = false and (name contains ${driveQuote(query)} or fullText contains ${driveQuote(query)})`;
    const params = new URLSearchParams({
      q,
      pageSize: String(n ?? 8),
      fields: "files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      spaces: "drive",
    });
    const r = await callJson<{ files?: DriveFile[] }>(`${DRIVE}/files?${params}`, { token: ctx.token, service: "Google Drive", signal: ctx.signal }, ctx.fetch);
    const files = r.files ?? [];
    return {
      summary: `${files.length} file${files.length === 1 ? "" : "s"}`,
      items: files.map((f) => ({
        connectorId: "google_drive",
        title: f.name,
        url: f.webViewLink ?? null,
        snippet: `${kindOf(f.mimeType)} · edited ${day(f.modifiedTime)}${f.owners?.[0]?.displayName ? ` · ${f.owners[0].displayName}` : ""}`,
        meta: kindOf(f.mimeType),
        read: f.mimeType === "application/vnd.google-apps.folder" ? undefined : { tool: "drive_read", args: { fileId: f.id } },
      })),
    };
  },
};

const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};
const READABLE = /^(text\/|application\/(json|xml|javascript|x-yaml|csv))/;

const driveRead: ToolDef<{ fileId: string }> = {
  name: "drive_read",
  description: "Read the text of one Google Drive file (Docs, Sheets as CSV, Slides, text files) by its id from drive_search.",
  access: "read",
  input: z.object({ fileId: z.string().regex(/^[A-Za-z0-9_-]{10,200}$/, "Use a file id from a Drive search.") }),
  args: '{"fileId": id from drive_search}',
  async run(ctx, { fileId }) {
    const meta = await callJson<DriveFile>(`${DRIVE}/files/${fileId}?fields=id,name,mimeType,webViewLink,size&supportsAllDrives=true`, { token: ctx.token, service: "Google Drive", signal: ctx.signal }, ctx.fetch);
    const exportAs = EXPORTS[meta.mimeType];
    let text: string;
    if (exportAs) {
      text = await (await call(`${DRIVE}/files/${fileId}/export?mimeType=${encodeURIComponent(exportAs)}`, { token: ctx.token, service: "Google Drive", signal: ctx.signal, headers: { accept: "*/*" } }, ctx.fetch)).text();
    } else if (READABLE.test(meta.mimeType) && Number(meta.size ?? 0) <= 2_000_000) {
      text = await (await call(`${DRIVE}/files/${fileId}?alt=media&supportsAllDrives=true`, { token: ctx.token, service: "Google Drive", signal: ctx.signal, headers: { accept: "*/*" } }, ctx.fetch)).text();
    } else {
      throw new ConnectorError("bad_request", `Orbis can't read “${meta.name}” (${kindOf(meta.mimeType)}) as text. It can read Google Docs, Sheets, Slides and text files.`);
    }
    return {
      summary: `Read “${clip(meta.name, 60)}”`,
      items: [{ connectorId: "google_drive", title: meta.name, url: meta.webViewLink ?? null, snippet: clip(text.replace(/\s+/g, " "), 280), meta: kindOf(meta.mimeType) }],
      text: clip(text, 20_000),
    };
  },
};

// ---------------------------------------------------------------- Gmail

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
type Header = { name: string; value: string };
type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: Header[] };
type GMessage = { id: string; threadId: string; snippet?: string; payload?: Part; internalDate?: string };

const header = (m: GMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const decode = (data?: string) => (data ? Buffer.from(data, "base64url").toString("utf8") : "");

/** A message's text: the plain-text part if there is one, else the HTML part as text. */
export function messageText(p?: Part): string {
  if (!p) return "";
  const flat: Part[] = [];
  const walk = (x: Part) => {
    flat.push(x);
    x.parts?.forEach(walk);
  };
  walk(p);
  const plain = flat.find((x) => x.mimeType === "text/plain" && x.body?.data);
  if (plain) return decode(plain.body!.data);
  const html = flat.find((x) => x.mimeType === "text/html" && x.body?.data);
  return html ? htmlToText(decode(html.body!.data)) : "";
}

const threadUrl = (threadId: string) => `https://mail.google.com/mail/u/0/#all/${threadId}`;

const gmailSearch: ToolDef<{ query: string; limit?: number }> = {
  name: "gmail_search",
  description: "Search Gmail with Gmail search syntax (from:, to:, subject:, newer_than:7d, has:attachment…). Returns sender, subject, date, snippet and thread id.",
  access: "read",
  input: z.object({ query: z.string().trim().min(1).max(300), limit }),
  args: '{"query": Gmail search query, e.g. "business plan newer_than:30d", "limit"?: 1-10}',
  async run(ctx, { query, limit: n }) {
    const list = await callJson<{ messages?: { id: string }[] }>(`${GMAIL}/messages?${new URLSearchParams({ q: query, maxResults: String(n ?? 8) })}`, { token: ctx.token, service: "Gmail", signal: ctx.signal }, ctx.fetch);
    const ids = (list.messages ?? []).map((m) => m.id);
    const meta = new URLSearchParams([["format", "metadata"], ["metadataHeaders", "From"], ["metadataHeaders", "Subject"], ["metadataHeaders", "Date"]]);
    const msgs = await Promise.all(ids.map((id) => callJson<GMessage>(`${GMAIL}/messages/${id}?${meta}`, { token: ctx.token, service: "Gmail", signal: ctx.signal }, ctx.fetch)));
    return {
      summary: `${msgs.length} message${msgs.length === 1 ? "" : "s"}`,
      items: msgs.map((m) => ({
        connectorId: "gmail",
        title: header(m, "Subject") || "(no subject)",
        url: threadUrl(m.threadId),
        snippet: `${clip(header(m, "From"), 80)} · ${header(m, "Date")} · ${clip(m.snippet ?? "", 220)}`,
        meta: header(m, "From"),
        read: { tool: "gmail_read_thread", args: { threadId: m.threadId } },
      })),
    };
  },
};

const gmailThread: ToolDef<{ threadId: string }> = {
  name: "gmail_read_thread",
  description: "Read a whole Gmail thread (every message's sender, date and text) by thread id from gmail_search.",
  access: "read",
  input: z.object({ threadId: z.string().regex(/^[A-Za-z0-9]{6,40}$/, "Use a thread id from a Gmail search.") }),
  args: '{"threadId": thread id from gmail_search}',
  async run(ctx, { threadId }) {
    const t = await callJson<{ messages?: GMessage[] }>(`${GMAIL}/threads/${threadId}?format=full`, { token: ctx.token, service: "Gmail", signal: ctx.signal }, ctx.fetch);
    const msgs = t.messages ?? [];
    const subject = msgs[0] ? header(msgs[0], "Subject") || "(no subject)" : "(empty thread)";
    const text = msgs.map((m) => `From: ${header(m, "From")}\nDate: ${header(m, "Date")}\n\n${clip(messageText(m.payload).trim(), 6000)}`).join("\n\n---\n\n");
    return {
      summary: `Read “${clip(subject, 60)}” (${msgs.length} message${msgs.length === 1 ? "" : "s"})`,
      items: [{ connectorId: "gmail", title: subject, url: threadUrl(threadId), snippet: clip(msgs.at(-1)?.snippet ?? "", 240), meta: `${msgs.length} messages` }],
      text: clip(text, 20_000),
    };
  },
};

const NO_BREAKS = /^[^\r\n]*$/;
const emailList = z
  .string()
  .trim()
  .min(3)
  .max(500)
  .regex(NO_BREAKS)
  .refine((s) => s.split(",").every((a) => /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(a.trim().replace(/^.*<(.+)>$/, "$1"))), "Use email addresses, separated by commas.");

/** RFC 2822 text for a plain-text message; the subject is MIME-encoded so any language works. */
export function rfc822(m: { to: string; subject: string; body: string; inReplyTo?: string }): string {
  const subject = /^[\x20-\x7e]*$/.test(m.subject) ? m.subject : `=?UTF-8?B?${Buffer.from(m.subject).toString("base64")}?=`;
  return [
    `To: ${m.to}`,
    `Subject: ${subject}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(m.body).toString("base64").replace(/.{76}/g, "$&\r\n"),
  ].join("\r\n");
}

const gmailDraft: ActionDef<{ to: string; subject: string; body: string; threadId?: string }> = {
  name: "gmail_create_draft",
  description: "Save an email draft in the user's Gmail (it is NOT sent; the user sends it from Gmail).",
  access: "write",
  scope: "https://www.googleapis.com/auth/gmail.compose",
  input: z.object({ to: emailList, subject: z.string().trim().max(250).regex(NO_BREAKS), body: z.string().max(20_000), threadId: z.string().regex(/^[A-Za-z0-9]{6,40}$/).optional() }),
  args: '{"to": email address(es), "subject": text, "body": plain text, "threadId"?: to reply in a thread}',
  fields: [
    { key: "to", label: "To" },
    { key: "subject", label: "Subject" },
    { key: "body", label: "Message", multiline: true },
  ],
  describe: (i) => `Save a draft to ${i.to} in your Gmail. It won't be sent.`,
  async run(ctx, i) {
    const raw = Buffer.from(rfc822(i)).toString("base64url");
    await callJson<{ id: string }>(`${GMAIL}/drafts`, { method: "POST", token: ctx.token, json: { message: { raw, ...(i.threadId ? { threadId: i.threadId } : {}) } }, service: "Gmail", signal: ctx.signal, retries: 0 }, ctx.fetch);
    return { summary: `Draft saved in Gmail (to ${i.to}).`, url: "https://mail.google.com/mail/u/0/#drafts" };
  },
};

// ---------------------------------------------------------------- Calendar

const CAL = "https://www.googleapis.com/calendar/v3";
type GEvent = { id: string; summary?: string; htmlLink?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string }; location?: string; attendees?: { email?: string }[]; organizer?: { email?: string } };
const isoDate = z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "Use an ISO date and time.");
const when = (e: GEvent) => `${e.start?.dateTime ?? e.start?.date ?? "?"} → ${e.end?.dateTime ?? e.end?.date ?? "?"}`;

const calEvents: ToolDef<{ query?: string; timeMin?: string; timeMax?: string; limit?: number }> = {
  name: "calendar_events",
  description: "List events on the user's primary Google Calendar between two times (default: the next 14 days), optionally matching words.",
  access: "read",
  input: z.object({ query: z.string().trim().max(200).optional(), timeMin: isoDate.optional(), timeMax: isoDate.optional(), limit: z.number().int().min(1).max(25).optional() }),
  args: '{"timeMin"?: ISO datetime, "timeMax"?: ISO datetime, "query"?: words, "limit"?: 1-25}',
  async run(ctx, i) {
    const min = i.timeMin ? new Date(i.timeMin) : new Date();
    const max = i.timeMax ? new Date(i.timeMax) : new Date(min.getTime() + 14 * 86_400_000);
    const params = new URLSearchParams({ singleEvents: "true", orderBy: "startTime", timeMin: min.toISOString(), timeMax: max.toISOString(), maxResults: String(i.limit ?? 15) });
    if (i.query) params.set("q", i.query);
    const r = await callJson<{ items?: GEvent[] }>(`${CAL}/calendars/primary/events?${params}`, { token: ctx.token, service: "Google Calendar", signal: ctx.signal }, ctx.fetch);
    const events = r.items ?? [];
    return {
      summary: `${events.length} event${events.length === 1 ? "" : "s"}`,
      items: events.map((e) => ({
        connectorId: "google_calendar",
        title: e.summary ?? "(no title)",
        url: e.htmlLink ?? null,
        snippet: `${when(e)}${e.location ? ` · ${e.location}` : ""}${e.attendees?.length ? ` · ${e.attendees.length} guests` : ""}`,
        meta: e.start?.dateTime ?? e.start?.date ?? "",
      })),
    };
  },
};

const calFreeBusy: ToolDef<{ timeMin: string; timeMax: string }> = {
  name: "calendar_freebusy",
  description: "Busy times on the user's primary Google Calendar between two times, to find when they're free.",
  access: "read",
  input: z.object({ timeMin: isoDate, timeMax: isoDate }),
  args: '{"timeMin": ISO datetime, "timeMax": ISO datetime}',
  async run(ctx, i) {
    const r = await callJson<{ calendars?: Record<string, { busy?: { start: string; end: string }[] }> }>(
      `${CAL}/freeBusy`,
      { method: "POST", token: ctx.token, json: { timeMin: new Date(i.timeMin).toISOString(), timeMax: new Date(i.timeMax).toISOString(), items: [{ id: "primary" }] }, service: "Google Calendar", signal: ctx.signal },
      ctx.fetch,
    );
    const busy = r.calendars?.primary?.busy ?? [];
    return {
      summary: `${busy.length} busy period${busy.length === 1 ? "" : "s"}`,
      items: busy.map((b) => ({ connectorId: "google_calendar", title: "Busy", url: null, snippet: `${b.start} → ${b.end}` })),
      text: busy.length ? busy.map((b) => `Busy ${b.start} → ${b.end}`).join("\n") : `Free for the whole period ${i.timeMin} → ${i.timeMax}.`,
    };
  },
};

const calCreate: ActionDef<{ summary: string; start: string; end: string; description?: string; location?: string; timeZone?: string }> = {
  name: "calendar_create_event",
  description: "Add an event to the user's primary Google Calendar (no invitations are sent).",
  access: "write",
  scope: "https://www.googleapis.com/auth/calendar.events",
  input: z
    .object({
      summary: z.string().trim().min(1).max(200),
      start: isoDate,
      end: isoDate,
      description: z.string().max(5000).optional(),
      location: z.string().max(300).optional(),
      timeZone: z.string().max(60).regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/).optional(),
    })
    .refine((i) => Date.parse(i.end) > Date.parse(i.start), "The event must end after it starts."),
  args: '{"summary": title, "start": ISO datetime, "end": ISO datetime, "description"?: text, "location"?: text, "timeZone"?: IANA zone}',
  fields: [
    { key: "summary", label: "Title" },
    { key: "start", label: "Starts" },
    { key: "end", label: "Ends" },
    { key: "location", label: "Location" },
    { key: "description", label: "Description", multiline: true },
  ],
  describe: (i) => `Add “${i.summary}” to your Google Calendar from ${i.start} to ${i.end}. No invitations are sent.`,
  async run(ctx, i) {
    const tz = i.timeZone ? { timeZone: i.timeZone } : {};
    const e = await callJson<GEvent>(
      `${CAL}/calendars/primary/events?sendUpdates=none`,
      { method: "POST", token: ctx.token, json: { summary: i.summary, description: i.description, location: i.location, start: { dateTime: i.start, ...tz }, end: { dateTime: i.end, ...tz } }, service: "Google Calendar", signal: ctx.signal, retries: 0 },
      ctx.fetch,
    );
    return { summary: `Added “${i.summary}” to Google Calendar.`, url: e.htmlLink ?? null };
  },
};

export const googleDrive: Connector = {
  meta: connectorMeta("google_drive")!,
  oauth: GOOGLE_OAUTH,
  account: googleAccount,
  health: async (ctx) => void (await callJson(`${DRIVE}/about?fields=user`, { token: ctx.token, service: "Google Drive", signal: ctx.signal }, ctx.fetch)),
  tools: [driveSearch as ToolDef, driveRead as ToolDef],
  actions: [],
  defaultSearch: "drive_search",
};

export const gmail: Connector = {
  meta: connectorMeta("gmail")!,
  oauth: GOOGLE_OAUTH,
  account: googleAccount,
  health: async (ctx) => void (await callJson(`${GMAIL}/profile`, { token: ctx.token, service: "Gmail", signal: ctx.signal }, ctx.fetch)),
  tools: [gmailSearch as ToolDef, gmailThread as ToolDef],
  actions: [gmailDraft as unknown as ActionDef],
  defaultSearch: "gmail_search",
};

export const googleCalendar: Connector = {
  meta: connectorMeta("google_calendar")!,
  oauth: GOOGLE_OAUTH,
  account: googleAccount,
  health: async (ctx) => void (await callJson(`${CAL}/users/me/calendarList?maxResults=1`, { token: ctx.token, service: "Google Calendar", signal: ctx.signal }, ctx.fetch)),
  tools: [calEvents as ToolDef, calFreeBusy as ToolDef],
  actions: [calCreate as unknown as ActionDef],
  defaultSearch: "calendar_events",
};
