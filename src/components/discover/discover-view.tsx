"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { Database, Download, ExternalLink, Heart, Info, Layers, ListPlus, Lock, Search, Star, X } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { Badge, Button, Card, EmptyState, Input, Notice, PageHeader, Select, Skeleton, Spinner } from "@/components/ui/primitives";
import { jsonFetch } from "@/hooks/use-ndjson";
import { cn, formatNumber, relativeTime } from "@/lib/utils";

const TASKS = [
  ["", "All tasks"],
  ["text-generation", "Language models"],
  ["image-text-to-text", "Vision-language"],
  ["text-to-image", "Image generation"],
  ["automatic-speech-recognition", "Speech recognition"],
  ["text-to-speech", "Text-to-speech"],
  ["feature-extraction", "Embeddings"],
  ["sentence-similarity", "Sentence similarity"],
  ["image-classification", "Image classification"],
  ["object-detection", "Object detection"],
  ["translation", "Translation"],
  ["summarization", "Summarization"],
] as const;
const LIBRARIES = ["", "transformers", "diffusers", "gguf", "sentence-transformers", "mlx", "onnx", "safetensors"];
const SORTS = [
  ["trendingScore", "Trending"],
  ["downloads", "Most downloads"],
  ["likes", "Most likes"],
  ["lastModified", "Recently updated"],
  ["createdAt", "Newest"],
] as const;
const QUICK = [
  { label: "Coding models", search: "coder", task: "text-generation" },
  { label: "Small LLMs", search: "", task: "text-generation", tag: "gguf" },
  { label: "Embeddings", search: "", task: "feature-extraction" },
  { label: "Speech", search: "", task: "automatic-speech-recognition" },
];

interface HubItem {
  id: string;
  author: string | null;
  task?: string | null;
  library?: string | null;
  description?: string | null;
  tags: string[];
  downloads: number | null;
  likes: number | null;
  lastModified: string | null;
  gated: boolean;
  url: string;
}

const SHORTLIST_KEY = "orbis:shortlist";

export function DiscoverView() {
  const { user } = useApp();
  const [tab, setTab] = useState<"models" | "datasets">("models");
  const [search, setSearch] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [task, setTask] = useState("");
  const [library, setLibrary] = useState("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState<string>("trendingScore");
  const [page, setPage] = useState<{ key: string; items: HubItem[]; cursor: string | null; error: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [shortlistRaw, setShortlistRaw] = useLocalStorage(SHORTLIST_KEY, "[]");
  const shortlist = useMemo<string[]>(() => {
    try {
      const v = JSON.parse(shortlistRaw ?? "[]");
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }, [shortlistRaw]);
  const [detail, setDetail] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (!user) return;
    jsonFetch<{ favorites: { model_id: string }[] }>("/api/favorites")
      .then((r) => setFavorites(new Set(r.favorites.map((f) => f.model_id))))
      .catch(() => null);
  }, [user]);

  const query = useCallback(
    (extra?: { cursor?: string }) => {
      const p = new URLSearchParams();
      if (submitted) p.set("search", submitted);
      if (task) p.set("task", task);
      if (tab === "models" && library) p.set("library", library);
      if (tag) p.set("tag", tag);
      p.set("sort", sort);
      p.set("limit", "24");
      if (extra?.cursor) p.set("cursor", extra.cursor);
      return `${tab === "models" ? "/api/discover" : "/api/discover/datasets"}?${p}`;
    },
    [submitted, task, library, tag, sort, tab],
  );

  const currentKey = query();
  useEffect(() => {
    const id = ++reqId.current;
    jsonFetch<{ items: HubItem[]; nextCursor: string | null }>(currentKey)
      .then((r) => {
        if (id === reqId.current) setPage({ key: currentKey, items: r.items, cursor: r.nextCursor, error: null });
      })
      .catch((e: Error) => {
        if (id === reqId.current) setPage({ key: currentKey, items: [], cursor: null, error: e.message });
      });
  }, [currentKey]);
  // While a new query loads, show skeletons rather than stale results.
  const fresh = page?.key === currentKey ? page : null;
  const items = fresh?.items ?? null;
  const cursor = fresh?.cursor ?? null;
  const error = fresh?.error ?? moreError;

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await jsonFetch<{ items: HubItem[]; nextCursor: string | null }>(query({ cursor }));
      setMoreError(null);
      setPage((p) => (p && p.key === currentKey ? { ...p, items: [...p.items, ...r.items], cursor: r.nextCursor } : p));
    } catch (e) {
      setMoreError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleFav = async (id: string) => {
    const on = favorites.has(id);
    setFavorites((s) => {
      const n = new Set(s);
      if (on) n.delete(id);
      else n.add(id);
      return n;
    });
    try {
      await jsonFetch("/api/favorites", { method: on ? "DELETE" : "POST", body: JSON.stringify({ modelId: id, source: "hub" }) });
    } catch {
      setFavorites((s) => {
        const n = new Set(s);
        if (on) n.add(id);
        else n.delete(id);
        return n;
      });
    }
  };

  const toggleShort = (id: string) => {
    const n = shortlist.includes(id) ? shortlist.filter((x) => x !== id) : [...shortlist, id].slice(-8);
    setShortlistRaw(JSON.stringify(n));
  };

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader
        title="Model Discovery"
        description="Live results from the Hugging Face Hub. Discovering a model here does not mean Orbis can run it — only models in the registry with a configured provider can be used in Chat and Battle."
      />

      <div className="mb-4 flex gap-1 rounded-xl border border-border bg-panel p-1 sm:w-fit" role="tablist">
        {(["models", "datasets"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn("flex flex-1 items-center justify-center gap-1.5 rounded-lg px-4 py-1.5 text-sm sm:flex-none", tab === t ? "bg-accent-soft text-fg" : "text-muted hover:text-fg")}
          >
            {t === "models" ? <Layers className="h-4 w-4" /> : <Database className="h-4 w-4" />} {t === "models" ? "Models" : "Datasets"}
          </button>
        ))}
      </div>

      <Card className="p-3">
        <form
          className="flex flex-col gap-2 lg:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmitted(search.trim());
          }}
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} maxLength={120} placeholder={`Search ${tab}…`} className="pl-9" aria-label={`Search ${tab}`} />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex">
            <Select value={task} onChange={(e) => setTask(e.target.value)} aria-label="Task" className="h-10">
              {TASKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            {tab === "models" && (
              <Select value={library} onChange={(e) => setLibrary(e.target.value)} aria-label="Library" className="h-10">
                {LIBRARIES.map((l) => <option key={l} value={l}>{l || "Any library"}</option>)}
              </Select>
            )}
            <Input value={tag} onChange={(e) => setTag(e.target.value.replace(/[^\w:.-]/g, ""))} placeholder="Tag (e.g. en)" className="h-10 sm:w-32" aria-label="Tag" maxLength={80} />
            <Select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort" className="h-10">
              {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
            <Button type="submit" className="h-10">Search</Button>
          </div>
        </form>
        {tab === "models" && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {QUICK.map((q) => (
              <button
                key={q.label}
                onClick={() => {
                  setSearch(q.search);
                  setSubmitted(q.search);
                  setTask(q.task);
                  setTag(q.tag ?? "");
                  setLibrary("");
                }}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted hover:border-accent/40 hover:text-fg"
              >
                {q.label}
              </button>
            ))}
          </div>
        )}
      </Card>

      {shortlist.length > 0 && tab === "models" && (
        <div className="mt-4 rounded-xl border border-border bg-panel px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-faint">Comparison shortlist</span>
            {shortlist.map((id) => (
              <span key={id} className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-elev px-2 py-0.5 text-xs">
                {id}
                <button onClick={() => toggleShort(id)} aria-label={`Remove ${id}`}><X className="h-3 w-3 text-faint hover:text-fg" /></button>
              </span>
            ))}
            <Link href="/battle" className="ml-auto text-xs text-accent hover:underline">Open Model Battle →</Link>
          </div>
          <p className="mt-1 text-[11px] text-faint">Shortlisted models can be battled once they are added to the model registry with an available provider.</p>
        </div>
      )}

      {error && <Notice tone="danger" className="mt-4" title="Hugging Face Hub request failed">{error}</Notice>}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items === null
          ? Array.from({ length: 9 }).map((_, i) => <Skeleton key={i} className="h-40" />)
          : items.map((it) => (
              <Card key={it.id} className="flex flex-col p-4">
                <div className="flex items-start justify-between gap-2">
                  <button onClick={() => tab === "models" && setDetail(it.id)} className={cn("min-w-0 text-left", tab === "models" && "hover:text-accent")}>
                    <div className="truncate text-xs text-faint">{it.author}</div>
                    <div className="break-all font-medium leading-snug">{it.id.split("/").slice(1).join("/") || it.id}</div>
                  </button>
                  {it.gated && <Badge tone="warning" title="Gated: requires accepting terms on Hugging Face"><Lock className="h-3 w-3" /> Gated</Badge>}
                </div>
                {it.description && <p className="mt-2 line-clamp-2 text-xs text-muted">{it.description}</p>}
                <div className="mt-2 flex flex-wrap gap-1">
                  {it.task && <Badge tone="accent">{it.task}</Badge>}
                  {it.library && <Badge>{it.library}</Badge>}
                  {it.tags.filter((t) => !t.includes(":") && t !== it.library && t !== it.task).slice(0, 3).map((t) => <Badge key={t}>{t}</Badge>)}
                </div>
                <div className="mt-auto flex items-center gap-3 pt-3 text-xs text-faint tabular-nums">
                  <span className="inline-flex items-center gap-1" title="Downloads (as reported by the Hub)"><Download className="h-3.5 w-3.5" />{formatNumber(it.downloads)}</span>
                  <span className="inline-flex items-center gap-1" title="Likes"><Heart className="h-3.5 w-3.5" />{formatNumber(it.likes)}</span>
                  <span>{relativeTime(it.lastModified)}</span>
                  <span className="ml-auto flex items-center gap-0.5">
                    {tab === "models" && (
                      <>
                        <IconBtn label="Details" onClick={() => setDetail(it.id)}><Info className="h-3.5 w-3.5" /></IconBtn>
                        <IconBtn label={shortlist.includes(it.id) ? "Remove from shortlist" : "Add to comparison shortlist"} active={shortlist.includes(it.id)} onClick={() => toggleShort(it.id)}><ListPlus className="h-3.5 w-3.5" /></IconBtn>
                        {user && <IconBtn label={favorites.has(it.id) ? "Unfavourite" : "Favourite"} active={favorites.has(it.id)} onClick={() => void toggleFav(it.id)}><Star className={cn("h-3.5 w-3.5", favorites.has(it.id) && "fill-current")} /></IconBtn>}
                      </>
                    )}
                    <a href={it.url} target="_blank" rel="noopener noreferrer" className="grid h-7 w-7 place-items-center rounded-md hover:bg-panel-2 hover:text-fg" aria-label="Open on Hugging Face"><ExternalLink className="h-3.5 w-3.5" /></a>
                  </span>
                </div>
              </Card>
            ))}
      </div>

      {items && items.length === 0 && !error && (
        <div className="mt-4"><EmptyState icon={<Search className="h-8 w-8" />} title="No results">Try a broader search or remove a filter.</EmptyState></div>
      )}
      {cursor && items && items.length > 0 && (
        <div className="mt-6 flex justify-center">
          <Button variant="secondary" onClick={loadMore} loading={loadingMore}>Load more</Button>
        </div>
      )}
      <p className="mt-6 text-center text-[11px] text-faint">Data from the Hugging Face Hub API, cached for up to 5 minutes. Counts are as reported by the Hub.</p>

      {detail && <DetailDrawer id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function IconBtn({ children, label, onClick, active }: { children: React.ReactNode; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick} title={label} aria-label={label} aria-pressed={active} className={cn("grid h-7 w-7 place-items-center rounded-md hover:bg-panel-2 hover:text-fg", active && "text-accent")}>
      {children}
    </button>
  );
}

interface Detail {
  model: HubItem & { summary: string | null; license: string | null };
  orbis: { runnable: boolean; registryId: string | null; reason: string | null };
}

function DetailDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    jsonFetch<Detail>(`/api/discover/model?id=${encodeURIComponent(id)}`).then(setD).catch((e: Error) => setError(e.message));
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [id, onClose]);
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`Model ${id}`}>
      <button className="absolute inset-0 bg-black/60" onClick={onClose} aria-label="Close" />
      <aside className="absolute inset-y-0 right-0 w-full max-w-lg overflow-y-auto border-l border-border bg-bg-elev p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs text-faint">{id.split("/")[0]}</div>
            <h2 className="break-all text-lg font-semibold">{id}</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button>
        </div>
        {error ? (
          <Notice tone="danger" className="mt-4">{error}</Notice>
        ) : !d ? (
          <div className="mt-8 grid place-items-center"><Spinner /></div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap gap-1.5">
              {d.model.task && <Badge tone="accent">{d.model.task}</Badge>}
              {d.model.library && <Badge>{d.model.library}</Badge>}
              {d.model.license && <Badge>license: {d.model.license}</Badge>}
              {d.model.gated && <Badge tone="warning">Gated</Badge>}
            </div>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Mini label="Downloads" v={formatNumber(d.model.downloads)} />
              <Mini label="Likes" v={formatNumber(d.model.likes)} />
              <Mini label="Updated" v={relativeTime(d.model.lastModified)} />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wider text-faint">From the model card</div>
              <p className="text-sm leading-relaxed text-muted">{d.model.summary ?? "No summary could be extracted from the model card."}</p>
            </div>
            <Notice tone={d.orbis.runnable ? "success" : "info"} title={d.orbis.runnable ? "Runnable in Orbis" : "Not runnable in Orbis yet"}>
              {d.orbis.runnable ? "This model is in the registry with a configured provider. Select it in Chat or Model Battle." : d.orbis.reason}
            </Notice>
            {d.model.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">{d.model.tags.slice(0, 20).map((t) => <Badge key={t}>{t}</Badge>)}</div>
            )}
            <a href={d.model.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
              View on Hugging Face <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}
      </aside>
    </div>
  );
}

function Mini({ label, v }: { label: string; v: string }) {
  return (
    <div className="rounded-xl border border-border bg-panel p-2.5">
      <div className="text-[11px] text-faint">{label}</div>
      <div className="mt-0.5 font-semibold tabular-nums">{v}</div>
    </div>
  );
}
