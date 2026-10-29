/**
 * MCP over Streamable HTTP (JSON and server-sent-event replies, sessions, tool listings and results, errors) with
 * the transport faked; and compacting a session's conversation into its first message plus a summary.
 */
import { describe, expect, it, vi } from "vitest";
import { cleanSchema, modelToolName, parseRpcReply, parseTools, toolResultText } from "@/lib/mcp/protocol";
import { collectTools, McpClient, type Post } from "@/lib/mcp/client";
import { applyCompaction, compactionInput, shouldAutoCompact } from "@/lib/code/agent/compact";
import type { TranscriptMessage } from "@/lib/code/agent/protocol";

vi.mock("server-only", () => ({}));

describe("MCP messages", () => {
  it("read replies sent as JSON, as a batch, or as an event stream", () => {
    expect(parseRpcReply(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { ok: 1 } }), "application/json", 3)).toEqual({ result: { ok: 1 } });
    expect(parseRpcReply(JSON.stringify([{ id: 1, result: "a" }, { id: 2, result: "b" }]), "application/json", 2)).toEqual({ result: "b" });
    const sse = `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"tools":[]}}\n\n`;
    expect(parseRpcReply(sse, "text/event-stream", 7)).toEqual({ result: { tools: [] } });
    expect(parseRpcReply(JSON.stringify({ id: 4, error: { code: -32601, message: "Method not found" } }), "application/json", 4)).toEqual({ error: { code: -32601, message: "Method not found" } });
    expect(parseRpcReply("<html>", "text/html", 1)).toBeNull();
    expect(parseRpcReply(JSON.stringify({ id: 9, result: 1 }), "application/json", 1)).toBeNull();
  });

  it("keep well-formed tools only, with schemas the providers accept", () => {
    const tools = parseTools({
      tools: [
        { name: "create_issue", description: "Create an issue", inputSchema: { $schema: "x", type: "object", properties: { title: { type: "string" } } } },
        { name: "search", annotations: { readOnlyHint: true }, inputSchema: { type: "string" } },
        { name: "bad name!", inputSchema: {} },
        { description: "no name" },
      ],
    });
    expect(tools.map((t) => [t.name, t.readOnly])).toEqual([
      ["create_issue", false],
      ["search", true],
    ]);
    expect(tools[0]!.inputSchema).toEqual({ type: "object", properties: { title: { type: "string" } } });
    expect(tools[1]!.inputSchema).toEqual({ type: "object", properties: {} });
    expect(cleanSchema(null)).toEqual({ type: "object", properties: {} });
    expect(parseTools({ tools: "nope" })).toEqual([]);
  });

  it("turn results into text and name tools for the model", () => {
    expect(toolResultText({ content: [{ type: "text", text: "Done" }, { type: "image", mimeType: "image/png", data: "…" }] })).toEqual({ ok: true, text: "Done\n\n(image image/png not shown)" });
    expect(toolResultText({ isError: true, content: [{ type: "text", text: "Not allowed" }] })).toEqual({ ok: false, text: "Not allowed" });
    expect(toolResultText({ structuredContent: { n: 2 } })).toEqual({ ok: true, text: '{"n":2}' });
    expect(modelToolName("github", "create.issue")).toBe("mcp__github__create_issue");
    expect(modelToolName("s", "x".repeat(100))).toHaveLength(64);
  });
});

describe("the MCP client", () => {
  /** A tiny MCP server: answers initialize with a session id, lists two tools, runs them, and can expire the session once. */
  function fakeServer(o: { expireOnce?: boolean; status?: number } = {}) {
    const calls: { method: string; session: string | undefined; auth: string | undefined }[] = [];
    let expired = !o.expireOnce;
    let sessions = 0;
    const post: Post = async (_url, body, headers) => {
      const msg = body as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      calls.push({ method: msg.method, session: headers["mcp-session-id"], auth: headers.authorization });
      if (o.status) return { status: o.status, body: "", headers: {} };
      if (msg.method === "initialize") return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18" } }), headers: { "content-type": "application/json", "mcp-session-id": `s${++sessions}` } };
      if (msg.id === undefined) return { status: 202, body: "", headers: {} };
      if (!expired && msg.method === "tools/call") {
        expired = true;
        return { status: 404, body: "", headers: {} };
      }
      if (msg.method === "tools/list")
        return { status: 200, body: `data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }, { name: "read", annotations: { readOnlyHint: true }, inputSchema: { type: "object" } }] } })}\n\n`, headers: { "content-type": "text/event-stream" } };
      if (msg.method === "tools/call") return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `echo ${JSON.stringify(msg.params?.arguments)}` }] } }), headers: { "content-type": "application/json" } };
      return { status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown" } }), headers: { "content-type": "application/json" } };
    };
    return { post, calls };
  }

  it("opens a session, lists tools and calls them with the session and token", async () => {
    const { post, calls } = fakeServer();
    const c = new McpClient({ name: "t1", url: "https://mcp.example.com/a", authorization: "Bearer abc" }, post);
    expect((await c.listTools()).map((t) => t.name)).toEqual(["echo", "read"]);
    expect(await c.callTool("echo", { x: 1 })).toEqual({ ok: true, text: 'echo {"x":1}' });
    expect(calls.map((x) => x.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(calls.slice(1).every((x) => x.session === "s1" && x.auth === "Bearer abc")).toBe(true);
  });

  it("opens a new session when the server forgets the old one", async () => {
    const { post, calls } = fakeServer({ expireOnce: true });
    const c = new McpClient({ name: "t2", url: "https://mcp.example.com/b" }, post);
    expect((await c.callTool("echo", { y: 2 })).ok).toBe(true);
    expect(calls.filter((x) => x.method === "initialize")).toHaveLength(2);
  });

  it("reports an unreachable or refusing server without stopping the others", async () => {
    const good = fakeServer();
    const bad = fakeServer({ status: 401 });
    const post: Post = (url, body, headers) => (url.includes("bad") ? bad.post(url, body, headers) : good.post(url, body, headers));
    const r = await collectTools(
      [
        { name: "good", url: "https://mcp.example.com/good" },
        { name: "bad", url: "https://mcp.example.com/bad" },
      ],
      post,
    );
    expect([...r.tools.keys()]).toEqual(["mcp__good__echo", "mcp__good__read"]);
    expect(r.tools.get("mcp__good__read")).toMatchObject({ server: "good", tool: "read", readOnly: true });
    expect(r.errors).toEqual([{ server: "bad", reason: "the server refused Orbis's credentials (check the token in Settings)" }]);
  });
});

describe("compacting a session", () => {
  const msg = (role: "user" | "assistant", content: string): TranscriptMessage => ({ role, content });
  const long = [msg("user", "Request: add login\n\nFiles: …"), ...Array.from({ length: 12 }, (_, i) => msg(i % 2 ? "user" : "assistant", `step ${i} ${"x".repeat(1_000)}`))];

  it("starts once the conversation fills 90% of its room", () => {
    expect(shouldAutoCompact(long, 20_000)).toBe(false);
    expect(shouldAutoCompact(long, 12_000)).toBe(true);
    expect(shouldAutoCompact(long.slice(0, 4), 100)).toBe(false); // too short to be worth it
  });

  it("summarises what happened after the first message, newest first when it's too long, keeping what the user asked for", () => {
    const input = compactionInput(long, "the auth decisions", 5_000);
    expect(input).toContain("keep in particular: the auth decisions");
    expect(input).toContain("step 11");
    expect(input).not.toContain("step 0 ");
    expect(input).not.toContain("Request: add login");
  });

  it("keeps the first message and replaces any earlier summary", () => {
    const once = applyCompaction(long, "Did A and B.");
    expect(once).toHaveLength(1);
    expect(once[0]!.content).toContain("Request: add login");
    expect(once[0]!.content).toContain("<session-summary>\nDid A and B.\n</session-summary>");
    const twice = applyCompaction([...once, msg("assistant", "more"), msg("user", "results")], "Did A, B and C.");
    expect(twice[0]!.content.match(/<session-summary>/g)).toHaveLength(1);
    expect(twice[0]!.content).toContain("Did A, B and C.");
  });
});
