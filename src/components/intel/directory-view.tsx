"use client";
import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { SectionTabs } from "@/components/research/section-tabs";
import { INTEL_TABS } from "@/components/research/tabs-config";
import { Badge, Button, Card, Notice, PageHeader, Skeleton } from "@/components/ui/primitives";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { ModelWithStatus } from "@/lib/ai/types";
import type { PriceValidation } from "@/lib/intel/pricing";
import type { ProviderListing } from "@/lib/intel/provider-sync";
import type { PrivacyProfile } from "@/lib/intel/types";
import { isSafeHttpUrl } from "@/lib/utils";
import { useIntelHistory } from "./use-intel-history";

type Row = ModelWithStatus & { priceValidation: PriceValidation; privacy: PrivacyProfile; policyPage: string | null };

const PRICE_TONE = { verified: "success", stale: "warning", unverified: "warning", invalid: "danger", simulated: "default" } as const;

function tri(v: boolean | null, yes: string, no: string) {
  return v === null ? <span className="text-faint">Not verified</span> : v ? yes : no;
}

export function DirectoryView() {
  const history = useIntelHistory();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [staleDays, setStaleDays] = useState(45);
  const [sync, setSync] = useState<ProviderListing[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void jsonFetch<{ models: Row[]; priceStaleDays: number }>("/api/intel/directory").then((r) => { setRows(r.models); setStaleDays(r.priceStaleDays); }).catch((e) => setError((e as Error).message));
  }, []);

  const versions = new Map<string, Set<string>>();
  for (const t of history.trials) for (const a of t.arms) if (a.servedModel) versions.set(a.modelId, (versions.get(a.modelId) ?? new Set()).add(a.servedModel));
  for (const b of history.benchmarks) if (b.servedModel) versions.set(b.modelId, (versions.get(b.modelId) ?? new Set()).add(b.servedModel));
  for (const u of history.usage) if (u.servedModel) versions.set(u.modelId, (versions.get(u.modelId) ?? new Set()).add(u.servedModel));

  const runSync = async () => {
    setBusy(true);
    setError(null);
    try {
      setSync((await jsonFetch<{ listings: ProviderListing[] }>("/api/intel/sync", { method: "POST" })).listings);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Model Directory" description="Every model Orbis can call, with where its price came from, when it was last checked, what is known about data handling, and which versions you have actually been served." actions={<Button variant="secondary" onClick={runSync} loading={busy}><RefreshCw className="h-4 w-4" /> Check provider model lists</Button>} />
      <SectionTabs tabs={INTEL_TABS} />
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}
      {!rows ? <Skeleton className="h-48" /> : (
        <div tabIndex={0} role="region" aria-label="Table (scrolls sideways)" className="overflow-x-auto rounded-2xl border border-border">
          <table className="w-full min-w-[1000px] text-left text-sm">
            <thead className="bg-panel text-xs uppercase tracking-wider text-faint">
              <tr><th className="px-3 py-3 font-medium">Model</th><th className="px-3 py-3 font-medium">Price (USD / 1M in · out)</th><th className="px-3 py-3 font-medium">Data handling</th><th className="px-3 py-3 font-medium">Versions served to you</th><th className="px-3 py-3 font-medium">Status</th></tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((m) => (
                <tr key={m.id} className="align-top">
                  <td className="px-3 py-3">
                    <div className="font-medium">{m.displayName}</div>
                    <div className="font-mono text-[11px] text-faint">{m.provider} · {m.providerModelId}</div>
                    <div className="mt-1 text-[11px] text-faint">Context {m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k (vendor-stated)` : "—"}</div>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-2"><span className="tabular-nums">{m.inputPrice === null ? "n/a" : `$${m.inputPrice} · $${m.outputPrice}`}</span><Badge tone={PRICE_TONE[m.priceValidation.status]}>{m.priceValidation.status}</Badge></div>
                    <div className="mt-1 text-[11px] text-faint">Verified: {m.lastVerifiedAt ? m.lastVerifiedAt.slice(0, 10) : "never"}{m.priceSourceUrl && isSafeHttpUrl(m.priceSourceUrl) && <> · <a href={m.priceSourceUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">source</a></>}</div>
                    <ul className="mt-1 space-y-0.5 text-[11px] text-muted">{m.priceValidation.issues.map((i) => <li key={i.message} className={i.level === "error" ? "text-danger" : ""}>{i.message}</li>)}</ul>
                  </td>
                  <td className="px-3 py-3 text-xs text-muted">
                    <div>Trains on API data: {tri(m.privacy.trainsOnApiData, "Yes", "No")}</div>
                    <div>Retention: {m.privacy.retentionDays === null ? <span className="text-faint">Not verified</span> : `${m.privacy.retentionDays} days`}</div>
                    <div>Zero retention: {tri(m.privacy.zeroRetentionAvailable, "Available", "No")}</div>
                    {m.privacy.verifiedAt && <div className="text-faint">Checked {m.privacy.verifiedAt}</div>}
                    <div className="mt-1 text-[11px] text-faint">{m.privacy.notes}</div>
                    {isSafeHttpUrl(m.policyPage) && <a href={m.policyPage} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent hover:underline">Provider policy <ExternalLink className="h-3 w-3" /></a>}
                  </td>
                  <td className="px-3 py-3 font-mono text-[11px] text-muted">{versions.get(m.id)?.size ? [...versions.get(m.id)!].map((v) => <div key={v}>{v}</div>) : <span className="font-sans text-faint">None observed yet</span>}</td>
                  <td className="px-3 py-3">{m.available ? <Badge tone="success">Available</Badge> : <Badge tone="warning" title={m.unavailableReason}>Needs key</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sync && (
        <Card className="mt-5 p-4">
          <div className="text-sm font-medium">Provider model lists</div>
          <div className="mt-2 grid gap-3 md:grid-cols-2">
            {sync.map((l) => (
              <div key={l.provider} className="rounded-xl border border-border p-3 text-xs text-muted">
                <div className="flex items-center gap-2 text-sm text-fg">{l.provider} {l.ok ? <Badge tone="success">{l.listed} listed</Badge> : <Badge tone="warning">{l.error}</Badge>}</div>
                {l.ok && (
                  <>
                    <div className="mt-1">{l.missingFromProvider.length ? <span className="text-warning">In your registry but not listed by the provider (renamed or retired?): {l.missingFromProvider.join(", ")}</span> : "All registry models are listed."}</div>
                    {l.notInRegistry.length > 0 && <div className="mt-1">Available but not in your registry (first {l.notInRegistry.length}): <span className="font-mono">{l.notInRegistry.slice(0, 10).join(", ")}</span></div>}
                    {l.reportedPrices.length > 0 && (
                      <div className="mt-2">
                        Provider-reported prices (per 1M tokens, by host):
                        <ul className="mt-1 font-mono">{l.reportedPrices.map((p) => <li key={`${p.providerModelId}-${p.host}`}>{p.providerModelId} @ {p.host}: {p.inputPer1M ?? "?"} / {p.outputPer1M ?? "?"}</li>)}</ul>
                        <p className="mt-1 font-sans text-faint">Shown for comparison only. Copy a figure into the registry with its source URL to use it.</p>
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      <details className="mt-6 rounded-2xl border border-border p-4 text-sm text-muted">
        <summary className="cursor-pointer font-medium text-fg">Where this data comes from</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li><b>Model availability</b>: whether this server has credentials for the provider. Model lists are cross-checked against each provider&apos;s <code>/v1/models</code> API on demand.</li>
          <li><b>Prices</b> are entered by the operator (database or <code>ORBIS_MODELS</code>) with a source URL and date — never scraped. They are validated for missing data, unit typos, unusual ratios and staleness (re-check every {staleDays} days). Price changes are logged to a history table.</li>
          <li><b>Costs</b> are provider-reported token counts × the verified price, marked “(est.)” when tokens were estimated. Compare against your provider billing export periodically.</li>
          <li><b>Data handling</b> defaults to “Not verified” because policies change and depend on your account and contract. Operators record what they have confirmed in <code>ORBIS_PRIVACY_PROFILES</code>.</li>
          <li><b>Versions</b> are the model strings providers return with each response, collected from your own calls.</li>
        </ul>
      </details>
    </div>
  );
}
