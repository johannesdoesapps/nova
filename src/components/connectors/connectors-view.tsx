"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpRight, CircleAlert, CircleCheck, KeyRound, Search, X } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { CATEGORIES, type CatalogEntry, type ConnectorItem } from "@/lib/connectors/catalog";
import { cn } from "@/lib/utils";
import { BrandIcon } from "./brand-icon";
import { ConnectorDialog, statusOf } from "./connector-dialog";
import { KeyGenerator } from "./key-generator";
import { api, StatusPill } from "./shared";

export interface CatalogResponse {
  connectors: CatalogEntry[];
  admin: boolean;
  setup: { redirectUri: string; keyConfigured: boolean } | null;
}

function ConnectorCard({ c, onOpen }: { c: CatalogEntry; onOpen: () => void }) {
  const status = statusOf(c);
  const action =
    status === "connected" ? "Manage" : status === "reauth_required" || status === "error" ? "Fix" : !c.available ? "Not set up yet" : c.auth === "none" ? "Turn on" : "Connect";
  return (
    <article className="group flex flex-col s-card rounded-2xl bg-[var(--s-glass)] p-4 transition hover:border-s-line-strong">
      <div className="flex items-start gap-3">
        <BrandIcon id={c.id} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[15px] font-medium leading-tight">{c.name}</h3>
            {status !== "not_connected" && <StatusPill status={status} />}
          </div>
          <p className="mt-1 text-[13px] leading-snug text-s-ink-2">{c.tagline}</p>
        </div>
      </div>
      <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="What it can do">
        {c.capabilities.slice(0, 3).map((cap) => (
          <li key={cap.label} className="rounded-full border border-s-line px-2 py-0.5 text-[11.5px] text-s-ink-3">
            {cap.access === "write" && <span className="mr-1 text-s-ink-2">✎</span>}
            {cap.label}
          </li>
        ))}
      </ul>
      {c.connection?.accountLabel && status === "connected" && <p className="mt-2 truncate text-[12px] text-s-ink-3">{c.connection.accountLabel}</p>}
      <div className="mt-auto flex items-center justify-between gap-2 pt-4">
        <span className="text-[11.5px] text-s-ink-3">{CATEGORIES.find((x) => x.id === c.category)?.label}</span>
        <button
          type="button"
          onClick={onOpen}
          aria-label={`${action}: ${c.name}`}
          className={cn(
            "h-8 rounded-full px-3.5 text-[12.5px] font-medium transition",
            status === "connected" ? "border border-s-line text-s-ink-2 hover:border-s-line-strong hover:text-s-ink" : !c.available ? "border border-dashed border-s-line text-s-ink-3 hover:text-s-ink-2" : "bg-s-accent text-s-accent-ink hover:brightness-110",
          )}
        >
          {action}
        </button>
      </div>
    </article>
  );
}

export function ConnectorsView() {
  const { user } = useApp();
  const params = useSearchParams();
  const [data, setData] = useState<CatalogResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"discover" | "connected">(params.get("tab") === "connected" ? "connected" : "discover");
  const [category, setCategory] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(params.get("connector"));
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(() => {
    const ok = params.get("connected");
    const err = params.get("error");
    return ok ? { tone: "ok", text: "Connected. Orbis can now use it when you ask." } : err ? { tone: "error", text: err.slice(0, 300) } : null;
  });

  const load = useCallback(async () => {
    try {
      setData(await api<CatalogResponse>("/api/connectors"));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api<CatalogResponse>("/api/connectors")
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setLoadError(e.message));
    // Drop the one-time ?connected / ?error from the address bar. The browser's history API (not a router
    // navigation), so the page isn't re-rendered from scratch and the message about the connection stays visible.
    if (params.get("connected") || params.get("error")) window.history.replaceState(window.history.state, "", "/connectors");
    return () => {
      alive = false;
    };
  }, [params]);

  const all = useMemo(() => data?.connectors ?? [], [data]);
  const connected = all.filter((c) => c.connection && c.connection.status !== "disconnected");
  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    return all.filter((c) => {
      if (category && c.category !== category) return false;
      if (!term) return true;
      const cat = CATEGORIES.find((x) => x.id === c.category)?.label ?? "";
      return [c.name, c.vendor, cat, c.tagline, ...c.capabilities.map((x) => x.label), ...c.keywords].some((s) => s.toLowerCase().includes(term));
    });
  }, [all, category, q]);
  const featured = all.filter((c) => c.featured);
  const usedCategories = CATEGORIES.filter((cat) => all.some((c) => c.category === cat.id));
  const current = all.find((c) => c.id === open) ?? null;
  const browsing = !q.trim() && !category;

  return (
    <>
      <StudioHeader>
        <span className="text-[14px] font-medium text-s-ink-2">Connectors</span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1100px] px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(34px,5vw,46px)] leading-[1.05] tracking-[-0.01em]">Connectors</h1>
            <p className="mt-2 max-w-2xl text-[15.5px] text-s-ink-2">
              Connect the apps you use so Orbis can search them, answer questions from them and prepare drafts — all from one place. You choose what each one may do, and you can disconnect at any time.
            </p>
          </div>

          {notice && (
            <div className={cn("mt-5 flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-[13px]", notice.tone === "ok" ? "border-emerald-500/30 text-s-ink" : "border-red-500/30 text-s-danger")} role="status">
              {notice.tone === "ok" ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}
              <p className="min-w-0 flex-1">{notice.text}</p>
              <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="text-s-ink-3 hover:text-s-ink">
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          {loadError && <p role="alert" className="mt-5 rounded-xl border border-s-line px-3.5 py-2.5 text-[13px] text-s-danger">{loadError}</p>}
          {!user && (
            <p className="mt-5 rounded-xl border border-s-line px-3.5 py-2.5 text-[13px] text-s-ink-2">
              <Link href="/login?next=/connectors" className="font-medium text-s-ink underline">
                Sign in
              </Link>{" "}
              to connect your apps. You can browse what&apos;s available below.
            </p>
          )}
          {data?.admin && data.setup && !data.setup.keyConfigured && (
            <div className="mt-5 rounded-2xl border border-amber-500/40 p-4">
              <div className="flex items-center gap-2 text-[14px] font-medium">
                <KeyRound className="h-4 w-4" /> One-time setup for administrators
              </div>
              <p className="mt-1 text-[13px] text-s-ink-2">
                Connectors that use a sign-in need a secret key so Orbis can store each connection encrypted. Generate one here (it&apos;s created in your browser and never sent to Orbis), then add it in Vercel as <code className="font-mono">ORBIS_CONNECTOR_KEY</code>.
              </p>
              <KeyGenerator />
            </div>
          )}

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <div className="flex rounded-full border border-s-line p-0.5" role="tablist" aria-label="Connectors">
              {(["discover", "connected"] as const).map((t) => (
                <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn("h-8 rounded-full px-3.5 text-[13px]", tab === t ? "bg-s-hover font-medium text-s-ink" : "text-s-ink-3 hover:text-s-ink")}>
                  {t === "discover" ? "Discover" : `Connected${connected.length ? ` · ${connected.length}` : ""}`}
                </button>
              ))}
            </div>
            {tab === "discover" && (
              <label className="relative ml-auto w-full sm:w-72">
                <span className="sr-only">Search connectors</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  type="search"
                  placeholder="Search by name, category or what it does"
                  className="h-9 w-full rounded-full border border-s-line bg-transparent pl-9 pr-3 text-[13px] outline-none focus:border-s-line-strong"
                />
              </label>
            )}
          </div>

          {tab === "discover" ? (
            <>
              <div className="mt-4 flex flex-wrap gap-1.5" role="group" aria-label="Categories">
                <button type="button" onClick={() => setCategory(null)} aria-pressed={!category} className={cn("rounded-full border px-3 py-1 text-[12.5px]", !category ? "border-s-line-strong bg-s-hover text-s-ink" : "border-s-line text-s-ink-3 hover:text-s-ink")}>
                  All
                </button>
                {usedCategories.map((cat) => (
                  <button key={cat.id} type="button" onClick={() => setCategory(category === cat.id ? null : cat.id)} aria-pressed={category === cat.id} className={cn("rounded-full border px-3 py-1 text-[12.5px]", category === cat.id ? "border-s-line-strong bg-s-hover text-s-ink" : "border-s-line text-s-ink-3 hover:text-s-ink")}>
                    {cat.label}
                  </button>
                ))}
              </div>

              {!data && !loadError && <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="s-skeleton h-44 rounded-2xl" />)}</div>}

              {browsing && featured.length > 0 && (
                <section className="mt-7" aria-labelledby="featured">
                  <h2 id="featured" className="text-[12px] font-medium uppercase tracking-[0.1em] text-s-ink-3">
                    Featured
                  </h2>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {featured.map((c) => (
                      <ConnectorCard key={c.id} c={c} onOpen={() => setOpen(c.id)} />
                    ))}
                  </div>
                </section>
              )}

              {data && (
                <section className="mt-8" aria-labelledby="all">
                  <h2 id="all" className="text-[12px] font-medium uppercase tracking-[0.1em] text-s-ink-3">
                    {browsing ? "All connectors" : `${shown.length} result${shown.length === 1 ? "" : "s"}`}
                  </h2>
                  {shown.length === 0 ? (
                    <p className="mt-3 text-[14px] text-s-ink-3">No connector matches “{q}”. Orbis lists only the apps it can really connect to.</p>
                  ) : (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {(browsing ? all.filter((c) => !c.featured) : shown).map((c) => (
                        <ConnectorCard key={c.id} c={c} onOpen={() => setOpen(c.id)} />
                      ))}
                    </div>
                  )}
                </section>
              )}
            </>
          ) : (
            <ConnectedTab connected={connected} onOpen={setOpen} signedIn={!!user} status={data ? "ready" : loadError ? "error" : "loading"} />
          )}
        </div>
      </div>
      {current && (
        <ConnectorDialog
          entry={current}
          admin={!!data?.admin}
          setup={data?.setup ?? null}
          signedIn={!!user}
          onClose={() => setOpen(null)}
          onChanged={(msg) => {
            if (msg) setNotice(msg);
            void load();
          }}
        />
      )}
    </>
  );
}

function ConnectedTab({
  connected,
  onOpen,
  signedIn,
  status,
}: {
  connected: CatalogEntry[];
  onOpen: (id: string) => void;
  signedIn: boolean;
  /** Until the list arrives (or if it fails) there's no "nothing connected" to say. */
  status: "loading" | "error" | "ready";
}) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ items: ConnectorItem[]; runs: { connectorId: string; ok: boolean; summary: string | null; error: string | null }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const usable = connected.filter((c) => c.connection?.status === "connected" && c.available);

  const search = async () => {
    if (!q.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api("/api/connectors/search", { method: "POST", body: JSON.stringify({ query: q }) }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!signedIn) return <p className="mt-6 text-[14px] text-s-ink-3">Sign in to see your connections.</p>;
  if (status === "loading") return <div className="s-skeleton mt-6 h-24 rounded-2xl" role="status" aria-label="Loading your connections" />;
  // The page shows why loading failed; don't also claim there's nothing connected.
  if (status === "error") return null;
  if (!connected.length) return <p className="mt-6 text-[14px] text-s-ink-3">Nothing connected yet. Pick an app under Discover.</p>;
  const name = (id: string) => connected.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="mt-6 space-y-8">
      {usable.length > 0 && (
        <section aria-labelledby="search-all" className="s-card rounded-2xl p-4 sm:p-5">
          <h2 id="search-all" className="text-[15px] font-medium">
            Search your connected apps
          </h2>
          <p className="mt-1 text-[13px] text-s-ink-3">Searches {usable.map((c) => c.name).join(", ")} at once. In chat, just ask — Orbis picks the right apps.</p>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void search();
            }}
          >
            <input value={q} onChange={(e) => setQ(e.target.value)} maxLength={200} placeholder="e.g. quarterly plan" aria-label="Search connected apps" className="h-10 min-w-0 flex-1 rounded-full border border-s-line bg-transparent px-4 text-[14px] outline-none focus:border-s-line-strong" />
            <button type="submit" disabled={busy || !q.trim()} className="h-10 rounded-full bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink disabled:opacity-40">
              {busy ? "Searching…" : "Search"}
            </button>
          </form>
          {error && <p className="mt-3 text-[13px] text-s-danger">{error}</p>}
          {result && (
            <div className="mt-4 space-y-3">
              <ul className="flex flex-wrap gap-2 text-[12px]">
                {result.runs.map((r) => (
                  <li key={r.connectorId} className={cn("rounded-full border px-2.5 py-0.5", r.ok ? "border-s-line text-s-ink-3" : "border-red-500/30 text-s-danger")}>
                    {name(r.connectorId)}: {r.ok ? r.summary : r.error}
                  </li>
                ))}
              </ul>
              {result.items.length === 0 ? (
                <p className="text-[13px] text-s-ink-3">No results.</p>
              ) : (
                <ul className="divide-y divide-s-line rounded-xl border border-s-line">
                  {result.items.map((it, i) => (
                    <li key={i} className="flex items-start gap-3 px-3 py-2.5">
                      <BrandIcon id={it.connectorId} size={26} className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        {it.url ? (
                          <a href={it.url} target="_blank" rel="noreferrer" className="inline-flex max-w-full items-center gap-1 text-[13.5px] font-medium hover:underline">
                            <span className="truncate">{it.title}</span> <ArrowUpRight className="h-3 w-3 shrink-0" />
                          </a>
                        ) : (
                          <span className="text-[13.5px] font-medium">{it.title}</span>
                        )}
                        <p className="mt-0.5 line-clamp-2 text-[12.5px] text-s-ink-3">{it.snippet}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}
      <section aria-label="Your connections">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {connected.map((c) => (
            <ConnectorCard key={c.id} c={c} onOpen={() => onOpen(c.id)} />
          ))}
        </div>
      </section>
    </div>
  );
}
