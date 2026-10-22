/**
 * Streamed replies: network failures and garbled lines reach the user as
 * plain sentences, not browser jargon, while a user's stop stays an abort.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { GARBLED_MESSAGE, jsonFetch, OFFLINE_MESSAGE, parseNdjsonLine, postNdjson } from "@/hooks/use-ndjson";

const collect = async (gen: AsyncGenerator<unknown>) => {
  const out: unknown[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
};
const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
      c.close();
    },
  });

afterEach(() => vi.unstubAllGlobals());

describe("streamed replies", () => {
  it("reads events split across chunks", async () => {
    vi.stubGlobal("fetch", async () => new Response(streamOf('{"type":"delta","te', 'xt":"hi"}\n{"type":"done"}\n')));
    expect(await collect(postNdjson("/api/chat", {}))).toEqual([{ type: "delta", text: "hi" }, { type: "done" }]);
  });

  it("a network failure says so plainly", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(collect(postNdjson("/api/chat", {}))).rejects.toThrow(OFFLINE_MESSAGE);
    await expect(jsonFetch("/api/x")).rejects.toThrow(OFFLINE_MESSAGE);
  });

  it("a dropped connection mid-reply says so plainly", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"type":"delta","text":"a"}\n'));
        c.error(new TypeError("network error"));
      },
    });
    vi.stubGlobal("fetch", async () => new Response(body));
    await expect(collect(postNdjson("/api/chat", {}))).rejects.toThrow(OFFLINE_MESSAGE);
  });

  it("a stop by the user stays an abort", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(collect(postNdjson("/api/chat", {}))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("a garbled line is reported in plain words", async () => {
    expect(() => parseNdjsonLine("{not json")).toThrow(GARBLED_MESSAGE);
    vi.stubGlobal("fetch", async () => new Response(streamOf("{not json\n")));
    await expect(collect(postNdjson("/api/chat", {}))).rejects.toThrow(GARBLED_MESSAGE);
  });

  it("server errors keep the server's own message", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { message: "Too many requests." } }), { status: 429 }));
    await expect(collect(postNdjson("/api/chat", {}))).rejects.toThrow("Too many requests.");
  });
});
