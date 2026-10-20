"use client";
import { useState } from "react";
import { Clock, Coins, Cpu, Swords, Trophy, AlertTriangle } from "lucide-react";
import { Markdown } from "@/components/common/markdown";
import { CopyButton } from "@/components/common/copy-button";
import { useModels } from "@/components/common/model-picker";
import { SaveToProject, saveNote } from "@/components/projects/save-to-project";
import { useApp } from "@/components/layout/app-context";
import { Badge, Button, Card, Notice, PageHeader, Skeleton, Textarea } from "@/components/ui/primitives";
import { jsonFetch } from "@/hooks/use-ndjson";
import { cn, formatUsd } from "@/lib/utils";

interface Result {
  modelId: string;
  displayName: string;
  provider: string;
  status: "success" | "error";
  text: string;
  error: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensEstimated: boolean;
  estimatedCost: number | null;
  simulated: boolean;
}

export function BattleView({ maxModels }: { maxModels: number }) {
  const { user } = useApp();
  const models = useModels();
  const [prompt, setPrompt] = useState("");
  const [picked, setSelected] = useState<string[] | null>(null);
  const selected = picked ?? (models ?? []).filter((m) => m.available).slice(0, 2).map((m) => m.id);
  const [results, setResults] = useState<Result[] | null>(null);
  const [ranPrompt, setRanPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preferred, setPreferred] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : selected.length >= maxModels ? selected : [...selected, id]);

  const run = async () => {
    setRunning(true);
    setError(null);
    setPreferred(null);
    setSavedId(null);
    setRanPrompt(prompt);
    setResults(
      selected.map((id) => {
        const m = models?.find((x) => x.id === id);
        return { modelId: id, displayName: m?.displayName ?? id, provider: m?.provider ?? "", status: "success", text: "", error: null, latencyMs: null, inputTokens: null, outputTokens: null, tokensEstimated: false, estimatedCost: null, simulated: false };
      }),
    );
    try {
      const r = await jsonFetch<{ results: Result[] }>("/api/compare", { method: "POST", body: JSON.stringify({ prompt, modelIds: selected }) });
      setResults(r.results);
    } catch (e) {
      setError((e as Error).message);
      setResults(null);
    } finally {
      setRunning(false);
    }
  };

  const saveComparison = async (projectId: string | null) => {
    if (!results) return;
    const r = await jsonFetch<{ comparison: { id: string } }>("/api/comparisons", {
      method: "POST",
      body: JSON.stringify({ prompt: ranPrompt, projectId, preferredModelId: preferred, results: results.map((r) => ({ modelId: r.modelId, displayName: r.displayName, provider: r.provider, status: r.status, text: r.text, error: r.error, latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, estimatedCost: r.estimatedCost, simulated: r.simulated })) }),
    });
    setSavedId(r.comparison.id);
  };

  const available = models?.filter((m) => m.available) ?? [];

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader
        title="Model Battle"
        description={`Run one prompt against up to ${maxModels} models side by side. Orbis shows measured latency and reported usage — it never invents quality scores.`}
      />

      <Card className="p-4">
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          maxLength={8000}
          placeholder="e.g. Explain the difference between RAG and fine-tuning for a product manager, in under 150 words."
          aria-label="Prompt"
        />
        <div className="mt-3">
          <div className="mb-2 flex items-center justify-between text-xs text-faint">
            <span>Models ({selected.length}/{maxModels} selected)</span>
            <span>Each selected model counts as one run against your daily quota.</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {models === null
              ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-36" />)
              : models.map((m) => {
                  const on = selected.includes(m.id);
                  return (
                    <button
                      key={m.id}
                      disabled={!m.available || (!on && selected.length >= maxModels)}
                      onClick={() => toggle(m.id)}
                      aria-pressed={on}
                      title={m.available ? m.description : m.unavailableReason}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-40",
                        on ? "border-accent/50 bg-accent-soft text-fg" : "border-border text-muted hover:text-fg",
                      )}
                    >
                      <Cpu className={cn("h-3.5 w-3.5", on ? "text-accent" : "text-faint")} />
                      {m.displayName}
                      <span className="text-faint">· {m.provider}</span>
                    </button>
                  );
                })}
          </div>
          {models && available.length < 2 && (
            <Notice tone="warning" className="mt-3">At least two available models are needed. Add <code>OPENAI_API_KEY</code> and/or <code>HUGGINGFACE_API_KEY</code>.</Notice>
          )}
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={run} loading={running} disabled={!prompt.trim() || selected.length < 2}>
            <Swords className="h-4 w-4" /> Compare {selected.length} models
          </Button>
        </div>
      </Card>

      {error && <Notice tone="danger" className="mt-4" title="Comparison failed">{error}</Notice>}

      {results && (
        <>
          <div className={cn("mt-6 grid gap-4", results.length === 2 ? "lg:grid-cols-2" : "lg:grid-cols-3", "md:grid-cols-2")}>
            {results.map((r) => (
              <Card key={r.modelId} className={cn("flex flex-col p-4", preferred === r.modelId && "border-accent ring-1 ring-accent/40")}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{r.displayName}</div>
                    <div className="text-xs text-faint">{r.provider}</div>
                  </div>
                  <div className="flex gap-1">
                    {r.simulated && <Badge tone="warning">Simulated</Badge>}
                    {r.status === "error" && <Badge tone="danger">Failed</Badge>}
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted tabular-nums">
                  <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5 text-faint" />{r.latencyMs === null ? "—" : `${(r.latencyMs / 1000).toFixed(2)}s`}</span>
                  <span className="inline-flex items-center gap-1">
                    <Cpu className="h-3.5 w-3.5 text-faint" />
                    {r.inputTokens ?? "—"} in · {r.outputTokens ?? "—"} out{r.tokensEstimated ? " (est.)" : ""}
                  </span>
                  <span className="inline-flex items-center gap-1" title="Shown only when a verified price is configured"><Coins className="h-3.5 w-3.5 text-faint" />{formatUsd(r.estimatedCost)}</span>
                </div>
                <div className="mt-3 flex-1 border-t border-border pt-3">
                  {running && !r.text && !r.error ? (
                    <div className="space-y-2"><Skeleton className="h-4" /><Skeleton className="h-4 w-10/12" /><Skeleton className="h-4 w-8/12" /></div>
                  ) : r.status === "error" ? (
                    <div className="flex gap-2 text-sm text-danger"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{r.error}</div>
                  ) : (
                    <Markdown text={r.text || "_(empty response)_"} />
                  )}
                </div>
                {!running && r.status === "success" && (
                  <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border pt-2">
                    <CopyButton text={r.text} />
                    <SaveToProject label="Save answer" onSave={(pid) => saveNote(pid, { title: `${r.displayName}: ${ranPrompt.slice(0, 60)}`, content: r.text, sourceType: "comparison" })} />
                    <Button variant={preferred === r.modelId ? "primary" : "ghost"} size="sm" className="ml-auto" onClick={() => setPreferred(preferred === r.modelId ? null : r.modelId)}>
                      <Trophy className="h-3.5 w-3.5" /> {preferred === r.modelId ? "Preferred" : "Prefer"}
                    </Button>
                  </div>
                )}
              </Card>
            ))}
          </div>
          {!running && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-panel px-4 py-3">
              <p className="text-xs text-faint">
                Latency includes network time from this server. Your preference is your judgement, not an objective ranking.
              </p>
              <div className="flex items-center gap-2">
                {savedId ? (
                  <Badge tone="success">Comparison saved</Badge>
                ) : user ? (
                  <>
                    <Button variant="secondary" size="sm" onClick={() => void saveComparison(null).catch((e: Error) => setError(e.message))}>Save comparison</Button>
                    <SaveToProject label="Save to project" onSave={(pid) => saveComparison(pid)} />
                  </>
                ) : (
                  <span className="text-xs text-faint">Sign in to save comparisons.</span>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
