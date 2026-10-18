"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronDown, Dna, ExternalLink, Globe, Lightbulb, RefreshCw, Search, Sparkles, Square } from "lucide-react";
import { Markdown } from "@/components/common/markdown";
import { CopyButton } from "@/components/common/copy-button";
import { ModelPicker, defaultModelId, useModels } from "@/components/common/model-picker";
import { SaveToProject } from "@/components/projects/save-to-project";
import { SUGGESTED_PROMPTS } from "@/components/search/hero-search";
import { useApp } from "@/components/layout/app-context";
import { handoff } from "@/components/research/local-store";
import { Badge, Button, Card, Notice, Skeleton } from "@/components/ui/primitives";
import { jsonFetch, postNdjson } from "@/hooks/use-ndjson";
import type { SearchSource } from "@/lib/search/types";
import { cn, formatUsd, isSafeHttpUrl } from "@/lib/utils";

interface Turn {
  id: string;
  query: string;
  status: "searching" | "answering" | "done" | "error";
  sources: SearchSource[];
  searchProvider: string | null;
  answer: string;
  followUps: string[];
  cited: number[];
  notices: string[];
  error?: string;
  simulated: boolean;
  grounded: boolean;
  searchId: string | null;
  modelName?: string;
  cost?: number | null;
  tokens?: { in: number | null; out: number | null; estimated: boolean } | null;
}

type Ev =
  | { type: "meta"; model: { displayName: string } }
  | { type: "sources"; provider: string | null; sources: SearchSource[] }
  | { type: "notice"; message: string }
  | { type: "delta"; text: string }
  | {
      type: "done";
      answer: string;
      followUps: string[];
      citedSources: number[];
      simulated: boolean;
      grounded: boolean;
      searchId: string | null;
      estimatedCost: number | null;
      usage: { inputTokens: number | null; outputTokens: number | null; estimated: boolean } | null;
    }
  | { type: "error"; message: string };

export function SearchView() {
  const params = useSearchParams();
  const router = useRouter();
  const { integrations } = useApp();
  const models = useModels();
  const [pickedModel, setModelId] = useState<string | undefined>();
  const modelId = pickedModel ?? defaultModelId(models);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startedFor = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const busy = turns.some((t) => t.status === "searching" || t.status === "answering");

  const update = (id: string, fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));

  const run = useCallback(
    async (query: string, opts: { replaceId?: string; history?: Turn[] } = {}) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const id = opts.replaceId ?? crypto.randomUUID();
      const fresh: Turn = {
        id, query, status: "searching", sources: [], searchProvider: null, answer: "", followUps: [], cited: [],
        notices: [], simulated: false, grounded: false, searchId: null,
      };
      setTurns((ts) => (opts.replaceId ? ts.map((t) => (t.id === id ? fresh : t)) : [...ts, fresh]));
      const history = (opts.history ?? []).filter((t) => t.status === "done").slice(-3).flatMap((t) => [
        { role: "user" as const, content: t.query },
        { role: "assistant" as const, content: t.answer.slice(0, 4000) },
      ]);
      try {
        for await (const ev of postNdjson<Ev>("/api/search", { query, modelId, history }, ac.signal)) {
          if (ev.type === "meta") update(id, (t) => ({ ...t, modelName: ev.model.displayName }));
          else if (ev.type === "sources") update(id, (t) => ({ ...t, sources: ev.sources, searchProvider: ev.provider, status: "answering" }));
          else if (ev.type === "notice") update(id, (t) => ({ ...t, notices: [...t.notices, ev.message], status: t.status === "searching" ? "answering" : t.status }));
          else if (ev.type === "delta") update(id, (t) => ({ ...t, status: "answering", answer: t.answer + ev.text }));
          else if (ev.type === "done")
            update(id, (t) => ({
              ...t, status: "done", answer: ev.answer, followUps: ev.followUps, cited: ev.citedSources, simulated: ev.simulated,
              grounded: ev.grounded, searchId: ev.searchId, cost: ev.estimatedCost,
              tokens: ev.usage ? { in: ev.usage.inputTokens, out: ev.usage.outputTokens, estimated: ev.usage.estimated } : null,
            }));
          else if (ev.type === "error") update(id, (t) => ({ ...t, status: "error", error: ev.message }));
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") update(id, (t) => ({ ...t, status: t.answer ? "done" : "error", error: t.answer ? undefined : "Stopped." }));
        else update(id, (t) => ({ ...t, status: "error", error: (e as Error).message }));
      }
    },
    [modelId],
  );

  // Kick off a search from ?q= once models are known.
  const q = params.get("q");
  useEffect(() => {
    if (!q || !models || startedFor.current === q) return;
    startedFor.current = q;
    setTurns([]);
    void run(q);
  }, [q, models, run]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns.length]);

  const submit = (text: string) => {
    const t = text.trim();
    if (t.length < 2 || busy) return;
    setInput("");
    if (turns.length === 0) {
      startedFor.current = t;
      router.replace(`/search?q=${encodeURIComponent(t)}`, { scroll: false });
      void run(t);
    } else void run(t, { history: turns });
  };

  const jumpTo = (turnId: string, n: number) => {
    const key = `${turnId}-${n}`;
    setHighlight(key);
    document.getElementById(`src-${key}`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => setHighlight((h) => (h === key ? null : h)), 1800);
  };

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-3.5rem)] max-w-4xl flex-col px-4 pt-8 sm:px-6 lg:min-h-dvh">
      {turns.length === 0 ? (
        <div className="flex-1 pt-10">
          <h1 className="text-center text-3xl font-semibold tracking-tight"><span className="nova-gradient-text">AI Search</span></h1>
          <p className="mt-2 text-center text-sm text-muted">Answers grounded in live web sources. Every citation links to a real page you can check.</p>
          {!integrations.search && (
            <Notice tone="warning" className="mt-6" title="Web search is not configured">
              Add <code>SEARCH_API_KEY</code> (Tavily or Brave) to get live sources. Without it, answers are clearly marked as not grounded.
            </Notice>
          )}
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            {SUGGESTED_PROMPTS.map((p) => (
              <button key={p} onClick={() => submit(p)} className="flex items-center gap-2 rounded-xl border border-border bg-panel/60 px-3.5 py-3 text-left text-sm text-muted hover:border-accent/40 hover:text-fg">
                <Lightbulb className="h-4 w-4 shrink-0 text-faint" /> {p}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 space-y-12 pb-8">
          {turns.map((t, i) => (
            <TurnView
              key={t.id}
              turn={t}
              highlight={highlight}
              onCite={(n) => jumpTo(t.id, n)}
              onFollowUp={submit}
              onRegenerate={() => run(t.query, { replaceId: t.id, history: turns.slice(0, i) })}
              busy={busy}
            />
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      {/* Composer */}
      <div className="sticky bottom-0 z-30 -mx-4 mt-8 border-t border-border bg-bg/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
          className="mx-auto flex max-w-4xl items-center gap-2"
        >
          <div className="flex min-w-0 flex-1 items-center rounded-2xl border border-border-strong bg-panel px-2 focus-within:border-accent/60">
            <Search className="ml-1.5 h-4 w-4 shrink-0 text-faint" />
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={500}
              placeholder={turns.length ? "Ask a follow-up…" : "Ask a question…"}
              aria-label="Search"
              className="h-11 min-w-0 flex-1 bg-transparent px-2.5 text-sm focus:outline-none"
            />
            <ModelPicker value={modelId} onChange={setModelId} models={models} className="hidden h-8 max-w-[180px] border-transparent bg-panel-2 text-xs sm:block" />
          </div>
          {busy ? (
            <Button type="button" variant="secondary" size="icon" className="h-11 w-11 rounded-xl" onClick={() => abortRef.current?.abort()} aria-label="Stop">
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button type="submit" size="icon" className="h-11 w-11 rounded-xl" disabled={input.trim().length < 2} aria-label="Search">
              <ArrowRight className="h-5 w-5" />
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}

function TurnView({
  turn: t,
  highlight,
  onCite,
  onFollowUp,
  onRegenerate,
  busy,
}: {
  turn: Turn;
  highlight: string | null;
  onCite: (n: number) => void;
  onFollowUp: (q: string) => void;
  onRegenerate: () => void;
  busy: boolean;
}) {
  const router = useRouter();
  const valid = new Set(t.sources.map((s) => s.index));
  return (
    <article>
      <h2 className="text-2xl font-semibold leading-snug tracking-tight">{t.query}</h2>

      {/* Sources */}
      <section className="mt-5" aria-label="Sources">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-faint">
          <Globe className="h-3.5 w-3.5" /> Sources
          {t.searchProvider && <span className="normal-case tracking-normal">via {t.searchProvider}</span>}
        </div>
        {t.status === "searching" ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}
          </div>
        ) : t.sources.length === 0 ? (
          <p className="text-sm text-faint">No web sources were retrieved for this answer.</p>
        ) : (
          <SourceList turnId={t.id} sources={t.sources} cited={t.cited} highlight={highlight} />
        )}
      </section>

      {t.notices.map((n, i) => (
        <Notice key={i} tone="warning" className="mt-4">{n}</Notice>
      ))}

      {/* Answer */}
      <section className="mt-6" aria-label="Answer" aria-live="polite">
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wider text-faint">
          <Sparkles className="h-3.5 w-3.5 text-accent" /> Answer
          {t.modelName && <span className="normal-case tracking-normal">· {t.modelName}</span>}
          {t.status === "done" && t.simulated && <Badge tone="warning">Simulated</Badge>}
          {t.status === "done" && !t.simulated && (t.grounded ? <Badge tone="success">Cites retrieved sources</Badge> : <Badge tone="warning">Not grounded in sources</Badge>)}
        </div>
        {t.answer ? (
          <Markdown text={t.answer} onCitation={onCite} validCitations={valid} />
        ) : t.status === "error" ? null : (
          <div className="space-y-2">
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-10/12" />
            <Skeleton className="h-4 w-7/12" />
          </div>
        )}
        {t.status === "answering" && t.answer && <span className="nova-dot ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 rounded-sm bg-accent" />}
        {t.status === "error" && <Notice tone="danger" className="mt-2" title="The answer could not be generated">{t.error}</Notice>}

        {t.status === "done" && (
          <>
            {t.sources.length > 0 && (
              <p className="mt-4 text-xs text-faint">
                Numbered citations point to the retrieved pages above. Retrieval is not verification — open the sources to check important claims.
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border pt-3">
              <CopyButton text={t.answer} />
              <Button variant="ghost" size="sm" onClick={onRegenerate} disabled={busy}>
                <RefreshCw className="h-3.5 w-3.5" /> Regenerate
              </Button>
              <Button
                variant="ghost"
                size="sm"
                title="Break this answer into claims and check each one against the retrieved sources"
                onClick={() => {
                  handoff.set({
                    question: t.query,
                    answer: t.answer,
                    sources: t.sources.map((src) => ({ index: src.index, url: src.url, title: src.title, text: src.snippet, publishedAt: src.publishedAt, provider: t.searchProvider })),
                  });
                  router.push("/claims");
                }}
              >
                <Dna className="h-3.5 w-3.5" /> Check claims
              </Button>
              <SaveToProject
                disabled={!t.searchId}
                label={t.searchId ? "Save to project" : "Sign in to save"}
                onSave={(projectId) => jsonFetch("/api/search/save", { method: "POST", body: JSON.stringify({ searchId: t.searchId, projectId }) })}
              />
              <span className="ml-auto text-xs text-faint tabular-nums">
                {t.tokens && `${t.tokens.in ?? "?"} in · ${t.tokens.out ?? "?"} out${t.tokens.estimated ? " (est.)" : ""} · `}
                cost {formatUsd(t.cost)}
              </span>
            </div>
          </>
        )}
      </section>

      {t.followUps.length > 0 && (
        <section className="mt-6" aria-label="Related questions">
          <div className="mb-2 text-xs font-medium uppercase tracking-wider text-faint">Related</div>
          <div className="divide-y divide-border rounded-xl border border-border">
            {t.followUps.map((f) => (
              <button key={f} disabled={busy} onClick={() => onFollowUp(f)} className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-50">
                {f} <ArrowRight className="h-4 w-4 shrink-0 text-faint" />
              </button>
            ))}
          </div>
        </section>
      )}
    </article>
  );
}

function SourceList({ turnId, sources, cited, highlight }: { turnId: string; sources: SearchSource[]; cited: number[]; highlight: string | null }) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? sources : sources.slice(0, 6);
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {visible.map((s) => {
          const key = `${turnId}-${s.index}`;
          const open = expanded === s.index;
          return (
            <Card
              key={s.index}
              id={`src-${key}`}
              className={cn("p-3 transition", highlight === key && "border-accent ring-2 ring-accent/30", open && "sm:col-span-2 lg:col-span-3")}
            >
              <div className="flex items-start gap-2">
                <span className={cn("grid h-5 min-w-5 place-items-center rounded-md px-1 text-[11px] font-semibold", cited.includes(s.index) ? "bg-accent-soft text-accent" : "bg-panel-2 text-faint")}>
                  {s.index}
                </span>
                <div className="min-w-0 flex-1">
                  {isSafeHttpUrl(s.url) ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="line-clamp-2 text-[13px] font-medium leading-snug hover:text-accent">
                      {s.title}
                    </a>
                  ) : (
                    <span className="line-clamp-2 text-[13px] font-medium">{s.title}</span>
                  )}
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-faint">
                    <span className="truncate">{s.domain}</span>
                    {s.publishedAt && <span>· {new Date(s.publishedAt).toLocaleDateString()}</span>}
                    {!cited.includes(s.index) && cited.length > 0 && <span>· not cited</span>}
                  </div>
                </div>
              </div>
              {open && <p className="mt-2 border-t border-border pt-2 text-[13px] leading-relaxed text-muted">{s.snippet || "No excerpt available."}</p>}
              <div className="mt-2 flex items-center gap-3">
                <button onClick={() => setExpanded(open ? null : s.index)} className="inline-flex items-center gap-1 text-[11px] text-faint hover:text-fg" aria-expanded={open}>
                  <ChevronDown className={cn("h-3 w-3 transition", open && "rotate-180")} /> {open ? "Hide excerpt" : "Excerpt"}
                </button>
                {isSafeHttpUrl(s.url) && (
                  <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-[11px] text-faint hover:text-fg">
                    <ExternalLink className="h-3 w-3" /> Open
                  </a>
                )}
              </div>
            </Card>
          );
        })}
      </div>
      {sources.length > 6 && (
        <button onClick={() => setShowAll((v) => !v)} className="mt-2 text-xs text-faint hover:text-fg">
          {showAll ? "Show fewer" : `Show all ${sources.length} sources`}
        </button>
      )}
    </>
  );
}
