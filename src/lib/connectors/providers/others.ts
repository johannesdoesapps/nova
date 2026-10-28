import "server-only";
import { z } from "zod";
import { connectorMeta } from "../catalog";
import { callJson, clip, ConnectorError, htmlToText } from "../http";
import type { Connector, ToolDef } from "../types";

/** HubSpot CRM, Figma and Wikipedia. */

// ---------------------------------------------------------------- HubSpot

const HUB = "https://api.hubapi.com";
const OBJECTS = {
  contacts: { type: "0-1", props: ["firstname", "lastname", "email", "company", "jobtitle", "lifecyclestage"] },
  companies: { type: "0-2", props: ["name", "domain", "industry", "city", "country"] },
  deals: { type: "0-3", props: ["dealname", "amount", "dealstage", "closedate", "pipeline"] },
} as const;
type HubObject = keyof typeof OBJECTS;

function hubTitle(object: HubObject, p: Record<string, string | null>): string {
  if (object === "contacts") return [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || "Contact";
  if (object === "companies") return p.name || p.domain || "Company";
  return p.dealname || "Deal";
}

const hubspotSearch: ToolDef<{ object: HubObject; query: string; limit?: number }> = {
  name: "hubspot_search",
  description: "Search HubSpot CRM contacts, companies or deals by text (names, emails, domains). Returns key properties and links.",
  access: "read",
  input: z.object({ object: z.enum(["contacts", "companies", "deals"]), query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(10).optional() }),
  args: '{"object": "contacts" | "companies" | "deals", "query": search text, "limit"?: 1-10}',
  async run(ctx, { object, query, limit }) {
    const o = OBJECTS[object];
    const r = await callJson<{ results?: { id: string; properties: Record<string, string | null> }[] }>(
      `${HUB}/crm/v3/objects/${object}/search`,
      { method: "POST", token: ctx.token, json: { query, limit: limit ?? 8, properties: o.props }, service: "HubSpot", signal: ctx.signal },
      ctx.fetch,
    );
    const rows = r.results ?? [];
    const portal = ctx.extra?.hubId;
    return {
      summary: `${rows.length} ${object}`,
      items: rows.map((row) => ({
        connectorId: "hubspot",
        title: hubTitle(object, row.properties),
        url: portal ? `https://app.hubspot.com/contacts/${portal}/record/${o.type}/${row.id}` : null,
        snippet: o.props.map((k) => (row.properties[k] ? `${k}: ${row.properties[k]}` : null)).filter(Boolean).join(" · "),
        meta: object,
      })),
    };
  },
};

export const hubspot: Connector = {
  meta: connectorMeta("hubspot")!,
  oauth: {
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: `${HUB}/oauth/v1/token`,
    clientIdEnv: "HUBSPOT_CLIENT_ID",
    clientSecretEnv: "HUBSPOT_CLIENT_SECRET",
    baseScopes: ["oauth"],
    pkce: false,
    clientAuth: "body",
    tokenBody: "form",
  },
  async account(ctx) {
    const info = await callJson<{ user?: string; hub_domain?: string; hub_id?: number }>(`${HUB}/oauth/v1/access-tokens/${encodeURIComponent(ctx.token ?? "")}`, { service: "HubSpot", signal: ctx.signal }, ctx.fetch);
    return { label: [info.user, info.hub_domain].filter(Boolean).join(" · ") || "HubSpot account", extra: info.hub_id ? { hubId: String(info.hub_id) } : undefined };
  },
  health: async (ctx) => void (await callJson(`${HUB}/crm/v3/objects/contacts?limit=1`, { token: ctx.token, service: "HubSpot", signal: ctx.signal }, ctx.fetch)),
  tools: [hubspotSearch as ToolDef],
  actions: [],
  defaultSearch: "hubspot_search",
};

// ---------------------------------------------------------------- Figma

const FIGMA = "https://api.figma.com/v1";
/** A Figma file key from a key or any figma.com file/design/proto/board link. */
export function figmaKey(s: string): string | null {
  const m = /figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]{10,64})/.exec(s);
  if (m) return m[1]!;
  return /^[A-Za-z0-9]{10,64}$/.test(s.trim()) ? s.trim() : null;
}
const fileRef = z.string().trim().max(400).refine((s) => figmaKey(s) !== null, "Share a Figma file link.");

type FigmaNode = { id: string; name: string; type: string; characters?: string; children?: FigmaNode[] };

const figmaFile: ToolDef<{ file: string }> = {
  name: "figma_file",
  description: "Read a Figma file's pages, top-level frames and their text, from a figma.com link or file key.",
  access: "read",
  input: z.object({ file: fileRef }),
  args: '{"file": figma.com link or file key}',
  async run(ctx, { file }) {
    const key = figmaKey(file)!;
    const f = await callJson<{ name: string; lastModified?: string; document?: FigmaNode }>(`${FIGMA}/files/${key}?depth=3`, { token: ctx.token, service: "Figma", forbiddenMeansAuth: true, signal: ctx.signal, timeoutMs: 25_000 }, ctx.fetch);
    const lines: string[] = [];
    for (const page of f.document?.children ?? []) {
      lines.push(`Page: ${page.name}`);
      for (const frame of page.children ?? []) {
        lines.push(`  ${frame.type.toLowerCase()}: ${frame.name}`);
        for (const child of frame.children ?? []) if (child.type === "TEXT" && child.characters) lines.push(`    “${clip(child.characters, 200)}”`);
      }
    }
    return {
      summary: `Read “${clip(f.name, 60)}”`,
      items: [{ connectorId: "figma", title: f.name, url: `https://www.figma.com/design/${key}`, snippet: `Edited ${f.lastModified?.slice(0, 10) ?? "?"} · ${f.document?.children?.length ?? 0} pages` }],
      text: clip(lines.join("\n"), 15_000),
    };
  },
};

const figmaComments: ToolDef<{ file: string }> = {
  name: "figma_comments",
  description: "Read the comments on a Figma file (who, when, text, resolved or not), from a figma.com link or file key.",
  access: "read",
  input: z.object({ file: fileRef }),
  args: '{"file": figma.com link or file key}',
  async run(ctx, { file }) {
    const key = figmaKey(file)!;
    const r = await callJson<{ comments?: { id: string; message: string; created_at: string; resolved_at?: string | null; user?: { handle?: string } }[] }>(`${FIGMA}/files/${key}/comments`, { token: ctx.token, service: "Figma", forbiddenMeansAuth: true, signal: ctx.signal }, ctx.fetch);
    const cs = r.comments ?? [];
    return {
      summary: `${cs.length} comment${cs.length === 1 ? "" : "s"}`,
      items: cs.slice(0, 30).map((c) => ({ connectorId: "figma", title: `${c.user?.handle ?? "someone"}${c.resolved_at ? " (resolved)" : ""}`, url: `https://www.figma.com/design/${key}?comment=${c.id}`, snippet: `${c.created_at.slice(0, 10)} · ${clip(c.message, 300)}` })),
    };
  },
};

export const figma: Connector = {
  meta: connectorMeta("figma")!,
  oauth: {
    authorizeUrl: "https://www.figma.com/oauth",
    tokenUrl: `${FIGMA}/oauth/token`,
    refresh: { url: `${FIGMA}/oauth/refresh`, grantType: false },
    clientIdEnv: "FIGMA_CLIENT_ID",
    clientSecretEnv: "FIGMA_CLIENT_SECRET",
    scopeSeparator: ",",
    pkce: false,
    clientAuth: "basic",
    tokenBody: "form",
  },
  async account(ctx) {
    const me = await callJson<{ email?: string; handle?: string }>(`${FIGMA}/me`, { token: ctx.token, service: "Figma", forbiddenMeansAuth: true, signal: ctx.signal }, ctx.fetch);
    return { label: me.email ?? me.handle ?? "Figma account" };
  },
  health: async (ctx) => void (await callJson(`${FIGMA}/me`, { token: ctx.token, service: "Figma", forbiddenMeansAuth: true, signal: ctx.signal }, ctx.fetch)),
  tools: [figmaFile as ToolDef, figmaComments as ToolDef],
  actions: [],
};

// ---------------------------------------------------------------- Wikipedia

const WIKI = "https://en.wikipedia.org/w/api.php";

const wikiSearch: ToolDef<{ query: string; limit?: number }> = {
  name: "wikipedia_search",
  description: "Search English Wikipedia. Returns article titles, short snippets, links and page ids.",
  access: "read",
  input: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(10).optional() }),
  args: '{"query": search words, "limit"?: 1-10}',
  async run(ctx, { query, limit }) {
    const params = new URLSearchParams({ action: "query", list: "search", srsearch: query, srlimit: String(limit ?? 5), format: "json", formatversion: "2", utf8: "1" });
    const r = await callJson<{ query?: { search?: { title: string; pageid: number; snippet: string; timestamp?: string }[] } }>(`${WIKI}?${params}`, { service: "Wikipedia", signal: ctx.signal }, ctx.fetch);
    const hits = r.query?.search ?? [];
    return {
      summary: `${hits.length} article${hits.length === 1 ? "" : "s"}`,
      items: hits.map((h) => ({
        connectorId: "wikipedia",
        title: h.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(h.title.replace(/ /g, "_"))}`,
        snippet: clip(htmlToText(h.snippet), 240),
        read: { tool: "wikipedia_read", args: { pageId: h.pageid } },
      })),
    };
  },
};

const wikiRead: ToolDef<{ pageId: number }> = {
  name: "wikipedia_read",
  description: "Read the plain text of one English Wikipedia article by page id from wikipedia_search.",
  access: "read",
  input: z.object({ pageId: z.number().int().positive().max(1e10) }),
  args: '{"pageId": number from wikipedia_search}',
  async run(ctx, { pageId }) {
    const params = new URLSearchParams({ action: "query", prop: "extracts|info", inprop: "url", explaintext: "1", exsectionformat: "plain", pageids: String(pageId), format: "json", formatversion: "2" });
    const r = await callJson<{ query?: { pages?: { pageid: number; title: string; extract?: string; fullurl?: string; missing?: boolean }[] } }>(`${WIKI}?${params}`, { service: "Wikipedia", signal: ctx.signal }, ctx.fetch);
    const p = r.query?.pages?.[0];
    if (!p || p.missing || !p.extract) throw new ConnectorError("not_found", "Wikipedia has no article with that id.");
    return {
      summary: `Read “${clip(p.title, 60)}”`,
      items: [{ connectorId: "wikipedia", title: p.title, url: p.fullurl ?? `https://en.wikipedia.org/?curid=${p.pageid}`, snippet: clip(p.extract.replace(/\s+/g, " "), 280) }],
      text: clip(p.extract, 20_000),
    };
  },
};

export const wikipedia: Connector = {
  meta: connectorMeta("wikipedia")!,
  health: async (ctx) => void (await callJson(`${WIKI}?action=query&meta=siteinfo&format=json`, { service: "Wikipedia", signal: ctx.signal }, ctx.fetch)),
  tools: [wikiSearch as ToolDef, wikiRead as ToolDef],
  actions: [],
  defaultSearch: "wikipedia_search",
};
