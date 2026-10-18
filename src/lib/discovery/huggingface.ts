import { ApiError } from "../http";

const HUB = "https://huggingface.co";

export const HF_TASKS = [
  { value: "text-generation", label: "Language models" },
  { value: "text-to-image", label: "Image generation" },
  { value: "automatic-speech-recognition", label: "Speech recognition" },
  { value: "text-to-speech", label: "Text-to-speech" },
  { value: "feature-extraction", label: "Embeddings" },
  { value: "sentence-similarity", label: "Sentence similarity" },
  { value: "image-classification", label: "Image classification" },
  { value: "object-detection", label: "Object detection" },
  { value: "image-text-to-text", label: "Vision-language" },
  { value: "translation", label: "Translation" },
  { value: "summarization", label: "Summarization" },
] as const;

export const HF_LIBRARIES = ["transformers", "diffusers", "gguf", "sentence-transformers", "mlx", "onnx", "pytorch", "safetensors"] as const;
export const HF_SORTS = ["trendingScore", "downloads", "likes", "lastModified", "createdAt"] as const;

export interface HubModel {
  id: string;
  author: string | null;
  task: string | null;
  library: string | null;
  tags: string[];
  downloads: number | null;
  likes: number | null;
  lastModified: string | null;
  gated: boolean;
  url: string;
}

export interface HubDataset {
  id: string;
  author: string | null;
  description: string | null;
  tags: string[];
  downloads: number | null;
  likes: number | null;
  lastModified: string | null;
  gated: boolean;
  url: string;
}

export interface HubPage<T> {
  items: T[];
  nextCursor: string | null;
  fetchedAt: string;
}

export interface DiscoverQuery {
  search?: string;
  task?: string;
  library?: string;
  tag?: string;
  sort?: (typeof HF_SORTS)[number];
  limit?: number;
  cursor?: string;
}

// Small in-memory TTL cache — discovery data changes slowly, and this keeps us
// well within Hub rate limits. Per server instance; swap for a shared cache at scale.
const cache = new Map<string, { at: number; value: unknown }>();
const TTL_MS = 5 * 60_000;
const MAX_ENTRIES = 300;

function cached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
  if (hit) cache.delete(key);
  return undefined;
}
function store(key: string, value: unknown) {
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
}
export function clearDiscoveryCache() {
  cache.clear();
}

/** Extract the cursor from a Hub `Link: <...>; rel="next"` header. */
export function parseNextCursor(link: string | null): string | null {
  if (!link) return null;
  const m = link.match(/<([^>]+)>\s*;\s*rel="next"/);
  if (!m) return null;
  try {
    return new URL(m[1]!).searchParams.get("cursor");
  } catch {
    return null;
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

export function normalizeModel(r: Record<string, unknown>): HubModel | null {
  const id = str(r.id) ?? str(r.modelId);
  if (!id) return null;
  return {
    id,
    author: str(r.author) ?? (id.includes("/") ? id.split("/")[0]! : null),
    task: str(r.pipeline_tag),
    library: str(r.library_name),
    tags: Array.isArray(r.tags) ? (r.tags.filter((t) => typeof t === "string") as string[]).slice(0, 24) : [],
    downloads: num(r.downloads),
    likes: num(r.likes),
    lastModified: str(r.lastModified),
    gated: Boolean(r.gated),
    url: `${HUB}/${id}`,
  };
}

export function normalizeDataset(r: Record<string, unknown>): HubDataset | null {
  const id = str(r.id);
  if (!id) return null;
  const desc = str(r.description);
  return {
    id,
    author: str(r.author) ?? (id.includes("/") ? id.split("/")[0]! : null),
    description: desc ? desc.replace(/\s+/g, " ").trim().slice(0, 400) : null,
    tags: Array.isArray(r.tags) ? (r.tags.filter((t) => typeof t === "string") as string[]).slice(0, 24) : [],
    downloads: num(r.downloads),
    likes: num(r.likes),
    lastModified: str(r.lastModified),
    gated: Boolean(r.gated),
    url: `${HUB}/datasets/${id}`,
  };
}

async function hubFetch(path: string, token?: string, signal?: AbortSignal): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${HUB}${path}`, {
      headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: signal ?? AbortSignal.timeout(12_000),
    });
  } catch (err) {
    if ((err as Error)?.name === "TimeoutError") throw new ApiError("timeout", "Hugging Face Hub did not respond in time.");
    throw new ApiError("upstream_error", "Could not reach the Hugging Face Hub.");
  }
  if (res.status === 429) throw new ApiError("rate_limited", "Hugging Face Hub rate limit reached. Try again shortly, or set HUGGINGFACE_API_KEY.");
  if (res.status === 404) throw new ApiError("not_found", "Not found on the Hugging Face Hub.");
  if (!res.ok) throw new ApiError("upstream_error", `Hugging Face Hub returned HTTP ${res.status}.`);
  return res;
}

function buildParams(q: DiscoverQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (q.search) p.set("search", q.search);
  if (q.task) p.set("pipeline_tag", q.task);
  if (q.library) p.set("library", q.library);
  if (q.tag) p.set("filter", q.tag);
  p.set("sort", q.sort ?? "trendingScore");
  p.set("direction", "-1");
  p.set("limit", String(q.limit ?? 24));
  if (q.cursor) p.set("cursor", q.cursor);
  return p;
}

export async function searchModels(q: DiscoverQuery, token?: string): Promise<HubPage<HubModel>> {
  const params = buildParams(q);
  const key = `models?${params}`;
  const hit = cached<HubPage<HubModel>>(key);
  if (hit) return hit;
  const res = await hubFetch(`/api/models?${params}`, token);
  const raw = (await res.json()) as Record<string, unknown>[];
  const page: HubPage<HubModel> = {
    items: (Array.isArray(raw) ? raw : []).map(normalizeModel).filter((m): m is HubModel => m !== null),
    nextCursor: parseNextCursor(res.headers.get("link")),
    fetchedAt: new Date().toISOString(),
  };
  store(key, page);
  return page;
}

export async function searchDatasets(q: DiscoverQuery, token?: string): Promise<HubPage<HubDataset>> {
  const params = buildParams({ ...q, task: undefined, library: undefined });
  if (q.task) params.set("filter", `task_categories:${q.task}`);
  const key = `datasets?${params}`;
  const hit = cached<HubPage<HubDataset>>(key);
  if (hit) return hit;
  const res = await hubFetch(`/api/datasets?${params}`, token);
  const raw = (await res.json()) as Record<string, unknown>[];
  const page: HubPage<HubDataset> = {
    items: (Array.isArray(raw) ? raw : []).map(normalizeDataset).filter((d): d is HubDataset => d !== null),
    nextCursor: parseNextCursor(res.headers.get("link")),
    fetchedAt: new Date().toISOString(),
  };
  store(key, page);
  return page;
}

export const HUB_REPO_ID = /^[A-Za-z0-9][\w.-]{0,95}(\/[\w.-]{1,96})?$/;

/** Model detail plus a plain-text excerpt of its model card. */
export async function getModelDetail(id: string, token?: string): Promise<HubModel & { summary: string | null; license: string | null }> {
  if (!HUB_REPO_ID.test(id) || id.includes("..")) throw new ApiError("bad_request", "Invalid model id.");
  const key = `model:${id}`;
  const hit = cached<HubModel & { summary: string | null; license: string | null }>(key);
  if (hit) return hit;
  const res = await hubFetch(`/api/models/${id}`, token);
  const raw = (await res.json()) as Record<string, unknown>;
  const base = normalizeModel(raw);
  if (!base) throw new ApiError("not_found", "Model not found.");
  const card = (raw.cardData ?? {}) as Record<string, unknown>;
  let summary: string | null = null;
  try {
    const readme = await fetch(`${HUB}/${id}/raw/main/README.md`, { signal: AbortSignal.timeout(8_000) });
    if (readme.ok) summary = readmeExcerpt(await readme.text());
  } catch {
    /* optional */
  }
  const detail = { ...base, summary, license: str(card.license) };
  store(key, detail);
  return detail;
}

/** First meaningful prose paragraph of a model card, as plain text. */
export function readmeExcerpt(md: string, max = 600): string | null {
  const body = md.replace(/^---[\s\S]*?\n---\s*/, "");
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^(#|!\[|<|\||```|>|\[!)/.test(p));
  const first = paragraphs.find((p) => p.replace(/[^a-z]/gi, "").length > 40);
  if (!first) return null;
  const text = first
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
