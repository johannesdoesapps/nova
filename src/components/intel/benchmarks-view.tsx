"use client";
import { useMemo, useState } from "react";
import { CheckCircle2, Play, Upload, XCircle } from "lucide-react";
import { ModelPicker, defaultModelId, useModels } from "@/components/common/model-picker";
import { IntervalBar } from "@/components/research/badges";
import { SectionTabs } from "@/components/research/section-tabs";
import { INTEL_TABS } from "@/components/research/tabs-config";
import { Badge, Button, Card, Notice, PageHeader, Select, Textarea } from "@/components/ui/primitives";
import { jsonFetch } from "@/hooks/use-ndjson";
import { DEFAULT_OPTIONS } from "@/lib/intel/fingerprint";
import { wilson } from "@/lib/intel/stats";
import { BUILT_IN_TEST_SETS, testSetHash } from "@/lib/intel/testsets";
import type { BenchmarkRun, CheckerSpec, TestSet } from "@/lib/intel/types";
import { formatUsd, relativeTime } from "@/lib/utils";
import { useIntelHistory } from "./use-intel-history";

function describeChecker(c: CheckerSpec): string {
  switch (c.type) {
    case "exact": return `exact answer “${c.answer}”`;
    case "contains_all": return `must contain: ${c.values.join(", ")}`;
    case "contains_any": return `must contain one of: ${c.values.join(", ")}`;
    case "regex": return `matches /${c.pattern}/`;
    case "numeric": return `number ${c.answer}${c.tolerance ? ` ± ${c.tolerance}` : ""}`;
    case "json_keys": return `JSON with keys ${c.keys.join(", ")}`;
    case "bullets": return `${c.count} bullets${c.maxWords ? `, ≤ ${c.maxWords} words each` : ""}`;
    case "lowercase": return "all lowercase";
    case "not_stated": return "must say the passage doesn't state it";
  }
}

export function BenchmarksView() {
  const models = useModels();
  const history = useIntelHistory();
  const [custom, setCustom] = useState<TestSet[]>([]);
  const sets = [...BUILT_IN_TEST_SETS, ...custom];
  const [setId, setSetId] = useState(BUILT_IN_TEST_SETS[0]!.id);
  const [picked, setPicked] = useState<string | undefined>();
  const modelId = picked ?? defaultModelId(models);
  const [maxItems, setMaxItems] = useState(8);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<BenchmarkRun | null>(null);
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);
  const set = sets.find((s) => s.id === setId)!;
  const hash = useMemo(() => testSetHash(set), [set]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await jsonFetch<{ run: BenchmarkRun; saved: boolean }>("/api/intel/benchmarks", {
        method: "POST",
        body: JSON.stringify({ modelId, maxItems, ...(set.builtIn ? { testSetId: set.id } : { testSet: set }) }),
      });
      history.addBenchmark(r.run, r.saved);
      setLast(r.run);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const importSet = () => {
    try {
      const parsed = JSON.parse(importText) as TestSet;
      if (!parsed.id || !Array.isArray(parsed.items)) throw new Error("Expected an object with id, name, category, version and items.");
      setCustom([...custom.filter((c) => c.id !== parsed.id), { ...parsed, builtIn: false }]);
      setSetId(parsed.id);
      setShowImport(false);
      setError(null);
    } catch (e) {
      setError(`Could not import: ${(e as Error).message}`);
    }
  };

  const runsForSet = history.benchmarks.filter((r) => r.testSetHash === hash);
  const byModel = new Map<string, { name: string; items: number; passed: number; runs: number; served: Set<string> }>();
  for (const r of runsForSet) {
    const m = byModel.get(r.modelId) ?? { name: r.displayName, items: 0, passed: 0, runs: 0, served: new Set<string>() };
    m.runs++;
    if (r.servedModel) m.served.add(r.servedModel);
    for (const it of r.results) if (!it.error) { m.items++; if (it.passed) m.passed++; }
    byModel.set(r.modelId, m);
  }

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Task Benchmarks" description="Reproducible test sets scored by deterministic checkers — no model grades another model. Results are only pooled for the same test-set version and the same served model version." />
      <SectionTabs tabs={INTEL_TABS} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={setId} onChange={(e) => setSetId(e.target.value)} aria-label="Test set">
              {sets.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.category}{s.builtIn ? "" : " (custom)"}</option>)}
            </Select>
            <Button variant="ghost" size="sm" onClick={() => setShowImport(!showImport)}><Upload className="h-3.5 w-3.5" /> Import custom set</Button>
          </div>
          {showImport && (
            <div className="space-y-2">
              <Textarea value={importText} onChange={(e) => setImportText(e.target.value)} rows={6} className="font-mono text-xs" placeholder={'{"id":"my-set","name":"My set","category":"coding","version":"1.0.0","systemPrompt":"…","items":[{"id":"q1","prompt":"…","checker":{"type":"exact","answer":"42"},"probes":"…"}]}'} aria-label="Custom test set JSON" />
              <Button size="sm" onClick={importSet} disabled={!importText.trim()}>Add test set</Button>
              <p className="text-[11px] text-faint">Custom sets stay in this page session; the exact items are hashed and stored with every run.</p>
            </div>
          )}
          <p className="text-sm text-muted">{set.description}</p>
          <div className="text-[11px] text-faint">Version {set.version} · fingerprint <span className="font-mono">{hash}</span> · {set.items.length} items</div>
          {set.systemPrompt && <div className="rounded-lg bg-bg-elev p-2 text-xs text-muted"><span className="text-faint">System prompt: </span>{set.systemPrompt}</div>}
          <ol className="max-h-72 space-y-1.5 overflow-y-auto text-xs">
            {set.items.map((it, i) => (
              <li key={it.id} className={i >= maxItems ? "opacity-50" : ""}>
                <div className="flex items-center gap-1.5"><span className="font-mono text-faint">{it.id}</span><Badge>{it.probes || "item"}</Badge></div>
                <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-muted">{it.prompt}</div>
                <div className="text-faint">Scored by: {describeChecker(it.checker)}</div>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <ModelPicker value={modelId} onChange={setPicked} models={models} />
              <Select value={String(maxItems)} onChange={(e) => setMaxItems(Number(e.target.value))} aria-label="Items per run">
                {[4, 6, 8, 12].map((n) => <option key={n} value={n}>{n} items</option>)}
              </Select>
            </div>
            <Button onClick={run} loading={busy} disabled={!modelId}><Play className="h-4 w-4" /> Run benchmark</Button>
          </div>
          <p className="text-[11px] text-faint">Each item is one model call and counts toward your daily limit. Temperature 0 where the provider allows it; otherwise the provider default, which is recorded with the run.</p>
          {error && <Notice tone="danger">{error}</Notice>}
        </Card>

        <div className="space-y-4">
          <Card className="p-4">
            <div className="text-sm font-medium">Results on this exact test-set version</div>
            {byModel.size === 0 ? <p className="mt-2 text-sm text-faint">No runs yet.</p> : (
              <table className="mt-2 w-full text-left text-sm">
                <thead className="text-xs text-faint"><tr><th className="py-1 font-medium">Model</th><th className="font-medium">Pass rate (95% CI)</th><th className="font-medium">Items</th><th className="font-medium">Versions</th></tr></thead>
                <tbody className="divide-y divide-border">
                  {[...byModel.entries()].map(([id, m]) => {
                    const w = wilson(m.passed, m.items);
                    return (
                      <tr key={id}>
                        <td className="py-2">{m.name}</td>
                        <td><div className="flex items-center gap-2"><IntervalBar low={w.low} high={w.high} point={w.p} reference={null} /><span className="tabular-nums text-xs">{Math.round(w.p * 100)}% ({Math.round(w.low * 100)}–{Math.round(w.high * 100)})</span></div></td>
                        <td className="tabular-nums text-xs">{m.items}{m.items < DEFAULT_OPTIONS.minBenchmarkItems && <Badge className="ml-1">below {DEFAULT_OPTIONS.minBenchmarkItems}</Badge>}</td>
                        <td className="max-w-[160px] truncate font-mono text-[11px] text-faint">{[...m.served].join(", ") || "not reported"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p className="mt-2 text-[11px] text-faint">Wide intervals mean few items: a 6/8 and a 7/8 are not meaningfully different. The Fingerprint page tests differences on identical items before calling one model better.</p>
          </Card>

          {last && (
            <Card className="p-4">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                Latest run: {last.displayName} · {last.results.filter((r) => r.passed).length}/{last.results.filter((r) => !r.error).length} passed
                {last.simulated && <Badge tone="warning">Simulated</Badge>}
                <span className="text-[11px] font-normal text-faint">{relativeTime(last.createdAt)} · served as {last.servedModel ?? "not reported"}</span>
              </div>
              <ul className="mt-3 space-y-2">
                {last.results.map((r) => (
                  <li key={r.itemId} className="rounded-lg border border-border p-2 text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {r.error ? <Badge tone="warning">error</Badge> : r.passed ? <CheckCircle2 className="h-4 w-4 text-success" /> : <XCircle className="h-4 w-4 text-danger" />}
                      <span className="font-mono text-faint">{r.itemId}</span>
                      <span className="text-muted">{r.error ?? r.detail}</span>
                      <span className="ml-auto text-faint">{r.latencyMs ?? "—"} ms · {formatUsd(r.cost)}</span>
                    </div>
                    {r.output && <details className="mt-1"><summary className="cursor-pointer text-accent">Output</summary><pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-bg-elev p-2 text-muted">{r.output}</pre></details>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
