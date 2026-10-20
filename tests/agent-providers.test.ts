/**
 * Native tool calling for the coding agent: the neutral conversation turned
 * into each provider's format, and each provider's reply read back — tool
 * calls, why it stopped, usage — with errors mapped to safe messages. The
 * APIs are mocked; live calls are covered by the acceptance run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo, ToolMessage } from "@/lib/ai/types";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  class APIError extends Error {
    constructor(
      public status: number | undefined,
      message = "error",
    ) {
      super(message);
    }
  }
  class RateLimitError extends APIError {}
  class AuthenticationError extends APIError {}
  class PermissionDeniedError extends APIError {}
  class APIUserAbortError extends Error {}
  class APIConnectionTimeoutError extends Error {}
  class Anthropic {
    static APIError = APIError;
    static RateLimitError = RateLimitError;
    static AuthenticationError = AuthenticationError;
    static PermissionDeniedError = PermissionDeniedError;
    static APIUserAbortError = APIUserAbortError;
    static APIConnectionTimeoutError = APIConnectionTimeoutError;
    beta = { messages: { create } };
  }
  return { default: Anthropic };
});

const { AnthropicProvider, toAnthropicToolMessages } = await import("@/lib/ai/providers/anthropic");
const { OpenAICompatibleProvider, toOpenAIToolMessages } = await import("@/lib/ai/providers/openai-compatible");
const Anthropic = (await import("@anthropic-ai/sdk")).default as unknown as { RateLimitError: new (s: number, m?: string) => Error; AuthenticationError: new (s: number, m?: string) => Error };

const model = (provider: "anthropic" | "openai", id: string): ModelInfo => ({
  id,
  provider,
  providerModelId: id,
  displayName: id,
  description: "",
  capabilities: ["coding"],
  contextWindow: 200_000,
  inputPrice: 1,
  outputPrice: 5,
  isEnabled: true,
  lastVerifiedAt: null,
});

const conversation: ToolMessage[] = [
  { role: "user", text: "Fix the sum function." },
  {
    role: "assistant",
    text: "Reading it.",
    calls: [
      { id: "call_1", name: "read_files", args: { paths: ["sum.js"] } },
      { id: "call_2", name: "run_tests", args: {} },
    ],
  },
  {
    role: "user",
    text: "The user approved your plan.",
    results: [
      { id: "call_1", ok: true, text: "<file>…</file>" },
      { id: "call_2", ok: false, text: "Tests failed" },
    ],
  },
];
const tools = [{ name: "read_files", description: "Read files", parameters: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } }, required: ["paths"] } }];

describe("conversation formats", () => {
  it("become Messages API turns: tool_use blocks, then one tool_result per call with failures flagged", () => {
    expect(toAnthropicToolMessages(conversation)).toEqual([
      { role: "user", content: [{ type: "text", text: "Fix the sum function." }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Reading it." },
          { type: "tool_use", id: "call_1", name: "read_files", input: { paths: ["sum.js"] } },
          { type: "tool_use", id: "call_2", name: "run_tests", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "<file>…</file>" },
          { type: "tool_result", tool_use_id: "call_2", content: "Tests failed", is_error: true },
          { type: "text", text: "The user approved your plan." },
        ],
      },
    ]);
  });

  it("become Chat Completions messages: tool_calls, then a tool message per call, then the user's text", () => {
    expect(toOpenAIToolMessages(conversation)).toEqual([
      { role: "user", content: "Fix the sum function." },
      {
        role: "assistant",
        content: "Reading it.",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_files", arguments: '{"paths":["sum.js"]}' } },
          { id: "call_2", type: "function", function: { name: "run_tests", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "<file>…</file>" },
      { role: "tool", tool_call_id: "call_2", content: "[failed] Tests failed" },
      { role: "user", content: "The user approved your plan." },
    ]);
  });
});

describe("Claude tool turns", () => {
  const provider = new AnthropicProvider(() => "sk-ant-test");
  beforeEach(() => create.mockReset());

  it("sends the tools with automatic choice and keeps thinking within the output limit", async () => {
    create.mockResolvedValue({
      model: "claude-haiku-5-5",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "toolu_1", name: "read_files", input: { paths: ["sum.js"] } },
      ],
      usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
    const r = await provider.toolTurn({ model: model("anthropic", "claude-haiku-5-5"), system: "You are the agent.", messages: conversation, tools, maxOutputTokens: 1200 });
    expect(r).toEqual({
      text: "Let me look.",
      calls: [{ id: "toolu_1", name: "read_files", args: { paths: ["sum.js"] } }],
      usage: { inputTokens: 1200, outputTokens: 80, estimated: false, cachedInputTokens: 0, cacheWriteInputTokens: 0 },
      servedModel: "claude-haiku-5-5",
      stop: "tool_use",
    });
    const body = create.mock.calls[0]![0];
    expect(body).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 1200, system: "You are the agent.", tool_choice: { type: "auto" }, thinking: { type: "disabled" } });
    expect(body.tools).toEqual([{ name: "read_files", description: "Read files", input_schema: tools[0]!.parameters }]);
    expect(body).not.toHaveProperty("temperature");

    await provider.toolTurn({ model: model("anthropic", "claude-sonnet-5-5"), system: "s", messages: conversation, tools, maxOutputTokens: 2400 });
    expect(create.mock.calls[1]![0]).toMatchObject({ thinking: { type: "between_tools" } });
    await provider.toolTurn({ model: model("anthropic", "claude-opus-5-5"), system: "s", messages: conversation, tools, maxOutputTokens: 4800 });
    expect(create.mock.calls[2]![0]).toMatchObject({ output_config: { effort: "low" } });
    expect(create.mock.calls[2]![0]).not.toHaveProperty("thinking");
  });

  it("reports a reply cut off at the output limit, and a refusal", async () => {
    create.mockResolvedValueOnce({ model: "m", stop_reason: "max_tokens", content: [{ type: "text", text: "partial" }], usage: { input_tokens: 1, output_tokens: 1 } });
    expect((await provider.toolTurn({ model: model("anthropic", "claude-haiku-5-5"), system: "s", messages: conversation, tools, maxOutputTokens: 10 })).stop).toBe("max_tokens");
    create.mockResolvedValueOnce({ model: "m", stop_reason: "refusal", content: [], usage: { input_tokens: 1, output_tokens: 0 } });
    expect((await provider.toolTurn({ model: model("anthropic", "claude-haiku-5-5"), system: "s", messages: conversation, tools, maxOutputTokens: 10 })).stop).toBe("refusal");
  });

  it("maps API errors to messages that don't leak provider details", async () => {
    create.mockRejectedValueOnce(new Anthropic.RateLimitError(429, "rate limited for org-123"));
    await expect(provider.toolTurn({ model: model("anthropic", "claude-haiku-5-5"), system: "s", messages: conversation, tools, maxOutputTokens: 10 })).rejects.toMatchObject({ code: "rate_limited" });
    create.mockRejectedValueOnce(new Anthropic.AuthenticationError(401, "invalid x-api-key sk-ant-test"));
    const err = await provider.toolTurn({ model: model("anthropic", "claude-haiku-5-5"), system: "s", messages: conversation, tools, maxOutputTokens: 10 }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: "not_configured" });
    expect((err as Error).message).not.toContain("sk-ant-test");
  });
});

describe("GPT tool turns", () => {
  const provider = new OpenAICompatibleProvider("openai", { baseUrl: "https://api.openai.test/v1", apiKey: () => "sk-test", envVar: "OPENAI_API_KEY" });
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends functions and reads tool calls, including arguments that aren't valid JSON", async () => {
    fetchMock.mockResolvedValue(
      reply({
        model: "gpt-5.6-luna-2026",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                { id: "call_a", type: "function", function: { name: "read_files", arguments: '{"paths":["sum.js"]}' } },
                { id: "call_b", type: "function", function: { name: "run_tests", arguments: "{not json" } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 100 } },
      }),
    );
    const r = await provider.toolTurn({ model: model("openai", "gpt-5.6-luna"), system: "You are the agent.", messages: conversation, tools, maxOutputTokens: 1200 });
    expect(r).toMatchObject({
      text: "",
      calls: [
        { id: "call_a", name: "read_files", args: { paths: ["sum.js"] } },
        { id: "call_b", name: "run_tests", args: null },
      ],
      usage: { inputTokens: 900, outputTokens: 40, cachedInputTokens: 100 },
      servedModel: "gpt-5.6-luna-2026",
      stop: "tool_use",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.test/v1/chat/completions");
    const body = JSON.parse(init.body);
    // Function tools on Chat Completions need reasoning off for OpenAI's reasoning models.
    expect(body).toMatchObject({ model: "gpt-5.6-luna", tool_choice: "auto", max_completion_tokens: 1200, reasoning_effort: "none" });
    expect(body.messages[0]).toEqual({ role: "system", content: "You are the agent." });
    expect(body.tools[0]).toEqual({ type: "function", function: { name: "read_files", description: "Read files", parameters: tools[0]!.parameters } });
    expect(init.headers.Authorization).toBe("Bearer sk-test");
  });

  it("reports the end of a turn, a cut-off reply and a refusal", async () => {
    fetchMock.mockResolvedValueOnce(reply({ choices: [{ finish_reason: "stop", message: { content: "All done." } }] }));
    expect(await provider.toolTurn({ model: model("openai", "gpt-5.6-luna"), system: "s", messages: conversation, tools, maxOutputTokens: 10 })).toMatchObject({
      text: "All done.",
      calls: [],
      stop: "end_turn",
    });
    fetchMock.mockResolvedValueOnce(reply({ choices: [{ finish_reason: "length", message: { content: "par" } }] }));
    expect((await provider.toolTurn({ model: model("openai", "gpt-5.6-luna"), system: "s", messages: conversation, tools, maxOutputTokens: 10 })).stop).toBe("max_tokens");
    fetchMock.mockResolvedValueOnce(reply({ choices: [{ finish_reason: "stop", message: { content: null, refusal: "I can't help with that." } }] }));
    expect((await provider.toolTurn({ model: model("openai", "gpt-5.6-luna"), system: "s", messages: conversation, tools, maxOutputTokens: 10 })).stop).toBe("refusal");
  });

  it("retries a transient failure once, and never shows the provider's error details", async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: { message: "overloaded" } }, 503)).mockResolvedValueOnce(reply({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }));
    expect((await provider.toolTurn({ model: model("openai", "gpt-5.6-luna"), system: "s", messages: conversation, tools, maxOutputTokens: 10 })).text).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockResolvedValue(reply({ error: { message: "Incorrect API key provided: sk-test" } }, 401));
    const err = await provider.toolTurn({ model: model("openai", "gpt-5.6-luna"), system: "s", messages: conversation, tools, maxOutputTokens: 10 }).catch((e: Error) => e);
    expect(err).toMatchObject({ code: "not_configured" });
    expect((err as Error).message).not.toContain("sk-test");
  });
});
