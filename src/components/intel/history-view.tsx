"use client";
import { useMemo } from "react";
import { Download, Trash2 } from "lucide-react";
import { SectionTabs } from "@/components/research/section-tabs";
import { INTEL_TABS } from "@/components/research/tabs-config";
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Skeleton } from "@/components/ui/primitives";
import { formatUsd, relativeTime } from "@/lib/utils";
import { useIntelHistory } from "./use-intel-history";

export function HistoryView() {
  const h = useIntelHistory();

  const usage = useMemo(() => {
    const by = new Map<string, { calls: number; errors: number; fallbacks: number; inTok: number; outTok: number; cost: number; costUnknown: number; purposes: Map<string, number> }>();
    for (const u of h.usage) {
      const r = by.get(u.modelId) ?? { calls: 0, errors: 0, fallbacks: 0, inTok: 0, outTok: 0, cost: 0, costUnknown: 0, purposes: new Map() };
      r.calls++;
      if (u.status === "error") r.errors++;
      if (u.fallbackFrom) r.fallbacks++;
      r.inTok += u.inputTokens ?? 0;
      r.outTok += u.outputTokens ?? 0;
      if (u.cost === null) r.costUnknown++;
      else r.cost += u.cost;
      r.purposes.set(u.purpose, (r.purposes.get(u.purpose) ?? 0) + 1);
      by.set(u.modelId, r);
    }
    return [...by.entries()].sort((a, b) => b[1].calls - a[1].calls);
  }, [h.usage]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), trials: h.trials, benchmarks: h.benchmarks, usage: h.usage }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nova-evaluations-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Evaluation History" description="Every blind trial, benchmark run and tracked model call behind your fingerprint. Delete anything you don't want counted." actions={<Button variant="secondary" onClick={exportJson} disabled={h.loading}><Download className="h-4 w-4" /> Export JSON</Button>} />
      <SectionTabs tabs={INTEL_TABS} />
      {h.error && <Notice tone="danger" className="mb-4">{h.error}</Notice>}
      {h.loading ? <Skeleton className="h-40" /> : (
        <div className="space-y-5">
          <Card className="p-4">
            <div className="text-sm font-medium">Usage, last 30 days</div>
            {h.guest ? <p className="mt-1 text-sm text-faint">Usage tracking is available when signed in (it is stored per account with row-level security).</p> : usage.length === 0 ? <p className="mt-1 text-sm text-faint">No tracked calls.</p> : (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="text-xs text-faint"><tr><th className="py-1 font-medium">Model</th><th className="font-medium">Calls</th><th className="font-medium">Errors</th><th className="font-medium">Served via fallback</th><th className="font-medium">Tokens in / out</th><th className="font-medium">Est. cost</th><th className="font-medium">By feature</th></tr></thead>
                  <tbody className="divide-y divide-border">
                    {usage.map(([id, u]) => (
                      <tr key={id}><td className="py-1.5 font-mono text-xs">{id}</td><td className="tabular-nums">{u.calls}</td><td className="tabular-nums">{u.errors}</td><td className="tabular-nums">{u.fallbacks}</td><td className="tabular-nums text-xs">{u.inTok.toLocaleString()} / {u.outTok.toLocaleString()}</td><td className="text-xs">{u.costUnknown === u.calls ? "n/a" : formatUsd(u.cost)}{u.costUnknown > 0 && u.costUnknown < u.calls && <span className="text-faint"> (partial)</span>}</td><td className="text-xs text-muted">{[...u.purposes.entries()].map(([p, n]) => `${p} ${n}`).join(" · ")}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium">Blind trials ({h.trials.length})</div>
            {h.trials.length === 0 ? <EmptyState title="No trials yet" /> : (
              <ul className="mt-2 divide-y divide-border">
                {h.trials.slice(0, 200).map((t) => {
                  const w = t.arms.find((a) => a.label === t.winner);
                  return (
                    <li key={t.id} className="flex items-start gap-3 py-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5"><Badge>{t.category}</Badge><span className="text-xs text-faint">{relativeTime(t.createdAt)}</span>{t.arms.some((a) => a.simulated) && <Badge tone="warning">Simulated</Badge>}</div>
                        <div className="mt-0.5 truncate text-muted">{t.prompt}</div>
                        <div className="text-xs">{t.arms.map((a) => a.displayName).join(" vs ")} → <b>{w ? w.displayName : t.winner === "tie" ? "tie" : "both bad"}</b></div>
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => h.remove("trial", t.id)} aria-label="Delete trial"><Trash2 className="h-3.5 w-3.5" /></Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <div className="text-sm font-medium">Benchmark runs ({h.benchmarks.length})</div>
            {h.benchmarks.length === 0 ? <EmptyState title="No benchmark runs yet" /> : (
              <ul className="mt-2 divide-y divide-border">
                {h.benchmarks.map((r) => (
                  <li key={r.id} className="flex items-start gap-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5"><Badge>{r.category}</Badge><span>{r.testSetName}</span><span className="font-mono text-[11px] text-faint">{r.testSetHash}</span><span className="text-xs text-faint">{relativeTime(r.createdAt)}</span>{r.simulated && <Badge tone="warning">Simulated</Badge>}</div>
                      <div className="text-xs text-muted">{r.displayName} ({r.servedModel ?? "version not reported"}) · {r.results.filter((x) => x.passed).length}/{r.results.filter((x) => !x.error).length} passed{r.results.some((x) => x.error) ? ` · ${r.results.filter((x) => x.error).length} errors` : ""} · temperature {r.params.temperature ?? "provider default"}</div>
                    </div>
                    <Button variant="ghost" size="icon" onClick={() => h.remove("benchmark", r.id)} aria-label="Delete run"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
