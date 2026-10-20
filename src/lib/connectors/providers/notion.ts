import "server-only";
import { z } from "zod";
import { connectorMeta } from "../catalog";
import { callJson, clip } from "../http";
import { standardToken } from "../oauth";
import type { Connector, ToolContext, ToolDef } from "../types";

/**
 * Notion, as a public connection (OAuth). People choose which pages Orbis
 * may see when they connect; the API only returns those. Read-only.
 */

const API = "https://api.notion.com/v1";
/** A stable API version whose response shapes this code reads. */
const VERSION = "2022-06-28";
const headers = { "Notion-Version": VERSION };

type RichText = { plain_text?: string };
type Page = { id: string; object: string; url?: string; last_edited_time?: string; properties?: Record<string, { type?: string; title?: RichText[] }> };
type Block = { id: string; type: string; has_children?: boolean } & Record<string, unknown>;

export function pageTitle(p: Page): string {
  const t = Object.values(p.properties ?? {}).find((v) => v.type === "title");
  return t?.title?.map((r) => r.plain_text ?? "").join("").trim() || "Untitled";
}

const PREFIX: Record<string, string> = { heading_1: "# ", heading_2: "## ", heading_3: "### ", bulleted_list_item: "- ", numbered_list_item: "1. ", quote: "> ", to_do: "[ ] ", callout: "", paragraph: "", toggle: "", code: "" };

/** A block's text in Markdown-ish form, or null for blocks without text. */
export function blockText(b: Block): string | null {
  const body = b[b.type] as { rich_text?: RichText[]; checked?: boolean } | undefined;
  if (!body?.rich_text || !(b.type in PREFIX)) return null;
  const text = body.rich_text.map((r) => r.plain_text ?? "").join("");
  const prefix = b.type === "to_do" ? (body.checked ? "[x] " : "[ ] ") : PREFIX[b.type];
  return b.type === "code" ? `\`\`\`\n${text}\n\`\`\`` : `${prefix}${text}`;
}

async function children(ctx: ToolContext, id: string, depth: number, budget: { blocks: number }): Promise<string[]> {
  if (budget.blocks <= 0) return [];
  const r = await callJson<{ results?: Block[] }>(`${API}/blocks/${id}/children?page_size=100`, { token: ctx.token, headers, service: "Notion", signal: ctx.signal }, ctx.fetch);
  const out: string[] = [];
  for (const b of r.results ?? []) {
    if (budget.blocks-- <= 0) break;
    const t = blockText(b);
    if (t !== null) out.push(`${"  ".repeat(depth)}${t}`);
    if (b.has_children && depth < 2 && b.type !== "child_page") out.push(...(await children(ctx, b.id, depth + 1, budget)));
  }
  return out;
}

const notionSearch: ToolDef<{ query: string; limit?: number }> = {
  name: "notion_search",
  description: "Search the Notion pages the user shared with Orbis by title. Returns titles, links, last edit dates and page ids.",
  access: "read",
  input: z.object({ query: z.string().trim().max(200), limit: z.number().int().min(1).max(10).optional() }),
  args: '{"query": words in the page title, "limit"?: 1-10}',
  async run(ctx, { query, limit }) {
    const r = await callJson<{ results?: Page[] }>(
      `${API}/search`,
      { method: "POST", token: ctx.token, headers, json: { query, page_size: limit ?? 8, filter: { property: "object", value: "page" }, sort: { direction: "descending", timestamp: "last_edited_time" } }, service: "Notion", signal: ctx.signal },
      ctx.fetch,
    );
    const pages = r.results ?? [];
    return {
      summary: `${pages.length} page${pages.length === 1 ? "" : "s"}`,
      items: pages.map((p) => ({ connectorId: "notion", title: pageTitle(p), url: p.url ?? null, snippet: `Edited ${p.last_edited_time?.slice(0, 10) ?? "?"}`, read: { tool: "notion_read_page", args: { pageId: p.id } } })),
    };
  },
};

const notionRead: ToolDef<{ pageId: string }> = {
  name: "notion_read_page",
  description: "Read a Notion page's text (headings, paragraphs, lists, to-dos, code) by page id from notion_search.",
  access: "read",
  input: z.object({ pageId: z.string().regex(/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i, "Use a page id from a Notion search.") }),
  args: '{"pageId": page id from notion_search}',
  async run(ctx, { pageId }) {
    const page = await callJson<Page>(`${API}/pages/${pageId}`, { token: ctx.token, headers, service: "Notion", signal: ctx.signal }, ctx.fetch);
    const lines = await children(ctx, pageId, 0, { blocks: 400 });
    const text = lines.join("\n");
    return {
      summary: `Read “${clip(pageTitle(page), 60)}”`,
      items: [{ connectorId: "notion", title: pageTitle(page), url: page.url ?? null, snippet: clip(text.replace(/\s+/g, " "), 280) }],
      text: clip(text, 20_000),
    };
  },
};

export const notion: Connector = {
  meta: connectorMeta("notion")!,
  oauth: {
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    clientIdEnv: "NOTION_OAUTH_CLIENT_ID",
    clientSecretEnv: "NOTION_OAUTH_CLIENT_SECRET",
    pkce: false,
    clientAuth: "basic",
    tokenBody: "json",
    extraAuthParams: { owner: "user" },
    parseToken(j) {
      const t = standardToken(j);
      const owner = (j.owner ?? {}) as { user?: { name?: string; person?: { email?: string } } };
      const extra: Record<string, string> = {};
      if (typeof j.workspace_name === "string") extra.workspace = j.workspace_name;
      const who = owner.user?.person?.email ?? owner.user?.name;
      if (who) extra.user = who;
      return { ...t, extra };
    },
  },
  async account(_ctx, tokens) {
    const ws = tokens.extra?.workspace ?? "Notion workspace";
    return { label: tokens.extra?.user ? `${tokens.extra.user} · ${ws}` : ws };
  },
  health: async (ctx) => void (await callJson(`${API}/users/me`, { token: ctx.token, headers, service: "Notion", signal: ctx.signal }, ctx.fetch)),
  tools: [notionSearch as ToolDef, notionRead as ToolDef],
  actions: [],
  defaultSearch: "notion_search",
};
