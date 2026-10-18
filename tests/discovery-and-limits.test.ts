import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDiscoveryCache,
  getModelDetail,
  normalizeDataset,
  normalizeModel,
  parseNextCursor,
  readmeExcerpt,
  searchModels,
} from "@/lib/discovery/huggingface";
import { MemoryRateLimiter } from "@/lib/rate-limit";
import { chatRequest, compareRequest, discoverQuery, searchRequest } from "@/lib/validation";
import { isSafeHttpUrl } from "@/lib/utils";

// Shape taken from a live https://huggingface.co/api/models response (Oct 2026).
const HUB_MODEL = {
  _id: "6ac87279c9d527ebb329f4d1",
  id: "Qwen/Qwen-Image-2.1-Turbo",
  author: "Qwen",
  gated: false,
  lastModified: "2026-10-12T09:45:49.000Z",
  likes: 964,
  trendingScore: 376,
  private: false,
  downloads: 20703,
  tags: ["diffusers", "safetensors", "qwen", "image-generation"],
  pipeline_tag: "text-to-image",
  library_name: "diffusers",
  createdAt: "2026-10-09T04:50:01.000Z",
  modelId: "Qwen/Qwen-Image-2.1-Turbo",
};

describe("Hugging Face discovery", () => {
  beforeEach(() => clearDiscoveryCache());
  afterEach(() => vi.unstubAllGlobals());

  it("normalises Hub model and dataset records", () => {
    expect(normalizeModel(HUB_MODEL)).toEqual({
      id: "Qwen/Qwen-Image-2.1-Turbo",
      author: "Qwen",
      task: "text-to-image",
      library: "diffusers",
      tags: ["diffusers", "safetensors", "qwen", "image-generation"],
      downloads: 20703,
      likes: 964,
      lastModified: "2026-10-12T09:45:49.000Z",
      gated: false,
      url: "https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo",
    });
    expect(normalizeModel({})).toBeNull();
    expect(normalizeDataset({ id: "org/ds", description: "  A   dataset " })).toMatchObject({ url: "https://huggingface.co/datasets/org/ds", description: "A dataset", downloads: null });
  });

  it("parses the pagination cursor from the Link header", () => {
    expect(parseNextCursor('<https://huggingface.co/api/models?cursor=abc%3D&limit=24>; rel="next"')).toBe("abc=");
    expect(parseNextCursor(null)).toBeNull();
  });

  it("builds Hub query params, returns real data shape and caches", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify([HUB_MODEL]), { headers: { link: '<https://huggingface.co/api/models?cursor=NEXT>; rel="next"' } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const page = await searchModels({ search: "qwen", task: "text-to-image", library: "diffusers", sort: "downloads", limit: 5 }, "hf_x");
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBe("NEXT");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.pathname).toBe("/api/models");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ search: "qwen", pipeline_tag: "text-to-image", library: "diffusers", sort: "downloads", direction: "-1", limit: "5" });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer hf_x");
    await searchModels({ search: "qwen", task: "text-to-image", library: "diffusers", sort: "downloads", limit: 5 }, "hf_x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps Hub rate limits to a helpful error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    await expect(searchModels({ search: "x" })).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("rejects path-traversal model ids", async () => {
    await expect(getModelDetail("../../etc/passwd")).rejects.toMatchObject({ code: "bad_request" });
    await expect(getModelDetail("a/b/c")).rejects.toMatchObject({ code: "bad_request" });
  });

  it("extracts a plain-text summary from a model card", () => {
    const md = `---\nlicense: mit\n---\n# Title\n\n![badge](x.png)\n\nThis model is a **compact** [language model](https://x) trained for summarisation tasks across many domains.\n\n## Usage`;
    expect(readmeExcerpt(md)).toBe("This model is a compact language model trained for summarisation tasks across many domains.");
  });
});

describe("rate limiter", () => {
  it("allows up to the limit per window, then resets", () => {
    let now = 0;
    const l = new MemoryRateLimiter(3, 1000, () => now);
    expect([l.check("a").ok, l.check("a").ok, l.check("a").ok, l.check("a").ok]).toEqual([true, true, true, false]);
    expect(l.check("b").ok).toBe(true);
    now = 1001;
    expect(l.check("a").ok).toBe(true);
  });
  it("supports weighted costs (multi-model battles)", () => {
    const l = new MemoryRateLimiter(5, 1000, () => 0);
    expect(l.check("u", 3).ok).toBe(true);
    expect(l.check("u", 3).ok).toBe(false);
    expect(l.check("u", 2).ok).toBe(true);
  });
});

describe("validation", () => {
  it("validates search requests", () => {
    expect(searchRequest.safeParse({ query: "a" }).success).toBe(false);
    expect(searchRequest.safeParse({ query: "x".repeat(501) }).success).toBe(false);
    expect(searchRequest.safeParse({ query: "  What is RAG?  ", projectId: null }).data?.query).toBe("What is RAG?");
    expect(searchRequest.safeParse({ query: "ok query", projectId: "not-a-uuid" }).success).toBe(false);
  });
  it("restricts chat attachments by type and size", () => {
    const base = { message: "hi" };
    expect(chatRequest.safeParse({ ...base, attachments: [{ name: "a.exe", content: "x" }] }).success).toBe(false);
    expect(chatRequest.safeParse({ ...base, attachments: [{ name: "notes.md", content: "x".repeat(60_001) }] }).success).toBe(false);
    expect(chatRequest.safeParse({ ...base, attachments: [{ name: "notes.md", content: "# hi" }] }).success).toBe(true);
    expect(chatRequest.safeParse({ ...base, mode: "hacker" }).success).toBe(false);
    expect(chatRequest.parse(base).mode).toBe("research");
  });
  it("requires 2–6 models for comparisons", () => {
    expect(compareRequest.safeParse({ prompt: "p", modelIds: ["a"] }).success).toBe(false);
    expect(compareRequest.safeParse({ prompt: "p", modelIds: ["a", "b"] }).success).toBe(true);
    expect(compareRequest.safeParse({ prompt: "p", modelIds: Array(7).fill("x") }).success).toBe(false);
  });
  it("rejects injection-shaped discovery params", () => {
    expect(discoverQuery.safeParse({ task: "text-generation&x=1" }).success).toBe(false);
    expect(discoverQuery.safeParse({ cursor: "abc<script>" }).success).toBe(false);
    expect(discoverQuery.safeParse({ limit: "500" }).success).toBe(false);
    expect(discoverQuery.parse({ limit: "10", sort: "likes" })).toEqual({ limit: 10, sort: "likes" });
  });
  it("only treats http(s) URLs as safe links", () => {
    expect(isSafeHttpUrl("https://x.com")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,hi")).toBe(false);
    expect(isSafeHttpUrl(42)).toBe(false);
  });
});
