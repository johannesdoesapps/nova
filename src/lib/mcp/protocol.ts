/**
 * The parts of the Model Context Protocol Orbis uses, as pure functions: JSON-RPC messages over Streamable HTTP
 * (a reply is either JSON or a short server-sent-events stream), tool listings and tool results, and how a
 * server's tool is named and described to the coding agent's model.
 */

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcReply {
  result?: unknown;
  error?: { code: number; message: string };
}

export function rpc(method: string, params?: Record<string, unknown>, id?: number): RpcRequest {
  return { jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) };
}

/** The reply to request `id` in a response body (JSON, a JSON batch, or an SSE stream of JSON messages). */
export function parseRpcReply(body: string, contentType: string | null, id: number): RpcReply | null {
  const messages: unknown[] = [];
  if ((contentType ?? "").includes("text/event-stream")) {
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        messages.push(JSON.parse(data));
      } catch {
        /* not a message */
      }
    }
  } else {
    try {
      const v = JSON.parse(body) as unknown;
      messages.push(...(Array.isArray(v) ? v : [v]));
    } catch {
      return null;
    }
  }
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const r = m as { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    if (r.id !== id) continue;
    if (r.error) return { error: { code: typeof r.error.code === "number" ? r.error.code : -32000, message: typeof r.error.message === "string" ? r.error.message.slice(0, 500) : "error" } };
    return { result: r.result };
  }
  return null;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The server says the tool only reads (annotations.readOnlyHint). */
  readOnly: boolean;
}

const MAX_TOOLS = 40;

/** A tools/list result: well-formed tools only, at most 40. */
export function parseTools(result: unknown): McpTool[] {
  const list = result && typeof result === "object" ? (result as { tools?: unknown }).tools : null;
  if (!Array.isArray(list)) return [];
  const out: McpTool[] = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const r = t as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } };
    if (typeof r.name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(r.name)) continue;
    out.push({
      name: r.name,
      description: typeof r.description === "string" ? r.description.slice(0, 1_000) : "",
      inputSchema: cleanSchema(r.inputSchema),
      readOnly: r.annotations?.readOnlyHint === true,
    });
    if (out.length >= MAX_TOOLS) break;
  }
  return out;
}

/** An input schema the providers accept: always an object schema, without $schema, within a size limit. */
export function cleanSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {} };
  const s = { ...(schema as Record<string, unknown>) };
  delete s.$schema;
  if (s.type !== "object") return { type: "object", properties: {} };
  if (JSON.stringify(s).length > 16_000) return { type: "object", properties: {}, additionalProperties: true };
  return s;
}

/** A tools/call result as text for the agent: text parts in full, other parts named. */
export function toolResultText(result: unknown): { ok: boolean; text: string } {
  if (!result || typeof result !== "object") return { ok: false, text: "The server returned nothing." };
  const r = result as { content?: unknown; isError?: unknown; structuredContent?: unknown };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const c of r.content) {
      if (!c || typeof c !== "object") continue;
      const p = c as { type?: unknown; text?: unknown; resource?: { uri?: unknown; text?: unknown }; mimeType?: unknown };
      if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
      else if (p.type === "resource" && p.resource && typeof p.resource.text === "string") parts.push(`[${String(p.resource.uri ?? "resource")}]\n${p.resource.text}`);
      else parts.push(`(${String(p.type ?? "content")}${typeof p.mimeType === "string" ? ` ${p.mimeType}` : ""} not shown)`);
    }
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  return { ok: r.isError !== true, text: parts.join("\n\n") || "(no output)" };
}

/** The name the agent's model sees for a server's tool: mcp__<server>__<tool>, within providers' 64-character limit. */
export function modelToolName(server: string, tool: string): string {
  const t = tool.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${server}__${t}`.slice(0, 64);
}
