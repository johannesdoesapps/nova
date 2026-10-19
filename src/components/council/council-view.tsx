"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, ExternalLink, Globe, RotateCcw, Square, Trash2, Users } from "lucide-react";
import { useCatalog } from "@/components/common/model-picker";
import { Markdown } from "@/components/common/markdown";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { Segmented, Switch } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { ModelWithStatus } from "@/lib/ai/types";
import type { CouncilSource } from "@/lib/council/prompts";
import { cn } from "@/lib/utils";
import { ModelChips, defaultParticipants, participantPool } from "./model-chips";
import { ResponseCard, StepMeta, type StepState } from "./response-card";
import { LABELS, isAbort, runStep } from "./stream";

type Phase = "idle" | "sources" | "answers" | "review" | "synthesis" | "done" | "failed" | "cancelled";
type Mode = "quick" | "deep";
interface SessionSummary {
  id: string;
  question: string;
  mode: string;
  models: string[];
  created_at: string;
}

const MAX = 4;
const idle: StepState = { status: "idle", text: "" };

/** Prefer a reasoning-capable participant to write the synthesis. */
function defaultChair(pool: ModelWithStatus[], ids: string[]): string | undefined {
  const chosen = pool.filter((m) => ids.includes(m.id));
  return (chosen.find((m) => m.capabilities.includes("reasoning")) ?? chosen[0])?.id;
}

export function CouncilView() {
  const { user, integrations } = useApp();
  const catalog = useCatalog();
  const pool = useMemo(() => participantPool(catalog?.models ?? null), [catalog]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const selected = picked ?? defaultParticipants(pool);
  const [chairPick, setChairPick] = useState<string | null>(null);
  const chairId = chairPick && selected.includes(chairPick) ? chairPick : defaultChair(pool, selected);
  const [mode, setMode] = useState<Mode>("quick");
  const [useWeb, setUseWeb] = useState(false);
  const [question, setQuestion] = useState("");

  const [asked, setAsked] = useState<string>("");
  const [order, setOrder] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [answers, setAnswers] = useState<Record<string, StepState>>({});
  const [critiques, setCritiques] = useState<Record<string, StepState>>({});
  const [synthesis, setSynthesis] = useState<StepState>(idle);
  const [synthChair, setSynthChair] = useState<string | undefined>();
  const [sources, setSources] = useState<CouncilSource[]>([]);
  const [sourcesNote, setSourcesNote] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const modelById = useCallback((id: string) => catalog?.models.find((m) => m.id === id), [catalog]);
  const label = (id: string) => LABELS[order.indexOf(id)] ?? "Response";
  const running = ["sources", "answers", "review", "synthesis"].includes(phase);

  const [sessionsVersion, setSessionsVersion] = useState(0);
  const loadSessions = useCallback(() => setSessionsVersion((v) => v + 1), []);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    jsonFetch<{ sessions: SessionSummary[] }>("/api/council/sessions?kind=council")
      .then((r) => alive && setSessions(r.sessions))
      .catch(() => alive && setSessions([]));
    return () => {
      alive = false;
    };
  }, [user, sessionsVersion]);

  const patchMap = (set: typeof setAnswers, id: string, p: Partial<StepState>) => set((s) => ({ ...s, [id]: { ...(s[id] ?? idle), ...p } }));

  const answerOne = async (id: string, q: string, src: CouncilSource[], signal: AbortSignal): Promise<StepState> => {
    patchMap(setAnswers, id, { status: "running", text: "", error: undefined });
    let final: StepState;
    try {
      const r = await runStep("answer", { question: q, modelId: id, sources: src }, signal, (text) => patchMap(setAnswers, id, { text }));
      final = { status: "done", text: r.text, latencyMs: r.latencyMs, outputTokens: r.usage?.outputTokens, tokensEstimated: r.usage?.estimated, estimatedCost: r.estimatedCost, simulated: r.simulated };
    } catch (e) {
      final = isAbort(e) ? { status: "cancelled", text: "" } : { status: "error", text: "", error: (e as Error).message };
    }
    patchMap(setAnswers, id, final);
    return final;
  };

  const synthesize = async (q: string, ids: string[], texts: Record<string, string>, crit: Record<string, string>, src: CouncilSource[], chair: string, signal: AbortSignal) => {
    setPhase("synthesis");
    setSynthChair(chair);
    setSynthesis({ status: "running", text: "" });
    const responses = ids.filter((id) => texts[id]).map((id) => ({ label: LABELS[ids.indexOf(id)]!, text: texts[id]! }));
    const critiqueList = ids.filter((id) => crit[id]).map((id) => ({ label: `Review by ${LABELS[ids.indexOf(id)]}`, text: crit[id]! }));
    try {
      const r = await runStep("synthesize", { question: q, modelId: chair, kind: "council", responses, critiques: critiqueList, sources: src }, signal, (text) => setSynthesis((s) => ({ ...s, text })));
      const final: StepState = { status: "done", text: r.text, latencyMs: r.latencyMs, outputTokens: r.usage?.outputTokens, tokensEstimated: r.usage?.estimated, estimatedCost: r.estimatedCost, simulated: r.simulated };
      setSynthesis(final);
      setPhase("done");
      return final;
    } catch (e) {
      setSynthesis(isAbort(e) ? { status: "cancelled", text: "" } : { status: "error", text: "", error: (e as Error).message });
      setPhase(isAbort(e) ? "cancelled" : "failed");
      return null;
    }
  };

  const save = async (q: string, ids: string[], texts: Record<string, string>, states: Record<string, StepState>, crit: Record<string, string>, synth: StepState | null, chair: string, src: CouncilSource[], m: Mode) => {
    if (!user) return setSaveNote("Sign in to keep Council sessions.");
    try {
      await jsonFetch("/api/council/sessions", {
        method: "POST",
        body: JSON.stringify({
          kind: "council",
          question: q,
          mode: m,
          models: ids,
          result: {
            answers: ids.map((id) => ({ modelId: id, label: LABELS[ids.indexOf(id)], text: texts[id] ?? "", status: texts[id] ? "done" : states[id]?.status === "cancelled" ? "cancelled" : "error", latencyMs: states[id]?.latencyMs ?? null })),
            critiques: ids.filter((id) => crit[id]).map((id) => ({ modelId: id, label: `Review by ${LABELS[ids.indexOf(id)]}`, text: crit[id] })),
            synthesis: synth?.text ? { modelId: chair, text: synth.text } : null,
            sources: src,
          },
        }),
      });
      setSaveNote("Saved to your Council history.");
      void loadSessions();
    } catch (e) {
      setSaveNote(`Not saved: ${(e as Error).message}`);
    }
  };

  const run = async () => {
    const q = question.trim();
    if (!q || running || selected.length < 2 || !chairId) return;
    const ac = new AbortController();
    abortRef.current = ac;
    const ids = [...selected];
    const chair = chairId;
    const m = mode;
    setAsked(q);
    setOrder(ids);
    setAnswers(Object.fromEntries(ids.map((id) => [id, { status: "idle", text: "" }])));
    setCritiques({});
    setSynthesis(idle);
    setSources([]);
    setSourcesNote(null);
    setSaveNote(null);

    let src: CouncilSource[] = [];
    if (useWeb) {
      setPhase("sources");
      try {
        const r = await jsonFetch<{ available: boolean; reason?: string; sources: CouncilSource[] }>("/api/council/sources", { method: "POST", body: JSON.stringify({ question: q }), signal: ac.signal });
        src = r.sources;
        setSources(src);
        setSourcesNote(r.available ? (src.length ? null : "The search returned no sources.") : (r.reason ?? "Web search is unavailable."));
      } catch (e) {
        if (isAbort(e)) return setPhase("cancelled");
        setSourcesNote(`Web search failed: ${(e as Error).message}`);
      }
    }

    setPhase("answers");
    const results = await Promise.all(ids.map((id) => answerOne(id, q, src, ac.signal)));
    if (ac.signal.aborted) return setPhase("cancelled");
    const states: Record<string, StepState> = Object.fromEntries(ids.map((id, i) => [id, results[i]!]));
    const texts: Record<string, string> = {};
    for (const id of ids) if (states[id]!.status === "done" && states[id]!.text) texts[id] = states[id]!.text;
    const ok = ids.filter((id) => texts[id]);
    if (!ok.length) return setPhase("failed");

    const crit: Record<string, string> = {};
    if (m === "deep" && ok.length >= 2) {
      setPhase("review");
      const responses = ok.map((id) => ({ label: LABELS[ids.indexOf(id)]!, text: texts[id]! }));
      await Promise.all(
        ok.map(async (id) => {
          patchMap(setCritiques, id, { status: "running", text: "" });
          try {
            const r = await runStep("critique", { question: q, modelId: id, responses, sources: src }, ac.signal, (text) => patchMap(setCritiques, id, { text }));
            crit[id] = r.text;
            patchMap(setCritiques, id, { status: "done", text: r.text, latencyMs: r.latencyMs, outputTokens: r.usage?.outputTokens, tokensEstimated: r.usage?.estimated, estimatedCost: r.estimatedCost });
          } catch (e) {
            patchMap(setCritiques, id, isAbort(e) ? { status: "cancelled" } : { status: "error", error: (e as Error).message });
          }
        }),
      );
      if (ac.signal.aborted) return setPhase("cancelled");
    }

    const synth = await synthesize(q, ids, texts, crit, src, chair, ac.signal);
    void save(q, ids, texts, states, crit, synth, chair, src, m);
  };

  const cancel = () => abortRef.current?.abort();

  /** Retry one failed model, then offer to re-synthesize with the new answer. */
  const retry = async (id: string) => {
    const ac = new AbortController();
    abortRef.current = ac;
    setPhase("answers");
    await answerOne(id, asked, sources, ac.signal);
    setPhase(synthesis.status === "done" ? "done" : "failed");
  };

  const resynthesize = async () => {
    const ac = new AbortController();
    abortRef.current = ac;
    const texts = Object.fromEntries(order.filter((id) => answers[id]?.status === "done" && answers[id]!.text).map((id) => [id, answers[id]!.text]));
    const crit = Object.fromEntries(order.filter((id) => critiques[id]?.status === "done").map((id) => [id, critiques[id]!.text]));
    if (!Object.keys(texts).length || !chairId) return;
    await synthesize(asked, order, texts, crit, sources, chairId, ac.signal);
  };

  const openSession = async (id: string) => {
    try {
      const { session } = await jsonFetch<{ session: SessionSummary & { result: { answers: { modelId: string; text: string; status: StepState["status"]; latencyMs?: number | null }[]; critiques: { modelId: string; text: string }[]; synthesis: { modelId: string; text: string } | null; sources: CouncilSource[] } } }>(`/api/council/sessions/${id}`);
      setAsked(session.question);
      setQuestion("");
      setOrder(session.models);
      setMode(session.mode === "deep" ? "deep" : "quick");
      setAnswers(Object.fromEntries(session.result.answers.map((a) => [a.modelId, { status: a.status === "done" ? "done" : a.status, text: a.text, latencyMs: a.latencyMs ?? null }])));
      setCritiques(Object.fromEntries(session.result.critiques.map((c) => [c.modelId, { status: "done", text: c.text }])));
      setSynthesis(session.result.synthesis ? { status: "done", text: session.result.synthesis.text } : idle);
      setSynthChair(session.result.synthesis?.modelId);
      setSources(session.result.sources);
      setSourcesNote(null);
      setSaveNote(null);
      setPhase(session.result.synthesis ? "done" : "failed");
      window.scrollTo({ top: 0 });
    } catch (e) {
      setSaveNote((e as Error).message);
    }
  };

  const removeSession = async (id: string) => {
    try {
      await jsonFetch(`/api/council/sessions/${id}`, { method: "DELETE" });
      setSessions((s) => s?.filter((x) => x.id !== id) ?? null);
    } catch {
      /* keep it listed */
    }
  };

  const searchReady = integrations.search;
  const answeredCount = order.filter((id) => answers[id]?.status === "done").length;
  const steps: { key: Phase[]; label: string; detail?: string }[] = [
    ...(sources.length || phase === "sources" ? [{ key: ["sources"] as Phase[], label: "Sources", detail: phase === "sources" ? "Searching…" : `${sources.length} found` }] : []),
    { key: ["answers"], label: "Answers", detail: `${answeredCount}/${order.length}` },
    ...(mode === "deep" ? [{ key: ["review"] as Phase[], label: "Peer review" }] : []),
    { key: ["synthesis"], label: "Synthesis" },
  ];
  const stepIndex = steps.findIndex((s) => s.key.includes(phase));
  const chairModel = synthChair ? modelById(synthChair) : undefined;

  return (
    <>
      <StudioHeader>
        <span className="text-[14px] font-medium text-s-ink-2">Council</span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(34px,5vw,46px)] leading-[1.05] tracking-[-0.01em]">Nova Council</h1>
            <p className="mt-2 max-w-2xl text-[15.5px] text-s-ink-2">
              Several AI models answer independently, can review each other, and Nova combines the result — with disagreements left visible.
            </p>
          </div>

          <form
            className="composer glass-strong glass-edge s-in mt-7 rounded-[26px] p-3 [animation-delay:60ms] sm:p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <label htmlFor="council-q" className="sr-only">
              Question for the Council
            </label>
            <textarea
              id="council-q"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void run();
                }
              }}
              rows={2}
              maxLength={12000}
              placeholder="Ask a question or describe a task for several models…"
              className="s-scroll block max-h-56 min-h-[64px] w-full resize-y bg-transparent px-2 pt-1 text-[16px] leading-relaxed text-s-ink outline-none placeholder:text-s-ink-3"
            />
            <div className="mt-3 space-y-3 border-t border-s-line px-1 pt-3">
              {catalog === null ? (
                <div className="s-skeleton h-9 w-2/3" />
              ) : pool.length < 2 ? (
                <p className="text-[13px] text-s-ink-3">Council needs at least two configured models. An administrator can add provider keys in Admin.</p>
              ) : (
                <ModelChips pool={pool} selected={selected} onChange={setPicked} max={MAX} disabled={running} />
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
                <Segmented
                  label="Council mode"
                  value={mode}
                  onChange={(v) => setMode(v)}
                  options={[
                    { value: "quick", label: "Quick" },
                    { value: "deep", label: "Deep" },
                  ]}
                />
                <label className="flex items-center gap-2 text-[13px] text-s-ink-2" title={searchReady ? "Search the web once and give every model the same sources" : "Web search isn't set up on this site"}>
                  <Switch label="Use web sources" checked={useWeb && searchReady} disabled={!searchReady || running} onChange={setUseWeb} />
                  <Globe className="h-3.5 w-3.5" /> Web sources
                </label>
                {selected.length >= 2 && (
                  <label className="flex items-center gap-2 text-[13px] text-s-ink-2">
                    Synthesis by
                    <span className="relative">
                      <select
                        value={chairId ?? ""}
                        onChange={(e) => setChairPick(e.target.value)}
                        disabled={running}
                        className="h-8 appearance-none rounded-lg border border-s-line bg-transparent pl-2.5 pr-7 text-[13px] text-s-ink outline-none"
                      >
                        {selected.map((id) => (
                          <option key={id} value={id} className="bg-s-bg">
                            {modelById(id)?.displayName ?? id}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-s-ink-3" />
                    </span>
                  </label>
                )}
                <div className="ml-auto flex items-center gap-2">
                  <span className="hidden text-[12px] text-s-ink-3 sm:inline">
                    {mode === "quick" ? `${selected.length + 1} model calls` : `${selected.length * 2 + 1} model calls`}
                  </span>
                  {running ? (
                    <button type="button" onClick={cancel} className="inline-flex h-10 items-center gap-2 rounded-full bg-s-ink px-4 text-[13.5px] font-medium text-s-bg transition hover:opacity-85">
                      <Square className="h-3.5 w-3.5 fill-current" /> Cancel
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!question.trim() || selected.length < 2}
                      className="inline-flex h-10 items-center gap-2 rounded-full bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink transition hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
                    >
                      <Users className="h-4 w-4" /> Convene
                      <ArrowUp className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
              {mode === "deep" && <p className="text-[12px] text-s-ink-3">Deep mode: each model also reviews all answers and proposes an improved one before the synthesis.</p>}
            </div>
          </form>

          {phase !== "idle" && (
            <section className="mt-8 space-y-6" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-3xl text-[15px] font-medium leading-snug">{asked}</p>
                <ol className="flex flex-wrap items-center gap-1.5 text-[12px]" aria-label="Progress">
                  {steps.map((s, i) => {
                    const done = phase === "done" || (stepIndex >= 0 && i < stepIndex);
                    const active = i === stepIndex && running;
                    return (
                      <li
                        key={s.label}
                        className={cn(
                          "rounded-full border px-2.5 py-1 transition",
                          active ? "border-transparent bg-s-ink text-s-bg" : done ? "border-s-line-strong text-s-ink-2" : "border-s-line text-s-ink-3",
                        )}
                      >
                        {s.label}
                        {s.detail ? ` · ${s.detail}` : ""}
                      </li>
                    );
                  })}
                  {phase === "cancelled" && <li className="rounded-full border border-s-line px-2.5 py-1 text-s-ink-3">Cancelled</li>}
                </ol>
              </div>

              {sourcesNote && <p className="rounded-xl border border-s-line px-3.5 py-2.5 text-[13px] text-s-ink-2">{sourcesNote}</p>}

              {(synthesis.status !== "idle" || phase === "failed") && (
                <article className="glass-strong glass-edge s-in rounded-[26px] p-5 sm:p-7">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-[11.5px] font-medium uppercase tracking-[0.1em] text-s-ink-3">Council synthesis</div>
                      <p className="mt-1 text-[12.5px] text-s-ink-3">
                        {chairModel ? `Written by ${chairModel.displayName} from ${answeredCount} answer${answeredCount === 1 ? "" : "s"}${mode === "deep" ? " and peer reviews" : ""}. ` : ""}
                        {sources.length
                          ? `Models saw ${sources.length} web source${sources.length === 1 ? "" : "s"}; individual claims were not verified.`
                          : "AI-generated opinions — not checked against external sources."}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StepMeta s={synthesis} />
                      {phase !== "synthesis" && answeredCount > 0 && (
                        <button type="button" onClick={resynthesize} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-s-line px-2.5 text-[12.5px] text-s-ink-2 transition hover:bg-s-hover hover:text-s-ink">
                          <RotateCcw className="h-3.5 w-3.5" /> Re-synthesize
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="mt-4">
                    {synthesis.status === "error" ? (
                      <p className="text-[13.5px] text-s-danger">{synthesis.error}</p>
                    ) : synthesis.text ? (
                      <Markdown text={synthesis.text} className="s-prose" />
                    ) : phase === "failed" ? (
                      <p className="text-[13.5px] text-s-danger">No model produced an answer, so there is nothing to synthesize. Retry a model below or change the selection.</p>
                    ) : (
                      <div className="space-y-2.5" aria-hidden>
                        <div className="s-skeleton h-3.5 w-[90%]" />
                        <div className="s-skeleton h-3.5 w-[75%]" />
                        <div className="s-skeleton h-3.5 w-[82%]" />
                      </div>
                    )}
                  </div>
                  {sources.length > 0 && (
                    <ol className="mt-5 grid gap-1.5 border-t border-s-line pt-4 text-[12.5px] sm:grid-cols-2">
                      {sources.map((s) => (
                        <li key={s.index} className="min-w-0">
                          <a href={s.url} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-s-ink-2 hover:text-s-ink">
                            <span className="text-s-ink-3">[{s.index}]</span>
                            <span className="truncate">{s.title}</span>
                            <ExternalLink className="h-3 w-3 shrink-0" />
                          </a>
                        </li>
                      ))}
                    </ol>
                  )}
                  {saveNote && <p className="mt-4 text-[12px] text-s-ink-3">{saveNote}</p>}
                </article>
              )}

              <div>
                <h2 className="mb-3 text-[13px] font-medium uppercase tracking-[0.1em] text-s-ink-3">Individual responses</h2>
                <div className={cn("grid gap-4", order.length >= 3 ? "md:grid-cols-2 xl:grid-cols-3" : "md:grid-cols-2")}>
                  {order.map((id) => {
                    const m = modelById(id);
                    const crit = critiques[id];
                    return (
                      <ResponseCard
                        key={id}
                        title={m?.displayName ?? id}
                        subtitle={label(id)}
                        provider={m?.provider ?? "demo"}
                        state={answers[id] ?? idle}
                        onRetry={running ? undefined : () => void retry(id)}
                        footer={
                          crit && crit.status !== "idle" ? (
                            <details className="w-full rounded-xl border border-s-line px-3 py-2 text-[13px]" open={crit.status === "running"}>
                              <summary className="cursor-pointer text-s-ink-2">
                                Peer review {crit.status === "running" ? "· writing…" : crit.status === "error" ? "· failed" : ""}
                              </summary>
                              {crit.status === "error" ? <p className="mt-2 text-s-danger">{crit.error}</p> : <Markdown text={crit.text} className="s-prose mt-2 text-[13.5px]" />}
                            </details>
                          ) : null
                        }
                      />
                    );
                  })}
                </div>
              </div>
            </section>
          )}

          {phase === "idle" && (
            <section className="s-in mt-10 grid gap-3 [animation-delay:120ms] sm:grid-cols-3">
              {[
                ["1 · Independent answers", "Each selected model answers on its own, in parallel."],
                ["2 · Peer review (Deep)", "Models critique every answer and propose improvements."],
                ["3 · Synthesis", "One model combines them and lists agreements, disagreements and what still needs checking."],
              ].map(([t, d]) => (
                <div key={t} className="glass rounded-[20px] p-4">
                  <div className="text-[13.5px] font-medium">{t}</div>
                  <p className="mt-1 text-[13px] leading-snug text-s-ink-3">{d}</p>
                </div>
              ))}
            </section>
          )}

          {!!sessions?.length && (
            <section className="mt-12">
              <h2 className="mb-3 text-[13px] font-medium uppercase tracking-[0.1em] text-s-ink-3">Recent councils</h2>
              <ul className="divide-y divide-s-line rounded-[20px] border border-s-line">
                {sessions.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                    <button type="button" onClick={() => void openSession(s.id)} className="min-w-0 flex-1 text-left">
                      <div className="truncate text-[14px] text-s-ink hover:underline">{s.question}</div>
                      <div className="text-[12px] text-s-ink-3">
                        {s.models.length} models · {s.mode === "deep" ? "Deep" : "Quick"} · {new Date(s.created_at).toLocaleString()}
                      </div>
                    </button>
                    <button
                      type="button"
                      aria-label="Delete session"
                      onClick={() => void removeSession(s.id)}
                      className="grid h-8 w-8 place-items-center rounded-lg text-s-ink-3 transition hover:bg-s-hover hover:text-s-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
