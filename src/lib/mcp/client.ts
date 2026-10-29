import "server-only";
import { BlockedAddressError, header, safePostJson, type SafeResponse } from "@/lib/security/net";
import { MCP_PROTOCOL_VERSION, modelToolName, parseRpcReply, parseTools, rpc, toolResultText, type McpTool } from "./protocol";

/**
 * A client for MCP servers the user connected to Orbis Code (remote servers over Streamable HTTP). Requests go only
 * to public HTTPS addresses, through the guarded POST (no internal networks, no redirects, size and time limits).
 * A session is opened per server and kept for a few minutes; listings are cached as long.
 */

export type Post = (url: string, body: unknown, headers: Record<string, string>) => Promise<Pick<SafeResponse, "status" | "body" | "headers">>;

const defaultPost: Post = (url, body, headers) => safePostJson(url, body, { headers, timeoutMs: 30_000 });

const SESSION_TTL_MS = 5 * 60_000;
/** Listing a server's tools happens every step: a slow server is left out rather than holding the step. */
const LIST_DEADLINE_MS = 15_000;

interface Session {
  id: string | null;
  at: number;
  tools: McpTool[] | null;
}

const sessions = new Map<string, Session>();

export class McpError extends Error {}

export interface McpServer {
  name: string;
  url: string;
  /** "Bearer …" for servers that need a token. */
  authorization?: string | null;
  /** Who uses the session (user and project): sessions are never shared between them. */
  scope?: string;
  /** The user added this server themselves (not a project's settings file): only then is its read-only claim believed. */
  own?: boolean;
}

export class McpClient {
  private nextId = 1;
  constructor(
    private readonly server: McpServer,
    private readonly post: Post = defaultPost,
  ) {}

  private key() {
    return `${this.server.scope ?? ""}\n${this.server.url}\n${this.server.authorization ?? ""}`;
  }

  private headers(sessionId: string | null): Record<string, string> {
    return {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      ...(this.server.authorization ? { authorization: this.server.authorization } : {}),
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    };
  }

  private async send(method: string, params: Record<string, unknown> | undefined, sessionId: string | null): Promise<{ result: unknown; sessionId: string | null }> {
    const id = this.nextId++;
    let res;
    try {
      res = await this.post(this.server.url, rpc(method, params, id), this.headers(sessionId));
    } catch (err) {
      if (err instanceof BlockedAddressError) throw new McpError("it points to a private or internal address, which Orbis never connects to");
      throw new McpError(/timeout|too long/i.test((err as Error).message) ? "the server took too long to answer" : "the server couldn't be reached");
    }
    if (res.status === 401 || res.status === 403) throw new McpError("the server refused Orbis's credentials (check the token in Settings)");
    if (res.status === 404 && sessionId) throw new McpError("session expired");
    if (res.status >= 300) throw new McpError(`the server answered with HTTP ${res.status}`);
    const reply = parseRpcReply(res.body, header(res as SafeResponse, "content-type"), id);
    if (!reply) throw new McpError("the server's reply couldn't be read");
    if (reply.error) throw new McpError(reply.error.message);
    return { result: reply.result, sessionId: header(res as SafeResponse, "mcp-session-id") ?? sessionId };
  }

  private async session(): Promise<Session> {
    const cached = sessions.get(this.key());
    if (cached && Date.now() - cached.at < SESSION_TTL_MS) return cached;
    const init = await this.send("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "orbis-code", version: "1.0" } }, null);
    const s: Session = { id: init.sessionId, at: Date.now(), tools: null };
    // The notification has no reply; a server that answers it with an error is ignored.
    await this.post(this.server.url, rpc("notifications/initialized"), this.headers(s.id)).catch(() => null);
    sessions.set(this.key(), s);
    if (sessions.size > 200) sessions.delete(sessions.keys().next().value!);
    return s;
  }

  private async withSession<T>(fn: (s: Session) => Promise<T>): Promise<T> {
    const s = await this.session();
    try {
      return await fn(s);
    } catch (err) {
      if (!(err instanceof McpError) || err.message !== "session expired") throw err;
      sessions.delete(this.key());
      return fn(await this.session());
    }
  }

  async listTools(): Promise<McpTool[]> {
    return this.withSession(async (s) => {
      if (s.tools) return s.tools;
      const r = await this.send("tools/list", undefined, s.id);
      s.tools = parseTools(r.result);
      return s.tools;
    });
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    return this.withSession(async (s) => toolResultText((await this.send("tools/call", { name: tool, arguments: args }, s.id)).result));
  }
}

export interface McpToolEntry {
  server: string;
  tool: string;
  /** Read-only, as claimed by a server the user added themselves (a project file's server is never taken at its word). */
  readOnly: boolean;
  schema: { name: string; description: string; parameters: Record<string, unknown> };
}

/**
 * Every tool of the given servers, named for the model. A server that can't be reached is left out and reported,
 * so one broken server never stops the agent.
 */
export async function collectTools(servers: McpServer[], post?: Post): Promise<{ tools: Map<string, McpToolEntry>; clients: Map<string, McpClient>; errors: { server: string; reason: string }[] }> {
  const tools = new Map<string, McpToolEntry>();
  const clients = new Map<string, McpClient>();
  const errors: { server: string; reason: string }[] = [];
  await Promise.all(
    servers.map(async (srv) => {
      const c = new McpClient(srv, post);
      try {
        const listed = await Promise.race([
          c.listTools(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new McpError("the server took too long to answer")), LIST_DEADLINE_MS)),
        ]);
        for (const t of listed) {
          const name = modelToolName(srv.name, t.name);
          if (tools.has(name)) continue;
          tools.set(name, {
            server: srv.name,
            tool: t.name,
            readOnly: t.readOnly && !!srv.own,
            schema: { name, description: `[MCP server ${srv.name}${t.readOnly ? ", read only" : ""}] ${t.description}`.slice(0, 1_100), parameters: t.inputSchema },
          });
        }
        clients.set(srv.name, c);
      } catch (err) {
        errors.push({ server: srv.name, reason: err instanceof McpError ? err.message : "it couldn't be reached" });
      }
    }),
  );
  return { tools, clients, errors };
}
