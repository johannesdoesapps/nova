"use client";
import { useState } from "react";
import { Bell, CircleAlert, Clock, ExternalLink, Lightbulb, Newspaper, Plus, RefreshCw, Settings2, Telescope, Trash2, X } from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, Notice, PageHeader, Select, Textarea } from "@/components/ui/primitives";
import { engine, useEngine } from "@/components/engine/api";
import { EngineError } from "@/components/engine/engine-error";
import { cn, isSafeHttpUrl, relativeTime } from "@/lib/utils";

interface SourceType { label: string; needs: string; sends_query: boolean; cost: string; kind: string }
interface Meta { source_types: Record<string, SourceType>; labels: Record<string, string>; sensitivity: Record<string, number>; opportunity_types: string[]; frequencies: string[]; kinds: string[]; status: { scheduler_running: boolean; last_beat_at: string | null; statement: string }; web_search_configured: boolean }
interface Freshness { state: string; last_checked_at: string | null; last_success_at: string | null; next_check_at: string | null; frequency: string; last_error: string | null }
interface Watch { id: string; name: string; kind: string; query: string; keywords: string[]; exclude_keywords: string[]; sources: { type: string; config: Record<string, string>; official: boolean; weight: number }[]; frequency: string; sensitivity: string; alert_mode: string; include_speculative_alerts: boolean; private_mode: boolean; status: string; baseline_at: string | null; freshness: Freshness; item_count: number; new_count: number; cost: { paid_queries_per_check: number } }
interface Item { id: string; watch_id: string; watch_name: string; url: string; title: string; summary: string; source_type: string; source_name: string; publisher: string; published_at: string | null; fetched_at: string; label: "confirmed" | "reported" | "speculative"; label_help: string; score: number; breakdown: Record<string, unknown>; change_kind: string | null; also_reported_by: { publisher: string; url: string }[] }
interface Profile { interests: string[]; opportunity_types: string[]; muted_terms: string[]; quiet_hours: { start: number; end: number; timezone_offset_minutes: number; enabled: boolean }; max_alerts_per_day: number; digest: string; channels: string[]; max_web_searches_per_day: number; retention_days: number }

const LABEL_TONE = { confirmed: "success", reported: "accent", speculative: "warning" } as const;
const FRESH_TONE: Record<string, "success" | "warning" | "danger" | "default"> = { fresh: "success", due: "warning", stale: "danger", error: "danger", never_checked: "default", manual: "default" };
type Tab = "feed" | "watches" | "patterns" | "alerts" | "digests" | "settings";

export function RadarView() {
  const meta = useEngine<Meta>("radar/meta");
  const watches = useEngine<{ watches: Watch[] }>("radar/watches");
  const [tab, setTab] = useState<Tab>("feed");
  const [creating, setCreating] = useState(false);
  const err = meta.error ?? watches.error;
  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Signal Radar" description="Follow topics, questions, projects, sources, industries and technologies. NOVA AI compares each check with a recorded baseline and surfaces what actually changed — with citations, labels and the time it last looked." actions={<Button onClick={() => { setTab("watches"); setCreating(true); }}><Plus className="h-4 w-4" /> Follow something</Button>} />
      {err && <div className="mb-4"><EngineError message={err} /></div>}
      {meta.data && (
        <Notice tone={meta.data.status.scheduler_running ? "success" : "warning"} title={meta.data.status.scheduler_running ? "Scheduled checks are running" : "No continuous monitoring on this server"} className="mb-4">
          {meta.data.status.statement} {meta.data.status.last_beat_at && `Worker last seen ${relativeTime(meta.data.status.last_beat_at)}.`}
        </Notice>
      )}
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-border" role="tablist">
        {([["feed", "Signals", Newspaper], ["watches", "Watches", Telescope], ["patterns", "Patterns & opportunities", Lightbulb], ["alerts", "Alerts", Bell], ["digests", "Digests", Clock], ["settings", "Settings", Settings2]] as const).map(([k, l, I]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cn("-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm", tab === k ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}><I className="h-4 w-4" />{l}</button>
        ))}
      </div>
      {tab === "feed" && <Feed watches={watches.data?.watches ?? []} labels={meta.data?.labels ?? {}} />}
      {tab === "watches" && <Watches list={watches.data?.watches ?? []} meta={meta.data} reload={watches.reload} creating={creating} setCreating={setCreating} />}
      {tab === "patterns" && <Patterns />}
      {tab === "alerts" && <Alerts />}
      {tab === "digests" && <Digests />}
      {tab === "settings" && meta.data && <ProfileSettings meta={meta.data} />}
    </div>
  );
}

function Feed({ watches, labels }: { watches: Watch[]; labels: Record<string, string> }) {
  const [watch, setWatch] = useState("");
  const [label, setLabel] = useState("");
  const [baseline, setBaseline] = useState(false);
  const q = new URLSearchParams({ ...(watch && { watch_id: watch }), ...(label && { label }), include_baseline: String(baseline) }).toString();
  const feed = useEngine<{ items: Item[] }>(`radar/feed?${q}`);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <Select value={watch} onChange={(e) => setWatch(e.target.value)} aria-label="Watch"><option value="">All watches</option>{watches.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>
        <Select value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label"><option value="">All labels</option><option value="confirmed">Confirmed</option><option value="reported">Reported</option><option value="speculative">Speculative</option></Select>
        <label className="flex items-center gap-1.5 text-muted"><input type="checkbox" checked={baseline} onChange={(e) => setBaseline(e.target.checked)} /> Include baseline items</label>
      </div>
      <div className="mb-3 flex flex-wrap gap-3 text-[11px] text-faint">{Object.entries(labels).map(([k, v]) => <span key={k}><Badge tone={LABEL_TONE[k as keyof typeof LABEL_TONE]}>{k}</Badge> {v}</span>)}</div>
      {feed.error && <EngineError message={feed.error} />}
      {feed.data?.items.length === 0 && <EmptyState icon={<Newspaper className="h-8 w-8" />} title="No new signals">The first check of each watch records a baseline; only later changes appear here. Use “Check now” on a watch, or include baseline items.</EmptyState>}
      <div className="space-y-2">{feed.data?.items.map((it) => <ItemCard key={it.id} it={it} onDismiss={async () => { await engine.post(`radar/items/${it.id}/dismiss`); void feed.reload(); }} />)}</div>
    </div>
  );
}

function ItemCard({ it, onDismiss }: { it: Item; onDismiss: () => void }) {
  const b = it.breakdown as Record<string, number | string[] | string | null>;
  return (
    <Card className="p-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge tone={LABEL_TONE[it.label]} title={it.label_help}>{it.label}</Badge>
        {it.change_kind && <Badge>{it.change_kind.replace(/_/g, " ")}</Badge>}
        <span className="text-faint">{it.watch_name}</span>
        <span className="ml-auto font-mono text-faint" title="Relevance score (0–100)">{it.score.toFixed(0)}</span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onDismiss} aria-label="Dismiss"><X className="h-3.5 w-3.5" /></Button>
      </div>
      {isSafeHttpUrl(it.url) ? <a href={it.url} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 flex items-start gap-1 font-medium hover:text-accent">{it.title} <ExternalLink className="mt-1 h-3 w-3 shrink-0" /></a> : <div className="mt-1 font-medium">{it.title}</div>}
      {it.summary && <p className="mt-1 line-clamp-2 text-sm text-muted">{it.summary}</p>}
      <div className="mt-1 text-[11px] text-faint">
        Source: {it.publisher} ({it.source_name}, {it.source_type}) · published {it.published_at ? it.published_at.slice(0, 10) : "date unknown"} · fetched {relativeTime(it.fetched_at)}
        {it.also_reported_by.length > 0 && <> · also reported by {it.also_reported_by.map((x) => x.publisher).join(", ")}</>}
      </div>
      <details className="mt-1 text-[11px] text-faint">
        <summary className="cursor-pointer text-accent">Why this score and label</summary>
        <div className="mt-1">{String(b.label_reason ?? "")}</div>
        <div className="font-mono">match {String(b.match)} + interest {String(b.interest)} + source {String(b.source)} + recency {String(b.recency)} + novelty {String(b.novelty)} + corroboration {String(b.corroboration)} {Number(b.penalty) ? `− muted ${Math.abs(Number(b.penalty))}` : ""} = {String(b.total)}</div>
        {Array.isArray(b.injection_flags) && b.injection_flags.length > 0 && <div className="text-warning">Contains instruction-like text ({(b.injection_flags as string[]).join(", ")}) — treated as data only.</div>}
      </details>
    </Card>
  );
}

function Watches({ list, meta, reload, creating, setCreating }: { list: Watch[]; meta: Meta | null; reload: () => Promise<void>; creating: boolean; setCreating: (v: boolean) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(null);
  const check = async (w: Watch) => {
    setBusy(w.id);
    setMsg(null);
    try {
      const r = await engine.post<{ status: string; baseline: boolean; fetched: number; new_items: number; alerts: number; errors: string[] }>(`radar/watches/${w.id}/check`);
      setMsg({ tone: r.status === "error" ? "danger" : r.errors.length ? "warning" : "success", text: r.baseline ? `Baseline recorded for “${w.name}” (${r.new_items} items). Future checks report changes against it.` : `Checked “${w.name}”: ${r.fetched} fetched, ${r.new_items} new, ${r.alerts} alert(s).${r.errors.length ? ` Issues: ${r.errors.join("; ")}` : ""}` });
      await reload();
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-3">
      {creating && meta && <WatchForm meta={meta} onClose={() => setCreating(false)} onSaved={async () => { setCreating(false); await reload(); }} />}
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {list.length === 0 && !creating && <EmptyState icon={<Telescope className="h-8 w-8" />} title="You're not following anything yet" action={<Button onClick={() => setCreating(true)}>Follow a topic</Button>} />}
      {list.map((w) => (
        <Card key={w.id} className="p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{w.name}</span>
            <Badge>{w.kind}</Badge>
            <Badge tone={FRESH_TONE[w.freshness.state] ?? "default"}>{w.freshness.state.replace("_", " ")}</Badge>
            {w.status === "paused" && <Badge tone="warning">paused</Badge>}
            {w.private_mode && <Badge tone="accent">private</Badge>}
            <div className="ml-auto flex gap-1">
              <Button size="sm" variant="secondary" loading={busy === w.id} onClick={() => check(w)}><RefreshCw className="h-3.5 w-3.5" /> Check now</Button>
              <Button size="sm" variant="ghost" onClick={async () => { await engine.patch(`radar/watches/${w.id}`, { status: w.status === "paused" ? "active" : "paused" }); await reload(); }}>{w.status === "paused" ? "Resume" : "Pause"}</Button>
              <Button size="sm" variant="ghost" aria-label="Delete watch" onClick={async () => { if (window.confirm(`Delete “${w.name}” and all its items?`)) { await engine.del(`radar/watches/${w.id}`); await reload(); } }}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          </div>
          <div className="mt-2 grid gap-2 text-xs text-muted sm:grid-cols-2 lg:grid-cols-4">
            <div><span className="text-faint">Query:</span> {w.query || "—"}</div>
            <div><span className="text-faint">Sources:</span> {w.sources.map((s) => meta?.source_types[s.type]?.label ?? s.type).join(", ")}</div>
            <div><span className="text-faint">Last checked:</span> {w.freshness.last_checked_at ? relativeTime(w.freshness.last_checked_at) : "never"} · <span className="text-faint">next:</span> {w.freshness.next_check_at ? relativeTime(w.freshness.next_check_at) : w.frequency === "manual" ? "manual only" : "after baseline"}</div>
            <div><span className="text-faint">Baseline:</span> {w.baseline_at ? relativeTime(w.baseline_at) : "not yet"} · {w.new_count} new since</div>
            <div className="sm:col-span-2"><span className="text-faint">Alerts:</span> {w.alert_mode} · sensitivity {w.sensitivity} (score ≥ {meta?.sensitivity[w.sensitivity]}){w.include_speculative_alerts ? " · includes speculation" : " · confirmed only for instant alerts"}</div>
            <div className="sm:col-span-2"><span className="text-faint">Cost:</span> {w.cost.paid_queries_per_check ? `${w.cost.paid_queries_per_check} paid web search per check` : "free sources only"} · {w.frequency}</div>
          </div>
          {w.freshness.last_error && <div className="mt-2 flex items-center gap-1 text-xs text-danger"><CircleAlert className="h-3.5 w-3.5" /> {w.freshness.last_error}</div>}
        </Card>
      ))}
    </div>
  );
}

function WatchForm({ meta, onClose, onSaved }: { meta: Meta; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ name: "", kind: "topic", query: "", keywords: "", exclude_keywords: "", frequency: "daily", sensitivity: "medium", alert_mode: "digest", include_speculative_alerts: false, private_mode: false });
  const [sources, setSources] = useState<{ type: string; config: Record<string, string>; official: boolean }[]>([{ type: "hacker_news", config: {}, official: false }, { type: "arxiv", config: {}, official: false }]);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setErr(null);
    try {
      await engine.post("radar/watches", { ...f, keywords: f.keywords.split(",").map((x) => x.trim()).filter(Boolean), exclude_keywords: f.exclude_keywords.split(",").map((x) => x.trim()).filter(Boolean), sources });
      await onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <Card className="space-y-3 border-accent/40 p-4">
      <div className="flex items-center justify-between"><div className="font-medium">Follow something new</div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button></div>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Name, e.g. Open-source vector DBs" className="h-9" aria-label="Name" />
        <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} aria-label="Kind">{meta.kinds.map((k) => <option key={k}>{k}</option>)}</Select>
        <Input value={f.query} onChange={(e) => setF({ ...f, query: e.target.value })} placeholder="Query, e.g. vector database" className="h-9" aria-label="Query" />
        <Input value={f.keywords} onChange={(e) => setF({ ...f, keywords: e.target.value })} placeholder="Extra keywords (comma-separated)" className="h-9" aria-label="Keywords" />
        <Input value={f.exclude_keywords} onChange={(e) => setF({ ...f, exclude_keywords: e.target.value })} placeholder="Exclude (comma-separated)" className="h-9" aria-label="Exclude keywords" />
        <Select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })} aria-label="Frequency">{meta.frequencies.map((x) => <option key={x}>{x}</option>)}</Select>
      </div>
      <div>
        <div className="mb-1 text-xs text-muted">Sources</div>
        {sources.map((s, i) => (
          <div key={i} className="mb-1 flex flex-wrap items-center gap-2 text-xs">
            <Select value={s.type} onChange={(e) => setSources(sources.map((x, j) => (j === i ? { ...x, type: e.target.value, config: {} } : x)))} aria-label="Source type">{Object.entries(meta.source_types).map(([k, v]) => <option key={k} value={k} disabled={k === "web_search" && !meta.web_search_configured}>{v.label}{k === "web_search" && !meta.web_search_configured ? " (needs key)" : ""}</option>)}</Select>
            {meta.source_types[s.type]?.needs === "url" && <Input value={s.config.url ?? ""} onChange={(e) => setSources(sources.map((x, j) => (j === i ? { ...x, config: { url: e.target.value } } : x)))} placeholder="https://…/feed.xml" className="h-8 w-64" aria-label="Feed URL" />}
            {meta.source_types[s.type]?.needs === "repo" && <Input value={s.config.repo ?? ""} onChange={(e) => setSources(sources.map((x, j) => (j === i ? { ...x, config: { repo: e.target.value } } : x)))} placeholder="owner/repo" className="h-8 w-48" aria-label="Repository" />}
            {s.type === "rss" && <label className="flex items-center gap-1"><input type="checkbox" checked={s.official} onChange={(e) => setSources(sources.map((x, j) => (j === i ? { ...x, official: e.target.checked } : x)))} /> official source</label>}
            <span className="text-faint">{meta.source_types[s.type]?.cost}{meta.source_types[s.type]?.sends_query ? " · receives your query" : ""}</span>
            <button type="button" onClick={() => setSources(sources.filter((_, j) => j !== i))} aria-label="Remove source"><X className="h-3.5 w-3.5 text-faint" /></button>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setSources([...sources, { type: "rss", config: {}, official: false }])}><Plus className="h-3 w-3" /> Add source</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Select value={f.sensitivity} onChange={(e) => setF({ ...f, sensitivity: e.target.value })} aria-label="Sensitivity">{Object.entries(meta.sensitivity).map(([k, v]) => <option key={k} value={k}>Sensitivity {k} (alert at ≥ {v})</option>)}</Select>
        <Select value={f.alert_mode} onChange={(e) => setF({ ...f, alert_mode: e.target.value })} aria-label="Alerts"><option value="off">No alerts</option><option value="digest">Digest only</option><option value="immediate">Instant alerts + digest</option></Select>
        <label className="flex items-center gap-1"><input type="checkbox" checked={f.include_speculative_alerts} onChange={(e) => setF({ ...f, include_speculative_alerts: e.target.checked })} /> Instant alerts for speculation too</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={f.private_mode} onChange={(e) => setF({ ...f, private_mode: e.target.checked })} /> Private (never send my query to third parties)</label>
      </div>
      <p className="text-[11px] text-faint">The first check records a baseline and raises no alerts. Checks happen on the schedule only while the NOVA worker is running; you can always press “Check now”.</p>
      {err && <EngineError message={err} />}
      <Button onClick={save} disabled={!f.name.trim()}>Start following</Button>
    </Card>
  );
}

function Patterns() {
  const p = useEngine<{ patterns: { term: string; recent: number; prior: number; lift: number; publishers: number; watch_name: string; note: string }[] }>("radar/patterns");
  const o = useEngine<{ opportunities: { item_id: string; title: string; url: string; types: string[]; matched_interests: string[]; deadline_text: string | null; label: string; score: number; why: string; watch_name: string; publisher: string }[] }>("radar/opportunities");
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="p-4">
        <div className="mb-1 font-medium">Emerging patterns</div>
        <p className="mb-3 text-xs text-faint">Terms appearing much more often in the last 14 days than in the baseline, across ≥ 2 publishers. Statistical patterns, not verified trends.</p>
        {p.data?.patterns.length === 0 && <p className="text-sm text-faint">Not enough new items yet.</p>}
        {p.data?.patterns.map((x) => <div key={x.watch_name + x.term} className="mb-1 flex items-center gap-2 text-sm"><span className="font-medium">{x.term}</span><Badge>×{x.lift}</Badge><span className="text-xs text-faint">{x.recent} recent vs {x.prior} before · {x.publishers} publishers · {x.watch_name}</span></div>)}
      </Card>
      <Card className="p-4">
        <div className="mb-1 font-medium">Opportunity Radar</div>
        <p className="mb-3 text-xs text-faint">Items that mention an opportunity type (grant, launch, API, dataset, tender…) and match your stated interests. Pattern matches, not recommendations — verify before acting.</p>
        {o.data?.opportunities.length === 0 && <p className="text-sm text-faint">No matches. Add interests in Settings.</p>}
        {o.data?.opportunities.map((x) => (
          <div key={x.item_id} className="mb-3 text-sm">
            <div className="flex flex-wrap items-center gap-1.5">{x.types.map((t) => <Badge key={t} tone="accent">{t}</Badge>)}<Badge tone={LABEL_TONE[x.label as keyof typeof LABEL_TONE]}>{x.label}</Badge>{x.deadline_text && <Badge tone="warning">deadline: {x.deadline_text}</Badge>}</div>
            {isSafeHttpUrl(x.url) ? <a href={x.url} target="_blank" rel="noopener noreferrer nofollow" className="mt-1 block font-medium hover:text-accent">{x.title}</a> : <div className="mt-1 font-medium">{x.title}</div>}
            <div className="text-xs text-muted">{x.why} · {x.publisher}</div>
          </div>
        ))}
      </Card>
    </div>
  );
}

function Alerts() {
  const a = useEngine<{ alerts: { id: string; kind: string; title: string; reason: string; score: number; delivery: string; channel: string; created_at: string; read_at: string | null }[] }>("radar/alerts");
  return (
    <div>
      <div className="mb-3 flex items-center justify-between"><p className="text-xs text-faint">Instant alerts are shown here (in-app). Email delivery needs an email provider, which this deployment doesn&apos;t have.</p><Button size="sm" variant="secondary" onClick={async () => { await engine.post("radar/alerts/read"); void a.reload(); }}>Mark all read</Button></div>
      {a.data?.alerts.length === 0 && <EmptyState icon={<Bell className="h-8 w-8" />} title="No alerts" />}
      <div className="space-y-2">
        {a.data?.alerts.map((x) => (
          <Card key={x.id} className={cn("p-3 text-sm", !x.read_at && "border-accent/40")}>
            <div className="flex flex-wrap items-center gap-2"><Badge tone={x.delivery === "immediate" ? "warning" : "default"}>{x.delivery === "immediate" ? "instant" : "held for digest"}</Badge><Badge>{x.kind.replace(/_/g, " ")}</Badge><span className="text-xs text-faint">{relativeTime(x.created_at)}</span></div>
            <div className="mt-1 font-medium">{x.title}</div>
            <div className="text-xs text-muted">{x.reason}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function Digests() {
  const d = useEngine<{ digests: { id: string; period: string; period_start: string; period_end: string; created_at: string; data: { summary: string[]; summary_method: string; sources: { n: number; title: string; url: string; publisher: string; published_at: string | null }[]; freshness: { watch: string; state: string; last_success_at: string | null }[]; patterns: { term: string; lift: number }[]; alerts_held: number } }[] }>("radar/digests");
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {(["daily", "weekly"] as const).map((p) => <Button key={p} size="sm" variant="secondary" loading={busy} onClick={async () => { setBusy(true); try { await engine.post("radar/digests", { period: p }); await d.reload(); } finally { setBusy(false); } }}>Generate {p} digest now</Button>)}
      </div>
      {d.data?.digests.length === 0 && <EmptyState icon={<Clock className="h-8 w-8" />} title="No digests yet" />}
      {d.data?.digests.map((x) => (
        <Card key={x.id} className="p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm"><Badge tone="accent">{x.period}</Badge><span className="text-faint">{x.period_start.slice(0, 10)} → {x.period_end.slice(0, 10)}</span><span className="text-xs text-faint">{x.data.alerts_held} alert(s) held for this digest</span></div>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{x.data.summary.map((s) => <li key={s}>{s}</li>)}</ul>
          <p className="mt-1 text-[11px] text-faint">Summary method: {x.data.summary_method}.</p>
          {x.data.sources.length > 0 && (
            <ol className="mt-2 space-y-0.5 text-xs text-muted">{x.data.sources.map((s) => <li key={s.n}>[{s.n}] {isSafeHttpUrl(s.url) ? <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="text-accent hover:underline">{s.title}</a> : s.title} — {s.publisher}{s.published_at ? `, ${s.published_at.slice(0, 10)}` : ""}</li>)}</ol>
          )}
          <div className="mt-2 text-[11px] text-faint">Freshness: {x.data.freshness.map((f) => `${f.watch} (${f.state.replace("_", " ")}${f.last_success_at ? `, checked ${f.last_success_at.slice(0, 16).replace("T", " ")} UTC` : ""})`).join(" · ")}</div>
        </Card>
      ))}
    </div>
  );
}

function ProfileSettings({ meta }: { meta: Meta }) {
  const p = useEngine<Profile>("radar/profile");
  const [draft, setDraft] = useState<Profile | null>(null);
  const [saved, setSaved] = useState(false);
  const cur = draft ?? p.data;
  if (!cur) return null;
  const set = (patch: Partial<Profile>) => { setDraft({ ...cur, ...patch }); setSaved(false); };
  const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
  return (
    <Card className="max-w-3xl space-y-4 p-4">
      <label className="block space-y-1 text-sm"><span className="text-xs text-muted">Interests (for relevance and Opportunity Radar)</span><Textarea value={cur.interests.join(", ")} onChange={(e) => set({ interests: list(e.target.value) })} rows={2} placeholder="climate AI, developer tools, EU regulation" /></label>
      <div className="text-xs text-muted">Opportunity types to look for</div>
      <div className="flex flex-wrap gap-2 text-xs">{meta.opportunity_types.map((t) => <label key={t} className="flex items-center gap-1"><input type="checkbox" checked={cur.opportunity_types.length === 0 || cur.opportunity_types.includes(t)} onChange={(e) => { const all = cur.opportunity_types.length ? cur.opportunity_types : meta.opportunity_types; set({ opportunity_types: e.target.checked ? [...all, t] : all.filter((x) => x !== t) }); }} /> {t}</label>)}</div>
      <label className="block space-y-1 text-sm"><span className="text-xs text-muted">Muted terms (items mentioning these lose 30 points and never alert)</span><Input value={cur.muted_terms.join(", ")} onChange={(e) => set({ muted_terms: list(e.target.value) })} className="h-9" /></label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm"><span className="text-xs text-muted">Digest</span><Select value={cur.digest} onChange={(e) => set({ digest: e.target.value })} className="w-full"><option value="off">Off</option><option value="daily">Daily</option><option value="weekly">Weekly</option></Select></label>
        <label className="space-y-1 text-sm"><span className="text-xs text-muted">Max instant alerts / day</span><Input type="number" value={cur.max_alerts_per_day} onChange={(e) => set({ max_alerts_per_day: Number(e.target.value) })} className="h-9" /></label>
        <label className="space-y-1 text-sm"><span className="text-xs text-muted">Max paid web searches / day</span><Input type="number" value={cur.max_web_searches_per_day} onChange={(e) => set({ max_web_searches_per_day: Number(e.target.value) })} className="h-9" /></label>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={cur.quiet_hours.enabled} onChange={(e) => set({ quiet_hours: { ...cur.quiet_hours, enabled: e.target.checked } })} /> Quiet hours</label>
        <Input type="number" min={0} max={23} value={cur.quiet_hours.start} onChange={(e) => set({ quiet_hours: { ...cur.quiet_hours, start: Number(e.target.value) } })} className="h-8 w-16" aria-label="Quiet hours start" /> to
        <Input type="number" min={0} max={23} value={cur.quiet_hours.end} onChange={(e) => set({ quiet_hours: { ...cur.quiet_hours, end: Number(e.target.value) } })} className="h-8 w-16" aria-label="Quiet hours end" />
        <span className="text-xs text-faint">UTC offset (min)</span><Input type="number" value={cur.quiet_hours.timezone_offset_minutes} onChange={(e) => set({ quiet_hours: { ...cur.quiet_hours, timezone_offset_minutes: Number(e.target.value) } })} className="h-8 w-20" aria-label="Timezone offset" />
      </div>
      <label className="block space-y-1 text-sm"><span className="text-xs text-muted">Keep fetched items for (days)</span><Input type="number" min={7} max={365} value={cur.retention_days} onChange={(e) => set({ retention_days: Number(e.target.value) })} className="h-9 w-32" /></label>
      <p className="text-[11px] text-faint">Privacy: watches are private to you. Queries for arXiv, Hacker News and web search are sent to those services; feeds and GitHub releases only reveal the URL being fetched. Deleting a watch deletes its items and alerts.</p>
      <div className="flex items-center gap-2"><Button onClick={async () => { await engine.put("radar/profile", cur); setSaved(true); setDraft(null); void p.reload(); }}>Save settings</Button>{saved && <span className="text-sm text-success">Saved.</span>}</div>
    </Card>
  );
}
