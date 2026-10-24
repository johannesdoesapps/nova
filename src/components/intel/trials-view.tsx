"use client";
import { useState } from "react";
import { Eye, EyeOff, Shuffle, Star } from "lucide-react";
import { Markdown } from "@/components/common/markdown";
import { useModels } from "@/components/common/model-picker";
import { SectionTabs } from "@/components/research/section-tabs";
import { INTEL_TABS } from "@/components/research/tabs-config";
import { Badge, Button, Card, Notice, PageHeader, Select, Textarea } from "@/components/ui/primitives";
import { jsonFetch } from "@/hooks/use-ndjson";
import { BUILT_IN_TEST_SETS } from "@/lib/intel/testsets";
import { TASK_CATEGORIES, type TaskCategory, type TrialArm, type TrialRecord, type TrialWinner } from "@/lib/intel/types";
import { cn, formatUsd } from "@/lib/utils";
import { useIntelHistory } from "./use-intel-history";

interface Pending {
  token: string;
  shown: { label: "A" | "B"; text: string }[];
  redactions: number;
  simulated: boolean;
}

export function TrialsView() {
  const models = useModels();
  const history = useIntelHistory();
  const [category, setCategory] = useState<TaskCategory>("general");
  const [prompt, setPrompt] = useState("");
  const [testItemId, setTestItemId] = useState<string | null>(null);
  const [pairMode, setPairMode] = useState<"random" | "pick">("random");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [voided, setVoided] = useState<{ reason: string; arms: TrialArm[] } | null>(null);
  const [revealed, setRevealed] = useState<TrialRecord | null>(null);
  const [ratings, setRatings] = useState<{ A?: number; B?: number }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = models?.filter((m) => m.available) ?? [];
  const examples = BUILT_IN_TEST_SETS.filter((s) => s.category === category).flatMap((s) => s.items.map((i) => ({ ...i, setId: s.id })));

  const run = async () => {
    setBusy(true);
    setError(null);
    setPending(null);
    setRevealed(null);
    setVoided(null);
    setRatings({});
    try {
      const r = await jsonFetch<{ void: boolean; reason?: string; arms?: TrialArm[]; token?: string; shown: Pending["shown"]; redactions?: number; simulated?: boolean }>("/api/intel/trials", {
        method: "POST",
        body: JSON.stringify({ prompt, category, testItemId, modelIds: pairMode === "pick" ? [a, b] : undefined }),
      });
      if (r.void) setVoided({ reason: r.reason ?? "Trial voided.", arms: r.arms ?? [] });
      else setPending({ token: r.token!, shown: r.shown, redactions: r.redactions ?? 0, simulated: Boolean(r.simulated) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const vote = async (winner: TrialWinner) => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await jsonFetch<{ trial: TrialRecord; saved: boolean }>("/api/intel/trials/vote", { method: "POST", body: JSON.stringify({ token: pending.token, winner, ratings }) });
      history.addTrial(r.trial, r.saved);
      setRevealed(r.trial);
      setPending(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inCategory = history.trials.filter((t) => t.category === category).length;

  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Blind Model Trials" description="Two models answer the same prompt. You see them as A and B in random order, with self-identifying names hidden, and vote before anything else is revealed." />
      <SectionTabs tabs={INTEL_TABS} />

      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">Task type</span>
          <Select value={category} onChange={(e) => { setCategory(e.target.value as TaskCategory); setTestItemId(null); }} aria-label="Task category">
            {TASK_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
          <span className="text-xs text-faint">{inCategory} trial(s) recorded in this category</span>
        </div>
        <Textarea value={prompt} onChange={(e) => { setPrompt(e.target.value); setTestItemId(null); }} rows={4} maxLength={8000} placeholder="Use a real task you care about — your votes become your personal fingerprint." aria-label="Prompt" />
        {examples.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-faint">Or use a reproducible test prompt:</span>
            <Select value={testItemId ?? ""} onChange={(e) => { const it = examples.find((x) => `${x.setId}/${x.id}` === e.target.value); setTestItemId(it ? `${it.setId}/${it.id}` : null); if (it) setPrompt(it.prompt); }} aria-label="Test prompt">
              <option value="">Choose…</option>
              {examples.map((x) => <option key={`${x.setId}/${x.id}`} value={`${x.setId}/${x.id}`}>{x.setId} · {x.probes}</option>)}
            </Select>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Select value={pairMode} onChange={(e) => setPairMode(e.target.value as "random" | "pick")} aria-label="Model selection">
              <option value="random">Random pair (most blind)</option>
              <option value="pick">Choose two models</option>
            </Select>
            {pairMode === "pick" && (
              <>
                <Select value={a} onChange={(e) => setA(e.target.value)} aria-label="First model"><option value="">Model…</option>{available.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</Select>
                <Select value={b} onChange={(e) => setB(e.target.value)} aria-label="Second model"><option value="">Model…</option>{available.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</Select>
              </>
            )}
          </div>
          <Button onClick={run} loading={busy && !pending} disabled={!prompt.trim() || (pairMode === "pick" && (!a || !b || a === b))}>
            <Shuffle className="h-4 w-4" /> Run blind trial
          </Button>
        </div>
        {pairMode === "pick" && <p className="text-xs text-faint">You know which two models are in play, but not which is A or B.</p>}
        {error && <Notice tone="danger">{error}</Notice>}
        {history.guest && <p className="text-xs text-faint">Guest mode: trials are kept in this browser. Sign in to keep them in your account.</p>}
      </Card>

      {voided && (
        <Notice tone="warning" title="Trial voided" className="mt-4">
          {voided.reason} {voided.arms.map((x) => `${x.displayName}: ${x.error ?? "ok"}`).join(" · ")}
        </Notice>
      )}

      {pending && (
        <div className="mt-5 space-y-4">
          {pending.simulated && <Notice tone="warning">Demo mode: these are simulated answers. Votes on them are recorded but say nothing about real models.</Notice>}
          {pending.redactions > 0 && <Notice tone="info">{pending.redactions} model self-identification(s) were hidden to keep the trial blind.</Notice>}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
            {pending.shown.map((s) => (
              <Card key={s.label} className="flex flex-col p-4">
                <div className="mb-2 flex items-center justify-between">
                  <Badge tone="accent"><EyeOff className="h-3 w-3" /> Answer {s.label}</Badge>
                  <RatingStars value={ratings[s.label]} onChange={(v) => setRatings({ ...ratings, [s.label]: v })} />
                </div>
                <div className="min-h-24 flex-1"><Markdown text={s.text} /></div>
              </Card>
            ))}
          </div>
          <Card className="flex flex-wrap items-center justify-center gap-2 p-3">
            <span className="mr-2 text-sm text-muted">Which is better for your purpose?</span>
            <Button onClick={() => vote("A")} disabled={busy}>A is better</Button>
            <Button onClick={() => vote("B")} disabled={busy}>B is better</Button>
            <Button variant="secondary" onClick={() => vote("tie")} disabled={busy}>About the same</Button>
            <Button variant="secondary" onClick={() => vote("both_bad")} disabled={busy}>Both bad</Button>
          </Card>
        </div>
      )}

      {revealed && <Reveal trial={revealed} />}
    </div>
  );
}

function RatingStars({ value, onChange }: { value?: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Quality rating (optional)">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" onClick={() => onChange(n)} aria-label={`${n} star${n > 1 ? "s" : ""}`}>
          <Star className={cn("h-4 w-4", value && n <= value ? "fill-warning text-warning" : "text-faint")} />
        </button>
      ))}
    </div>
  );
}

function Reveal({ trial }: { trial: TrialRecord }) {
  const winner = trial.winner === "tie" ? "You rated them about the same." : trial.winner === "both_bad" ? "You rated both answers as bad." : `You preferred answer ${trial.winner}.`;
  return (
    <Card className="mt-5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium"><Eye className="h-4 w-4 text-accent" /> Revealed after your vote</div>
      <p className="mt-1 text-sm text-muted">{winner} One vote is one data point — preferences are only reported once there are enough trials.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {trial.arms.map((a) => (
          <div key={a.label} className={cn("rounded-xl border p-3", trial.winner === a.label ? "border-success/40 bg-success/[0.05]" : "border-border")}>
            <div className="flex items-center gap-2"><Badge tone="accent">{a.label}</Badge><span className="font-medium">{a.displayName}</span>{a.simulated && <Badge tone="warning">Simulated</Badge>}</div>
            <dl className="mt-2 grid grid-cols-2 gap-1 text-xs text-muted">
              <dt className="text-faint">Served version</dt><dd className="truncate font-mono">{a.servedModel ?? "not reported"}</dd>
              <dt className="text-faint">Latency</dt><dd>{a.latencyMs !== null ? `${a.latencyMs} ms` : "—"}</dd>
              <dt className="text-faint">Tokens in / out</dt><dd>{a.inputTokens ?? "—"} / {a.outputTokens ?? "—"}{a.tokensEstimated ? " (est.)" : ""}</dd>
              <dt className="text-faint">Cost</dt><dd>{formatUsd(a.cost)}</dd>
              {trial.ratings[a.label] && <><dt className="text-faint">Your rating</dt><dd>{trial.ratings[a.label]} / 5</dd></>}
            </dl>
          </div>
        ))}
      </div>
    </Card>
  );
}
