import { ApiError } from "../http";
import { domainOf, isSafeHttpUrl } from "../utils";
import type { SearchProviderResult, SearchSource } from "./types";

const MAX_SNIPPET = 700;

function clip(s: unknown, n: number): string {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Normalise raw results: drop unsafe/duplicate URLs, clip text, number them 1..n. */
export function normalizeSources(
  raw: { url?: unknown; title?: unknown; snippet?: unknown; publishedAt?: unknown }[],
  limit = 8,
): SearchSource[] {
  const seen = new Set<string>();
  const out: SearchSource[] = [];
  for (const r of raw) {
    if (!isSafeHttpUrl(r.url)) continue;
    const key = r.url.replace(/#.*$/, "").replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const published = typeof r.publishedAt === "string" && !Number.isNaN(Date.parse(r.publishedAt)) ? r.publishedAt : null;
    out.push({
      index: out.length + 1,
      url: r.url,
      title: clip(r.title, 200) || domainOf(r.url),
      snippet: clip(r.snippet, MAX_SNIPPET),
      domain: domainOf(r.url),
      publishedAt: published,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchJson(url: string, init: RequestInit, label: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if ((err as Error)?.name === "TimeoutError" || init.signal?.aborted) {
      throw new ApiError("timeout", `${label} search timed out.`);
    }
    throw new ApiError("upstream_error", `Could not reach the ${label} search API.`);
  }
  if (!res.ok) {
    const code = res.status === 401 || res.status === 403 ? "not_configured" : res.status === 429 ? "rate_limited" : "upstream_error";
    throw new ApiError(code, `${label} search returned HTTP ${res.status}.`);
  }
  return res.json();
}

export async function tavilySearch(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchProviderResult> {
  const j = (await fetchJson(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, search_depth: "basic", max_results: 8, include_published_date: true }),
      signal,
    },
    "Tavily",
  )) as { results?: { url?: string; title?: string; content?: string; published_date?: string | null }[] };
  return {
    provider: "tavily",
    sources: normalizeSources(
      (j.results ?? []).map((r) => ({ url: r.url, title: r.title, snippet: r.content, publishedAt: r.published_date })),
    ),
  };
}

export async function braveSearch(query: string, apiKey: string, signal?: AbortSignal): Promise<SearchProviderResult> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`;
  const j = (await fetchJson(
    url,
    { headers: { Accept: "application/json", "X-Subscription-Token": apiKey }, signal },
    "Brave",
  )) as { web?: { results?: { url?: string; title?: string; description?: string; page_age?: string; age?: string }[] } };
  return {
    provider: "brave",
    sources: normalizeSources(
      (j.web?.results ?? []).map((r) => ({
        url: r.url,
        title: r.title,
        // Brave wraps matches in <strong>; strip tags so we never render HTML from the web.
        snippet: r.description?.replace(/<[^>]+>/g, ""),
        publishedAt: r.page_age,
      })),
    ),
  };
}

export async function webSearch(
  query: string,
  config: { provider: string; apiKey?: string },
  signal?: AbortSignal,
): Promise<SearchProviderResult> {
  if (!config.apiKey) {
    throw new ApiError("not_configured", "Web search is not configured. Set SEARCH_PROVIDER and SEARCH_API_KEY.");
  }
  if (config.provider === "tavily") return tavilySearch(query, config.apiKey, signal);
  if (config.provider === "brave") return braveSearch(query, config.apiKey, signal);
  throw new ApiError("not_configured", `Unsupported SEARCH_PROVIDER "${config.provider}". Use "tavily" or "brave".`);
}
