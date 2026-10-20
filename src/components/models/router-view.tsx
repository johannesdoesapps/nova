"use client";
import Link from "next/link";
import { useState } from "react";
import { Cpu, MessageSquare, Wand2 } from "lucide-react";
import type { ModelWithStatus } from "@/lib/ai/types";
import { Badge, Button, Card, Notice, PageHeader, Textarea } from "@/components/ui/primitives";
import { jsonFetch } from "@/hooks/use-ndjson";
import { cn } from "@/lib/utils";

interface Rec {
  modelId: string | null;
  task: { kind: string; estimatedTokens: number };
  explanation: string[];
  disclaimer: string;
}

function price(m: ModelWithStatus) {
  if (m.inputPrice === null || m.outputPrice === null) return "Not verified";
  if (m.inputPrice === 0 && m.outputPrice === 0) return "Free (simulated)";
  return `$${m.inputPrice} / $${m.outputPrice} per 1M`;
}

export function RouterView({ models }: { models: ModelWithStatus[] }) {
  const [prompt, setPrompt] = useState("");
  const [costSensitive, setCostSensitive] = useState(false);
  const [rec, setRec] = useState<Rec | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recommend = async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ prompt, costSensitive: String(costSensitive) });
      const r = await jsonFetch<{ recommendation: Rec }>(`/api/models?${qs}`);
      setRec(r.recommendation);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const recommended = models.find((m) => m.id === rec?.modelId);

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader
        title="Model Router"
        description="Every model Orbis can call, with its provider, capabilities and context window. Prices appear only when a verified figure is configured."
      />

      <Card className="p-4">
        <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Wand2 className="h-4 w-4 text-accent" /> Recommend a model</div>
        <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} maxLength={100000} placeholder="Paste a task or prompt — e.g. 'Summarise this meeting transcript' or a code snippet to debug." aria-label="Task" />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={costSensitive} onChange={(e) => setCostSensitive(e.target.checked)} className="accent-[var(--accent)]" />
            Prefer lower cost
          </label>
          <Button onClick={recommend} loading={loading} disabled={!prompt.trim()}>Recommend</Button>
        </div>
        {error && <Notice tone="danger" className="mt-3">{error}</Notice>}
        {rec && (
          <div className="mt-4 rounded-xl border border-accent/30 bg-accent-soft p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="accent">Task: {rec.task.kind}</Badge>
              <span className="text-xs text-faint">~{rec.task.estimatedTokens.toLocaleString()} tokens (estimate)</span>
            </div>
            <div className="mt-2 text-lg font-semibold">{recommended?.displayName ?? "No model available"}</div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
              {rec.explanation.map((e) => <li key={e}>{e}</li>)}
            </ul>
            <p className="mt-3 text-xs text-faint">{rec.disclaimer}</p>
            {recommended && (
              <Link href="/chat?new=1" className="mt-3 inline-flex items-center gap-1.5 text-sm text-accent hover:underline">
                <MessageSquare className="h-4 w-4" /> Open AI Chat and select {recommended.displayName}
              </Link>
            )}
          </div>
        )}
      </Card>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="bg-panel text-xs uppercase tracking-wider text-faint">
            <tr>
              <th className="px-4 py-3 font-medium">Model</th>
              <th className="px-4 py-3 font-medium">Provider</th>
              <th className="px-4 py-3 font-medium">Capabilities</th>
              <th className="px-4 py-3 font-medium">Context</th>
              <th className="px-4 py-3 font-medium">Price (in / out)</th>
              <th className="px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {models.map((m) => (
              <tr key={m.id} className={cn("bg-bg-elev/40", rec?.modelId === m.id && "bg-accent-soft")}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 font-medium"><Cpu className="h-4 w-4 text-faint" />{m.displayName}</div>
                  <div className="mt-0.5 max-w-xs text-xs text-faint">{m.description}</div>
                </td>
                <td className="px-4 py-3 text-muted">{m.provider}<div className="font-mono text-[11px] text-faint">{m.providerModelId}</div></td>
                <td className="px-4 py-3"><div className="flex flex-wrap gap-1">{m.capabilities.map((c) => <Badge key={c}>{c}</Badge>)}</div></td>
                <td className="px-4 py-3 tabular-nums text-muted">{m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : "—"}</td>
                <td className="px-4 py-3 text-muted">{price(m)}</td>
                <td className="px-4 py-3">{m.available ? <Badge tone="success">Available</Badge> : <Badge tone="warning" title={m.unavailableReason}>Needs key</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-faint">
        Context windows come from vendor model cards and should be re-verified (none are marked verified yet). Configure models and verified prices through the <code className="font-mono">model_registry</code> table or the <code className="font-mono">ORBIS_MODELS</code> env var. Availability reflects configured credentials, not live provider status.
      </p>
    </div>
  );
}
