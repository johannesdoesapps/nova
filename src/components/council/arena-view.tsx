"use client";
import { useMemo, useRef, useState } from "react";
import { ArrowUp, Eye, EyeOff, Scale, Sparkles, Square, Star, ThumbsUp } from "lucide-react";
import { useCatalog } from "@/components/common/model-picker";
import { Markdown } from "@/components/common/markdown";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { Switch } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import { cn } from "@/lib/utils";
import { ModelChips, defaultParticipants, participantPool } from "./model-chips";
import { ResponseCard, StepMeta, type StepState } from "./response-card";
import { isAbort, runStep } from "./stream";

const MAX = 4;
const BLIND = ["Model A", "Model B", "Model C", "Model D"];
const idle: StepState = { status: "idle", text: "" };

function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export function ArenaView() {
  const { user } = useApp();
  const catalog = useCatalog();
  const pool = useMemo(() => participantPool(catalog?.models ?? null), [catalog]);
  const [picked, setPicked] = useState<string[] | null>(null);
  const selected = picked ?? defaultParticipants(pool, 2);
  const [blind, setBlind] = useState(true);
  const [prompt, setPrompt] = useState("");

  const [asked, setAsked] = useState("");
  const [order, setOrder] = useState<string[]>([]);
  const [wasBlind, setWasBlind] = useState(true);
  const [revealed, setRevealed] = useState(false);
  const [answers, setAnswers] = useState<Record<string, StepState>>({});
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [preferred, setPreferred] = useState<string | null>(null);
  const [improve, setImprove] = useState<{ target: string; by: string; state: StepState } | null>(null);
  const [improveBy, setImproveBy] = useState<string>("");
  const [summary, setSummary] = useState<StepState>(idle);
  const [summaryBy, setSummaryBy] = useState<string>("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const model = (id: string) => catalog?.models.find((m) => m.id === id);
  const labelOf = (id: string) => (wasBlind && !revealed ? BLIND[order.indexOf(id)]! : (model(id)?.displayName ?? id));
  const slot = (id: string) => BLIND[order.indexOf(id)]!;

  const patch = (id: string, p: Partial<StepState>) => setAnswers((s) => ({ ...s, [id]: { ...(s[id] ?? idle), ...p } }));

  const answerOne = async (id: string, q: string, signal: AbortSignal): Promise<StepState> => {
    patch(id, { status: "running", text: "", error: undefined });
    let final: StepState;
    try {
      const r = await runStep("answer", { question: q, modelId: id }, signal, (text) => patch(id, { text }));
      final = { status: "done", text: r.text, latencyMs: r.latencyMs, outputTokens: r.usage?.outputTokens, tokensEstimated: r.usage?.estimated, estimatedCost: r.estimatedCost, simulated: r.simulated };
    } catch (e) {
      final = isAbort(e) ? { status: "cancelled", text: "" } : { status: "error", text: "", error: (e as Error).message };
    }
    patch(id, final);
    return final;
  };

  const persist = async (body: object, id: string | null): Promise<string | null> => {
    if (!user) {
      setNote("Sign in to save Arena results.");
      return null;
    }
    try {
      if (id) {
        await jsonFetch(`/api/council/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) });
        return id;
      }
      const r = await jsonFetch<{ session: { id: string } }>("/api/council/sessions", { method: "POST", body: JSON.stringify(body) });
      return r.session.id;
    } catch (e) {
      setNote(`Not saved: ${(e as Error).message}`);
      return null;
    }
  };

  const resultBody = (ids: string[], states: Record<string, StepState>, pref: string | null, rates: Record<string, number>, sum: StepState, sumBy: string) => ({
    answers: ids.map((id) => ({ modelId: id, label: slot2(ids, id), text: states[id]?.text ?? "", status: states[id]?.status === "done" ? "done" : states[id]?.status === "cancelled" ? "cancelled" : "error", latencyMs: states[id]?.latencyMs ?? null })),
    critiques: [],
    synthesis: sum.status === "done" && sum.text ? { modelId: sumBy, text: sum.text } : null,
    sources: [],
    preferred: pref ? slot2(ids, pref) : null,
    ratings: Object.fromEntries(Object.entries(rates).map(([id, n]) => [slot2(ids, id), n])),
  });
  const slot2 = (ids: string[], id: string) => BLIND[ids.indexOf(id)]!;

  const run = async () => {
    const q = prompt.trim();
    if (!q || running || selected.length < 2) return;
    const ac = new AbortController();
    abortRef.current = ac;
    const ids = blind ? shuffle(selected) : [...selected];
    setAsked(q);
    setOrder(ids);
    setWasBlind(blind);
    setRevealed(!blind);
    setAnswers(Object.fromEntries(ids.map((id) => [id, { status: "idle", text: "" }])));
    setRatings({});
    setPreferred(null);
    setImprove(null);
    setSummary(idle);
    setSessionId(null);
    setNote(null);
    setRunning(true);
    const results = await Promise.all(ids.map((id) => answerOne(id, q, ac.signal)));
    setRunning(false);
    const states = Object.fromEntries(ids.map((id, i) => [id, results[i]!]));
    if (results.some((r) => r.status === "done")) {
      const id = await persist({ kind: "arena", question: q, mode: blind ? "blind" : "open", models: ids, result: resultBody(ids, states, null, {}, idle, "") }, null);
      setSessionId(id);
    }
  };

  const savePrefs = async (pref: string | null, rates: Record<string, number>, sum = summary, sumBy = summaryBy) => {
    if (!sessionId) return;
    await persist({ result: resultBody(order, answers, pref, rates, sum, sumBy) }, sessionId);
  };

  const rate = (id: string, n: number) => {
    const next = { ...ratings, [id]: n };
    setRatings(next);
    void savePrefs(preferred, next);
  };
  const prefer = (id: string) => {
    const next = preferred === id ? null : id;
    setPreferred(next);
    void savePrefs(next, ratings);
  };

  const doImprove = async (target: string) => {
    const by = improveBy || selected.find((x) => x !== target) || target;
    const ac = new AbortController();
    abortRef.current = ac;
    setImprove({ target, by, state: { status: "running", text: "" } });
    try {
      const r = await runStep("improve", { question: asked, modelId: by, response: { label: slot(target), text: answers[target]!.text } }, ac.signal, (text) =>
        setImprove((s) => (s ? { ...s, state: { ...s.state, text } } : s)),
      );
      setImprove({ target, by, state: { status: "done", text: r.text, latencyMs: r.latencyMs, outputTokens: r.usage?.outputTokens, tokensEstimated: r.usage?.estimated, estimatedCost: r.estimatedCost } });
    } catch (e) {
      setImprove({ target, by, state: isAbort(e) ? { status: "cancelled", text: "" } : { status: "error", text: "", error: (e as Error).message } });
    }
  };

  const compare = async () => {
    const done = order.filter((id) => answers[id]?.status === "done");
    if (done.length < 2) return;
    const by = summaryBy || done.find((id) => model(id)?.capabilities.includes("reasoning")) || done[0]!;
    setSummaryBy(by);
    const ac = new AbortController();
    abortRef.current = ac;
    setSummary({ status: "running", text: "" });
    try {
      const r = await runStep(
        "synthesize",
        { question: asked, modelId: by, kind: "compare", responses: done.map((id) => ({ label: slot(id), text: answers[id]!.text })) },
        ac.signal,
        (text) => setSummary((s) => ({ ...s, text })),
      );
      const final: StepState = { status: "done", text: r.text, latencyMs: r.latencyMs, outputTokens: r.usage?.outputTokens, tokensEstimated: r.usage?.estimated, estimatedCost: r.estimatedCost };
      setSummary(final);
      void savePrefs(preferred, ratings, final, by);
    } catch (e) {
      setSummary(isAbort(e) ? { status: "cancelled", text: "" } : { status: "error", text: "", error: (e as Error).message });
    }
  };

  const anyDone = order.some((id) => answers[id]?.status === "done");

  return (
    <>
      <StudioHeader>
        <span className="text-[14px] font-medium text-s-ink-2">Arena</span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(34px,5vw,46px)] leading-[1.05] tracking-[-0.01em]">Nova Arena</h1>
            <p className="mt-2 max-w-2xl text-[15.5px] text-s-ink-2">Send one prompt to several models, compare them side by side — blind if you like — and keep the best answer.</p>
          </div>

          <form
            className="composer glass-strong glass-edge s-in mt-7 rounded-[26px] p-3 [animation-delay:60ms] sm:p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <label htmlFor="arena-q" className="sr-only">
              Prompt
            </label>
            <textarea
              id="arena-q"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void run();
                }
              }}
              rows={2}
              maxLength={12000}
              placeholder="One prompt, several models…"
              className="s-scroll block max-h-56 min-h-[64px] w-full resize-y bg-transparent px-2 pt-1 text-[16px] leading-relaxed text-s-ink outline-none placeholder:text-s-ink-3"
            />
            <div className="mt-3 space-y-3 border-t border-s-line px-1 pt-3">
              {catalog === null ? (
                <div className="s-skeleton h-9 w-2/3" />
              ) : pool.length < 2 ? (
                <p className="text-[13px] text-s-ink-3">Arena needs at least two configured models. An administrator can add provider keys in Admin.</p>
              ) : (
                <ModelChips pool={pool} selected={selected} onChange={setPicked} max={MAX} disabled={running} />
              )}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
                <label className="flex items-center gap-2 text-[13px] text-s-ink-2">
                  <Switch label="Blind comparison" checked={blind} disabled={running} onChange={setBlind} />
                  <EyeOff className="h-3.5 w-3.5" /> Blind — hide names until you reveal
                </label>
                <div className="ml-auto">
                  {running ? (
                    <button type="button" onClick={() => abortRef.current?.abort()} className="inline-flex h-10 items-center gap-2 rounded-full bg-s-ink px-4 text-[13.5px] font-medium text-s-bg transition hover:opacity-85">
                      <Square className="h-3.5 w-3.5 fill-current" /> Cancel
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={!prompt.trim() || selected.length < 2}
                      className="inline-flex h-10 items-center gap-2 rounded-full bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink transition hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
                    >
                      <Scale className="h-4 w-4" /> Compare <ArrowUp className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </form>

          {order.length > 0 && (
            <section className="mt-8 space-y-5" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="max-w-3xl text-[15px] font-medium leading-snug">{asked}</p>
                <div className="flex flex-wrap items-center gap-2">
                  {wasBlind && (
                    <button
                      type="button"
                      onClick={() => setRevealed((r) => !r)}
                      disabled={running}
                      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-s-line-strong px-3.5 text-[13px] transition hover:bg-s-hover disabled:opacity-40"
                    >
                      {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />} {revealed ? "Hide names" : "Reveal models"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void compare()}
                    disabled={running || order.filter((id) => answers[id]?.status === "done").length < 2 || summary.status === "running"}
                    className="inline-flex h-9 items-center gap-1.5 rounded-full border border-s-line-strong px-3.5 text-[13px] transition hover:bg-s-hover disabled:opacity-40"
                  >
                    <Sparkles className="h-4 w-4" /> Summarize differences
                  </button>
                </div>
              </div>

              <div className={cn("grid gap-4", order.length >= 3 ? "md:grid-cols-2 xl:grid-cols-3" : "md:grid-cols-2")}>
                {order.map((id) => {
                  const s = answers[id] ?? idle;
                  const m = model(id);
                  return (
                    <ResponseCard
                      key={id}
                      title={labelOf(id)}
                      subtitle={wasBlind && !revealed ? "Hidden until you reveal" : m ? undefined : id}
                      provider={wasBlind && !revealed ? "auto" : (m?.provider ?? "demo")}
                      state={s}
                      highlight={preferred === id}
                      onRetry={running ? undefined : () => void answerOne(id, asked, new AbortController().signal)}
                      footer={
                        s.status === "done" ? (
                          <div className="flex w-full flex-wrap items-center justify-between gap-2 border-t border-s-line pt-3">
                            <div className="flex items-center" role="radiogroup" aria-label={`Rate ${labelOf(id)}`}>
                              {[1, 2, 3, 4, 5].map((n) => (
                                <button
                                  key={n}
                                  type="button"
                                  role="radio"
                                  aria-checked={ratings[id] === n}
                                  aria-label={`${n} star${n === 1 ? "" : "s"}`}
                                  onClick={() => rate(id, n)}
                                  className="grid h-7 w-7 place-items-center rounded-md text-s-ink-3 transition hover:text-s-ink"
                                >
                                  <Star className={cn("h-4 w-4", (ratings[id] ?? 0) >= n && "fill-current text-s-ink")} />
                                </button>
                              ))}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => void doImprove(id)}
                                disabled={improve?.state.status === "running"}
                                className="inline-flex h-8 items-center rounded-lg px-2.5 text-[12.5px] text-s-ink-2 transition hover:bg-s-hover hover:text-s-ink disabled:opacity-40"
                              >
                                Improve
                              </button>
                              <button
                                type="button"
                                aria-pressed={preferred === id}
                                onClick={() => prefer(id)}
                                className={cn(
                                  "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] transition",
                                  preferred === id ? "bg-s-accent text-s-accent-ink" : "border border-s-line text-s-ink-2 hover:bg-s-hover hover:text-s-ink",
                                )}
                              >
                                <ThumbsUp className="h-3.5 w-3.5" /> {preferred === id ? "Preferred" : "Prefer"}
                              </button>
                            </div>
                          </div>
                        ) : null
                      }
                    />
                  );
                })}
              </div>

              {anyDone && (
                <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-s-ink-3">
                  <span>Improve with</span>
                  <select value={improveBy} onChange={(e) => setImproveBy(e.target.value)} aria-label="Model that improves an answer" className="h-8 rounded-lg border border-s-line bg-transparent px-2 text-[12.5px] text-s-ink outline-none">
                    <option value="" className="bg-s-bg">
                      another participant
                    </option>
                    {pool.map((m) => (
                      <option key={m.id} value={m.id} className="bg-s-bg">
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                  <span>· Summary by</span>
                  <select value={summaryBy} onChange={(e) => setSummaryBy(e.target.value)} aria-label="Model that writes the summary" className="h-8 rounded-lg border border-s-line bg-transparent px-2 text-[12.5px] text-s-ink outline-none">
                    <option value="" className="bg-s-bg">
                      a reasoning model
                    </option>
                    {pool.map((m) => (
                      <option key={m.id} value={m.id} className="bg-s-bg">
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                  {note && <span className="ml-auto">{note}</span>}
                </div>
              )}

              {improve && (
                <ResponseCard
                  title={`Improved version of ${labelOf(improve.target)}`}
                  subtitle={`Rewritten by ${model(improve.by)?.displayName ?? improve.by}`}
                  provider={model(improve.by)?.provider ?? "demo"}
                  state={improve.state}
                  onRetry={() => void doImprove(improve.target)}
                />
              )}

              {summary.status !== "idle" && (
                <article className="glass-strong glass-edge s-in rounded-[26px] p-5 sm:p-7">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-[11.5px] font-medium uppercase tracking-[0.1em] text-s-ink-3">Comparison summary</div>
                      <p className="mt-1 text-[12.5px] text-s-ink-3">
                        AI-generated by {wasBlind && !revealed ? "a participating model" : (model(summaryBy)?.displayName ?? "a model")} from the answers above; not fact-checked.
                      </p>
                    </div>
                    <StepMeta s={summary} />
                  </div>
                  <div className="mt-4">
                    {summary.status === "error" ? (
                      <p className="text-[13.5px] text-s-danger">{summary.error}</p>
                    ) : summary.text ? (
                      <Markdown text={summary.text} className="s-prose" />
                    ) : (
                      <div className="space-y-2.5" aria-hidden>
                        <div className="s-skeleton h-3.5 w-[88%]" />
                        <div className="s-skeleton h-3.5 w-[70%]" />
                      </div>
                    )}
                  </div>
                </article>
              )}
            </section>
          )}

          {order.length === 0 && (
            <section className="s-in mt-10 grid gap-3 [animation-delay:120ms] sm:grid-cols-3">
              {[
                ["Side by side", "Every model gets the same prompt at the same time; timing and usage are shown when the provider reports them."],
                ["Blind mode", "Answers are labelled Model A, B… in random order until you reveal them."],
                ["Keep the best", "Rate, prefer, ask another model to improve an answer, or get a summary of the differences."],
              ].map(([t, d]) => (
                <div key={t} className="glass rounded-[20px] p-4">
                  <div className="text-[13.5px] font-medium">{t}</div>
                  <p className="mt-1 text-[13px] leading-snug text-s-ink-3">{d}</p>
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
