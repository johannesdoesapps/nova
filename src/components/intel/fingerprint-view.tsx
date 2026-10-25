"use client";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, Route, Users, FlaskConical } from "lucide-react";
import { useModels } from "@/components/common/model-picker";
import { IntervalBar, SufficiencyBadge } from "@/components/research/badges";
import { SectionTabs } from "@/components/research/section-tabs";
import { INTEL_TABS } from "@/components/research/tabs-config";
import { Badge, Button, Card, EmptyState, Input, Notice, PageHeader, Select, Skeleton, Textarea } from "@/components/ui/primitives";
import { Markdown } from "@/components/common/markdown";
import { jsonFetch } from "@/hooks/use-ndjson";
import { computeFingerprint, type CategoryFingerprint, type CategoryRecommendation } from "@/lib/intel/fingerprint";
import type { RoutePlan } from "@/lib/intel/routing";
import { formatUsd } from "@/lib/utils";
import { useIntelHistory } from "./use-intel-history";

export function FingerprintView() {
  const models = useModels();
  const history = useIntelHistory();
  // One clock per page view keeps time decay stable across re-renders.
  const [now] = useState(() => new Date().toISOString());
  const fp = useMemo(
    () => (history.loading ? null : computeFingerprint({ trials: history.trials, benchmarks: history.benchmarks, usage: history.usage, models: models ?? [] }, { now })),
    [history.loading, history.trials, history.benchmarks, history.usage, models, now],
  );
  const names = new Map((models ?? []).map((m) => [m.id, m.displayName]));
  const active = fp?.categories.filter((c) => c.models.length > 0) ?? [];

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader
        title="Model Fingerprint"
        description="Which models work best for you, by task type, based only on what you have observed: your blind-trial votes (personal preference) and reproducible benchmark scores (measured performance). The two are never blended."
      />
      <SectionTabs tabs={INTEL_TABS} />

      {history.loading || !fp ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-3">
            <Stat label="Blind trials" value={fp.totals.trials} hint={`≥ ${fp.options.minPairTrials} per model pair before a preference is reported`} />
            <Stat label="Benchmark runs" value={fp.totals.benchmarkRuns} hint={`≥ ${fp.options.minBenchmarkItems} scored items per model before a measurement counts`} />
            <Stat label="Tracked calls (30 days)" value={history.guest ? "—" : fp.totals.usageRows} hint={history.guest ? "Usage tracking needs an account" : "From every Orbis feature"} />
          </div>
          {history.error && <Notice tone="danger" className="mb-4">{history.error}</Notice>}
          {active.length === 0 ? (
            <EmptyState icon={<FlaskConical className="h-8 w-8" />} title="No evaluation data yet" action={<div className="flex gap-2"><Link href="/intel/trials" className="text-sm text-accent hover:underline">Run a blind trial</Link><span className="text-faint">·</span><Link href="/intel/benchmarks" className="text-sm text-accent hover:underline">Run a benchmark</Link></div>}>
              Recommendations here come only from your own observations, so there is nothing to show until you run some.
            </EmptyState>
          ) : (
            <div className="space-y-5">{active.map((c) => <CategoryCard key={c.category} c={c} names={names} />)}</div>
          )}
          <RoutePlanner history={history} names={names} />
          <Methodology />
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint: string }) {
  return (
    <Card className="p-3">
      <div className="text-xs text-faint">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-faint">{hint}</div>
    </Card>
  );
}

function RecBox({ title, icon, rec, names }: { title: string; icon: ReactNode; rec: CategoryRecommendation; names: Map<string, string> }) {
  return (
    <div className="rounded-xl border border-border bg-bg-elev p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted">{icon}{title}</div>
        <SufficiencyBadge s={rec.sufficiency} />
      </div>
      <div className="mt-1 text-base font-semibold">{rec.modelId && rec.sufficiency !== "insufficient" ? names.get(rec.modelId) ?? rec.modelId : "No recommendation yet"}</div>
      <ul className="mt-1 space-y-0.5 text-xs text-muted">{rec.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
    </div>
  );
}

function CategoryCard({ c, names }: { c: CategoryFingerprint; names: Map<string, string> }) {
  const n = (id: string) => names.get(id) ?? c.models.find((m) => m.modelId === id)?.displayName ?? id;
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center gap-2"><h2 className="text-lg font-semibold capitalize">{c.category}</h2></div>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-3 md:grid-cols-2">
        <RecBox title="Your preference (blind trials)" icon={<Users className="h-3.5 w-3.5" />} rec={c.personal} names={names} />
        <RecBox title="Measured performance (benchmarks)" icon={<FlaskConical className="h-3.5 w-3.5" />} rec={c.general} names={names} />
      </div>
      <div tabIndex={0} role="region" aria-label="Table (scrolls sideways)" className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead className="text-xs text-faint">
            <tr><th className="py-1 font-medium">Model</th><th className="font-medium">Blind trials W/L/T</th><th className="font-medium">Preference rate (95% CI)</th><th className="font-medium">Avg rating</th><th className="font-medium">Benchmark pass (95% CI)</th><th className="font-medium">Latency p50 / p95</th><th className="font-medium">Avg cost / call</th><th className="font-medium">Version</th></tr>
          </thead>
          <tbody className="divide-y divide-border">
            {c.models.map((m) => (
              <tr key={m.modelId} className="align-top">
                <td className="py-2 font-medium">{n(m.modelId)}</td>
                <td className="tabular-nums text-xs">{m.personal.wins}/{m.personal.losses}/{m.personal.ties}{m.personal.bothBad ? <span className="text-faint"> · {m.personal.bothBad} both bad</span> : null}</td>
                <td>{m.personal.winRate ? <div className="flex items-center gap-2"><IntervalBar {...m.personal.winRate} point={m.personal.winRate.p} /><span className="text-xs tabular-nums">{Math.round(m.personal.winRate.p * 100)}%</span></div> : <span className="text-xs text-faint">—</span>}</td>
                <td className="text-xs tabular-nums">{m.personal.avgRating !== null ? `${m.personal.avgRating.toFixed(1)} (${m.personal.ratingN})` : "—"}</td>
                <td>{m.benchmark.passRate ? <div className="flex items-center gap-2"><IntervalBar {...m.benchmark.passRate} point={m.benchmark.passRate.p} reference={null} /><span className="text-xs tabular-nums">{Math.round(m.benchmark.passRate.p * 100)}% · {m.benchmark.items} items</span></div> : <span className="text-xs text-faint">—</span>}</td>
                <td className="text-xs tabular-nums">{m.ops.p50 !== null ? `${Math.round(m.ops.p50)} ms` : "—"} / {m.ops.p95 !== null ? `${Math.round(m.ops.p95)} ms` : <span className="text-faint">needs 20</span>}</td>
                <td className="text-xs">{formatUsd(m.ops.meanCost)}{m.ops.costPartial && <span className="text-faint"> (partial)</span>}</td>
                <td className="text-xs">
                  <div className="max-w-[150px] truncate font-mono text-[11px]" title={m.version.seen.join(", ")}>{m.version.current ?? "not reported"}</div>
                  {m.version.priorObservations > 0 && <div className="text-[11px] text-faint">{m.version.priorObservations} result(s) from older versions (down-weighted)</div>}
                  {m.version.drift && m.version.drift.verdict === "changed" && <div className="mt-0.5 flex items-center gap-1 text-[11px] text-warning"><AlertTriangle className="h-3 w-3" /> Behaviour changed vs {m.version.drift.from} (+{m.version.drift.improved} / −{m.version.drift.regressed})</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(c.pairwise.length > 0 || c.paired.length > 0) && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-accent">Head-to-head detail</summary>
          <ul className="mt-2 space-y-1 text-xs text-muted">
            {c.pairwise.map((p) => (
              <li key={`${p.a}-${p.b}`}>
                Blind: <b className="text-fg">{n(p.a)}</b> vs <b className="text-fg">{n(p.b)}</b> — {p.n} trial(s), {n(p.a)} preferred {Math.round(p.aPreferred * 100)}%
                {p.interval && ` (95% CI ${Math.round(p.interval.low * 100)}–${Math.round(p.interval.high * 100)}%)`} →{" "}
                {p.verdict === "insufficient" ? `not enough data (${p.needed} more needed)` : p.verdict === "no_clear_difference" ? "no clear difference" : `${n(p.verdict === "a_preferred" ? p.a : p.b)} preferred`}
              </li>
            ))}
            {c.paired.map((p) => (
              <li key={`${p.a}-${p.b}-${p.testSetId}`}>
                Benchmark {p.testSetId}: {p.shared} shared items; only {n(p.a)} passed {p.aOnly}, only {n(p.b)} passed {p.bOnly} →{" "}
                {p.verdict === "insufficient" ? "too few differing items to test" : p.verdict === "no_clear_difference" ? `no significant difference (p = ${p.pValue?.toFixed(2)})` : `${n(p.verdict === "a_better" ? p.a : p.b)} better (p = ${p.pValue?.toFixed(3)})`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function RoutePlanner({ history, names }: { history: ReturnType<typeof useIntelHistory>; names: Map<string, string> }) {
  const [prompt, setPrompt] = useState("");
  const [prefer, setPrefer] = useState<"personal" | "general">("personal");
  const [noTraining, setNoTraining] = useState(false);
  const [maxPrice, setMaxPrice] = useState("");
  const [maxLatency, setMaxLatency] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [res, setRes] = useState<{ plan: RoutePlan; attempts?: { modelId: string; ok: boolean; error: string | null; skipped?: string }[]; result?: { displayName: string; text: string; simulated: boolean; latencyMs: number; cost: number | null } | null } | null>(null);

  const go = async (execute: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await jsonFetch<typeof res>("/api/intel/route", {
        method: "POST",
        body: JSON.stringify({
          prompt,
          execute,
          constraints: { prefer, requireNoTraining: noTraining || undefined, maxPricePer1M: maxPrice ? Number(maxPrice) : null, maxP50LatencyMs: maxLatency ? Number(maxLatency) : null },
          history: history.guest ? { trials: history.trials.slice(0, 1000), benchmarks: history.benchmarks.slice(0, 200) } : undefined,
        }),
      });
      setRes(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-6 p-4">
      <div className="flex items-center gap-2 text-sm font-medium"><Route className="h-4 w-4 text-accent" /> Routing planner</div>
      <p className="mt-1 text-xs text-muted">See which model Orbis would route a prompt to under your constraints, why, and what it falls back to if a provider fails.</p>
      <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} className="mt-3" placeholder="A prompt to route…" maxLength={12000} aria-label="Prompt to route" />
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <Select value={prefer} onChange={(e) => setPrefer(e.target.value as "personal" | "general")} aria-label="Evidence to trust first">
          <option value="personal">Trust my preference first</option>
          <option value="general">Trust benchmarks first</option>
        </Select>
        <label className="flex items-center gap-1.5 text-muted"><input type="checkbox" checked={noTraining} onChange={(e) => setNoTraining(e.target.checked)} className="accent-[var(--accent)]" /> Only providers verified not to train on API data</label>
        <Input value={maxPrice} onChange={(e) => setMaxPrice(e.target.value.replace(/[^\d.]/g, ""))} placeholder="Max $ / 1M (in+out)" className="h-9 w-40" aria-label="Maximum price" />
        <Input value={maxLatency} onChange={(e) => setMaxLatency(e.target.value.replace(/\D/g, ""))} placeholder="Max p50 ms" className="h-9 w-32" aria-label="Maximum latency" />
      </div>
      <div className="mt-3 flex gap-2">
        <Button variant="secondary" onClick={() => go(false)} loading={busy} disabled={!prompt.trim()}>Plan route</Button>
        <Button onClick={() => go(true)} loading={busy} disabled={!prompt.trim()}>Plan and run</Button>
      </div>
      {error && <Notice tone="danger" className="mt-3">{error}</Notice>}
      {res && (
        <div className="mt-4 space-y-3">
          <div className="rounded-xl border border-accent/30 bg-accent-soft p-3">
            <div className="flex flex-wrap items-center gap-2"><Badge tone="accent">{res.plan.category}</Badge><SufficiencyBadge s={res.plan.sufficiency} /><Badge>{res.plan.basis.replace("_", " ")}</Badge></div>
            <div className="mt-1 text-lg font-semibold">{res.plan.primary ? names.get(res.plan.primary) ?? res.plan.primary : "No eligible model"}</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-muted">{res.plan.explanation.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
          {res.plan.excluded.length > 0 && (
            <details><summary className="cursor-pointer text-xs text-accent">Excluded models ({res.plan.excluded.length})</summary>
              <ul className="mt-1 space-y-0.5 text-xs text-muted">{res.plan.excluded.map((e) => <li key={e.modelId}>{names.get(e.modelId) ?? e.modelId}: {e.reason}</li>)}</ul>
            </details>
          )}
          {res.attempts && (
            <div className="text-xs text-muted">
              Attempts: {res.attempts.map((a, i) => <span key={i} className="mr-2">{names.get(a.modelId) ?? a.modelId} {a.ok ? "✓" : a.skipped ? `skipped (${a.skipped})` : `✗ ${a.error}`}</span>)}
            </div>
          )}
          {res.result && (
            <Card className="p-3">
              <div className="mb-1 flex items-center gap-2 text-xs text-faint">{res.result.displayName} · {res.result.latencyMs} ms · {formatUsd(res.result.cost)} {res.result.simulated && <Badge tone="warning">Simulated</Badge>}</div>
              <Markdown text={res.result.text} />
            </Card>
          )}
        </div>
      )}
    </Card>
  );
}

function Methodology() {
  return (
    <details className="mt-6 rounded-2xl border border-border p-4 text-sm text-muted">
      <summary className="cursor-pointer font-medium text-fg">How these numbers are produced</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li><b>Personal preference</b> comes only from your blind votes. A pair of models needs at least 10 trials, and a preference is reported only when the 95% Wilson interval excludes 50%. Ties count half; “both bad” is excluded from preference but shown.</li>
        <li><b>Measured performance</b> comes only from deterministic benchmark checkers. A model needs 20 scored items; one model is called better only when an exact paired test on the same items gives p &lt; 0.05.</li>
        <li><b>Versions</b>: the provider-reported served model is recorded on every call. Benchmarks are pooled only within the current version; older-version trial votes count at half weight, and a significant change on the same test items is flagged as drift.</li>
        <li><b>Recency</b>: trial votes decay with a 90-day half-life so stale impressions fade.</li>
        <li><b>Latency</b> p50 needs 3 observations and p95 needs 20. Cost is shown only where a verified price exists, and marked partial otherwise.</li>
        <li>Simulated (demo) results are labelled and excluded from latency figures. Vendor claims and public leaderboards are not used anywhere on this page.</li>
      </ul>
    </details>
  );
}
