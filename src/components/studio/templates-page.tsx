"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleDashed,
  CircleSlash,
  CircleX,
  Copy,
  Download,
  FolderPlus,
  Loader2,
  MessageSquarePlus,
  Play,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Square,
  Trash2,
} from "lucide-react";
import { Markdown } from "@/components/common/markdown";
import { useCatalog } from "@/components/common/model-picker";
import { useApp } from "@/components/layout/app-context";
import { postNdjson } from "@/hooks/use-ndjson";
import { autoIdFor, isAutoId, ROUTER_MODES } from "@/lib/ai/platform";
import type { SearchSource } from "@/lib/search/types";
import { templateEstimate } from "@/lib/templates/estimate";
import { CATEGORY_LABELS, checkInputs, defaultInputs, findTemplate, handoffHref, TEMPLATES, type Template, type TemplateCategory, type TemplateInput } from "@/lib/templates/registry";
import { openInVerify } from "@/lib/verify/handoff";
import { cn } from "@/lib/utils";
import { SaveToProjectDialog } from "./dialogs";
import { reportEvent, WasThisUseful } from "./feedback";
import { StudioHeader, useStudio } from "./frame";
import { conversationFileName, type Msg } from "./history";
import { ModelSelector } from "./model-selector";
import { useStoredJson } from "./prefs";

const btn = "inline-flex h-9 items-center justify-center gap-1.5 rounded-xl px-3.5 text-[13.5px] font-medium transition disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4";
const field = "w-full rounded-xl border border-s-line bg-transparent px-3 py-2 text-[14px] outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong";

/** A user's own version of a template: their step instructions and model, kept in this browser. */
export interface MyTemplate {
  id: string;
  baseId: string;
  name: string;
  modelId?: string;
  instructions: Record<string, string>;
  savedAt: string;
}

type StepState = { status: "pending" | "running" | "done" | "failed" | "cancelled"; text: string; error?: string; notices: string[]; sources: SearchSource[]; model?: string; cost?: number | null };
interface RunState {
  inputs: Record<string, string>;
  modelId: string;
  instructions: Record<string, string>;
  steps: Record<string, StepState>;
  at: string;
}

const isMine = (v: unknown): v is MyTemplate[] => Array.isArray(v);
const isRun = (v: unknown): v is RunState | null => v === null || (!!v && typeof v === "object" && "steps" in v);
const emptyStep = (): StepState => ({ status: "pending", text: "", notices: [], sources: [] });

/** Templates: ready-made workflows. The list, or one template (?t=id, or ?mine=id for a saved version). */
export function TemplatesPage() {
  const params = useSearchParams();
  const [mine, setMine] = useStoredJson<MyTemplate[]>("orbis:templates:mine", [], isMine);
  const own = params.get("mine") ? mine.find((m) => m.id === params.get("mine")) : undefined;
  const template = findTemplate(own?.baseId ?? params.get("t") ?? "");
  if (template) return <TemplateView key={own?.id ?? template.id} template={template} own={own} mine={mine} setMine={setMine} />;
  return <Library mine={mine} setMine={setMine} />;
}

function Library({ mine, setMine }: { mine: MyTemplate[]; setMine: (v: MyTemplate[]) => void }) {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<TemplateCategory | null>(null);
  const q = query.trim().toLowerCase();
  const shown = TEMPLATES.filter((t) => (!cat || t.category === cat) && (!q || `${t.name} ${t.description} ${t.outcome}`.toLowerCase().includes(q)));
  const cats = [...new Set(TEMPLATES.map((t) => t.category))];
  return (
    <>
      <StudioHeader>
        <h1 className="text-[14px] font-medium text-s-ink-2">Templates</h1>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1040px] px-4 pb-24 pt-2 sm:px-8">
          <h2 className="font-serif text-[clamp(30px,5vw,40px)] leading-tight">Templates</h2>
          <p className="mt-2 max-w-2xl text-[15px] text-s-ink-2">
            Ready-made workflows for common tasks. Fill in a few details and start; each step’s instructions can be changed and saved as your own version.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-2">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" />
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search templates" aria-label="Search templates" className={cn(field, "h-10 pl-9")} />
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Category">
              {[null, ...cats].map((c) => (
                <button
                  key={c ?? "all"}
                  type="button"
                  aria-pressed={cat === c}
                  onClick={() => setCat(c)}
                  className={cn("h-9 rounded-xl border px-3 text-[13px] transition", cat === c ? "border-s-line-strong bg-s-hover text-s-ink" : "border-s-line text-s-ink-2 hover:bg-s-hover")}
                >
                  {c ? CATEGORY_LABELS[c] : "All"}
                </button>
              ))}
            </div>
          </div>

          {mine.length > 0 && !q && !cat && (
            <section className="mt-8">
              <h3 className="mb-2 text-[12.5px] font-medium uppercase tracking-[0.1em] text-s-ink-3">My templates</h3>
              <ul className="grid gap-2 sm:grid-cols-2">
                {mine.map((m) => (
                  <li key={m.id} className="glass flex items-center gap-2 rounded-2xl px-4 py-3">
                    <Link href={`/templates?mine=${m.id}`} className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-medium">{m.name}</span>
                      <span className="block truncate text-[12.5px] text-s-ink-3">
                        Based on {findTemplate(m.baseId)?.name ?? "a template"} · saved {new Date(m.savedAt).toLocaleDateString()}
                      </span>
                    </Link>
                    <button
                      type="button"
                      aria-label={`Delete ${m.name}`}
                      onClick={() => setMine(mine.filter((x) => x.id !== m.id))}
                      className="grid h-8 w-8 place-items-center rounded-lg text-s-ink-3 hover:bg-s-hover hover:text-s-danger"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {shown.length === 0 ? (
            <p className="mt-10 text-[14px] text-s-ink-3">No templates match “{query}”.</p>
          ) : (
            <ul className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((t) => (
                <li key={t.id}>
                  <Link href={`/templates?t=${t.id}`} className="glass group flex h-full flex-col rounded-[22px] p-4 transition hover:border-s-line-strong">
                    <span className="text-[11.5px] font-medium uppercase tracking-[0.08em] text-s-ink-3">{CATEGORY_LABELS[t.category]}</span>
                    <span className="mt-1.5 text-[16px] font-medium">{t.name}</span>
                    <span className="mt-1 text-[13.5px] text-s-ink-2">{t.description}</span>
                    <span className="mt-3 text-[12.5px] text-s-ink-3">
                      <span className="text-s-ink-2">You get:</span> {t.outcome}
                    </span>
                    <span className="mt-auto flex items-center justify-between pt-4 text-[12.5px] text-s-ink-3">
                      {t.steps ? `${t.steps.length} step${t.steps.length === 1 ? "" : "s"}` : `Opens ${t.handoff!.to === "missions" ? "Missions" : t.handoff!.to === "arena" ? "Arena" : "Verify"}`}
                      <span className="inline-flex items-center gap-1 text-s-ink-2 group-hover:text-s-ink">
                        Start <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-8 text-[12.5px] text-s-ink-3">
            Templates use your plan’s allowance like a chat: one model call per step. Your own versions and your last run of each template are kept in this browser.
          </p>
        </div>
      </div>
    </>
  );
}

function TemplateView({ template: t, own, mine, setMine }: { template: Template; own?: MyTemplate; mine: MyTemplate[]; setMine: (v: MyTemplate[]) => void }) {
  const router = useRouter();
  const { user } = useApp();
  const studio = useStudio();
  const catalog = useCatalog();
  const runKey = `orbis:templates:run:${own?.id ?? t.id}`;
  const [saved, setSaved] = useStoredJson<RunState | null>(runKey, null, isRun);
  const [inputs, setInputs] = useState<Record<string, string>>(() => ({ ...defaultInputs(t), ...(saved?.inputs ?? {}) }));
  const [touched, setTouched] = useState(false);
  const [modelId, setModelId] = useState(own?.modelId ?? saved?.modelId ?? autoIdFor(t.suggested.router));
  const [instructions, setInstructions] = useState<Record<string, string>>(own?.instructions ?? saved?.instructions ?? {});
  const [customising, setCustomising] = useState(false);
  const [run, setRunState] = useState<RunState | null>(saved);
  const runRef = useRef<RunState | null>(saved);
  const abort = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [toSave, setToSave] = useState<Msg | null>(null);
  // After a full page load the saved run is only readable once hydrated: pick it up then.
  const [adopted, setAdopted] = useState(!!saved);
  if (!adopted && saved) {
    setAdopted(true);
    if (!run) {
      setRunState(saved);
      setInputs({ ...defaultInputs(t), ...saved.inputs });
      setModelId(own?.modelId ?? saved.modelId);
      setInstructions(own?.instructions ?? saved.instructions);
    }
  }
  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const setRun = useCallback(
    (next: RunState | null) => {
      runRef.current = next;
      setRunState(next);
      // Keep finished and failed steps; a step that was running when the page closed counts as cancelled.
      setSaved(next && { ...next, steps: Object.fromEntries(Object.entries(next.steps).map(([k, s]) => [k, s.status === "running" ? { ...s, status: "cancelled" as const } : s])) });
    },
    [setSaved],
  );
  const patchStep = (id: string, fn: (s: StepState) => StepState) => {
    const cur = runRef.current;
    if (!cur) return;
    setRun({ ...cur, steps: { ...cur.steps, [id]: fn(cur.steps[id] ?? emptyStep()) } });
  };

  const errors = checkInputs(t, inputs);
  const valid = Object.keys(errors).length === 0;
  const models = catalog?.models ?? null;
  const est = useMemo(() => (models ? templateEstimate(t, models, modelId, inputs, instructions, isAutoId(modelId)) : null), [models, t, modelId, inputs, instructions]);
  const steps = t.steps ?? [];
  const changed = !!run && JSON.stringify(run.inputs) !== JSON.stringify(inputs);
  const firstOpen = run ? steps.findIndex((s) => run.steps[s.id]?.status !== "done") : 0;
  const finished = !!run && firstOpen === -1;
  const lastDone = run ? [...steps].reverse().find((s) => run.steps[s.id]?.status === "done") : undefined;

  /** Run the steps from `from` on, using finished steps' results; stops at the first failure or on cancel. */
  const runFrom = async (from: number, base: RunState) => {
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    let state = base;
    try {
      for (const step of steps.slice(from)) {
        if (state.steps[step.id]?.status === "done") continue;
        patchStep(step.id, () => ({ ...emptyStep(), status: "running" }));
        const prior = Object.fromEntries(steps.filter((s) => state.steps[s.id]?.status === "done").map((s) => [s.id, state.steps[s.id]!.text.slice(0, 30_000)]));
        try {
          let done = false;
          for await (const ev of postNdjson<Record<string, unknown>>(
            "/api/templates/step",
            { templateId: t.id, stepId: step.id, inputs: state.inputs, prior, instructions: state.instructions[step.id]?.trim() || undefined, modelId: state.modelId, requestId: crypto.randomUUID() },
            ac.signal,
          )) {
            if (ev.type === "meta") patchStep(step.id, (s) => ({ ...s, model: (ev.model as { displayName: string }).displayName }));
            else if (ev.type === "notice") patchStep(step.id, (s) => ({ ...s, notices: [...s.notices, String(ev.message)] }));
            else if (ev.type === "sources") patchStep(step.id, (s) => ({ ...s, sources: ev.sources as SearchSource[] }));
            else if (ev.type === "delta") patchStep(step.id, (s) => ({ ...s, text: s.text + String(ev.text) }));
            else if (ev.type === "done") {
              done = true;
              patchStep(step.id, (s) => ({ ...s, status: "done", text: String(ev.text), cost: (ev.estimatedCost as number | null) ?? null }));
            } else if (ev.type === "error") throw new Error(String(ev.message ?? "The step failed."));
          }
          if (!done) throw new Error("The connection ended before the step finished. Try the step again.");
          state = runRef.current!;
        } catch (e) {
          const cancelled = ac.signal.aborted;
          patchStep(step.id, (s) => ({
            ...s,
            status: cancelled ? "cancelled" : "failed",
            error: cancelled ? "Cancelled. The text so far is kept below; run the step again to finish it." : actionable(e),
          }));
          return;
        }
      }
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const start = () => {
    setTouched(true);
    if (!valid) return;
    if (t.handoff) {
      if (t.handoff.to === "verify") openInVerify(inputs.question ?? "", inputs.text ?? "");
      router.push(handoffHref(t, inputs)!);
      return;
    }
    const fresh: RunState = { inputs: { ...inputs }, modelId, instructions: { ...instructions }, steps: Object.fromEntries(steps.map((s) => [s.id, emptyStep()])), at: new Date().toISOString() };
    setRun(fresh);
    void runFrom(0, fresh);
  };
  const resume = () => {
    if (!run) return;
    const next = { ...run, modelId, instructions: { ...instructions } };
    setRun(next);
    void runFrom(firstOpen, next);
  };
  /** Run one finished step again, and the steps after it (they used its result). */
  const redoFrom = (i: number) => {
    if (!run) return;
    const next = { ...run, modelId, instructions: { ...instructions }, steps: { ...run.steps, ...Object.fromEntries(steps.slice(i).map((s) => [s.id, emptyStep()])) } };
    setRun(next);
    void runFrom(i, next);
  };

  const saveMine = () => {
    const name = window.prompt("Name your version of this template", own?.name ?? `${t.name} (my version)`)?.trim();
    if (!name) return;
    const entry: MyTemplate = {
      id: own?.id ?? crypto.randomUUID(),
      baseId: t.id,
      name: name.slice(0, 80),
      modelId,
      instructions: Object.fromEntries(Object.entries(instructions).filter(([, v]) => v.trim())),
      savedAt: new Date().toISOString(),
    };
    setMine(own ? mine.map((m) => (m.id === own.id ? entry : m)) : [entry, ...mine].slice(0, 50));
    studio.notify(own ? "Your version was updated" : "Saved to My templates");
    if (!own) router.replace(`/templates?mine=${entry.id}`);
  };

  const result = lastDone && run ? run.steps[lastDone.id]!.text : "";
  const allText = run
    ? steps
        .filter((s) => run.steps[s.id]?.status === "done")
        .map((s) => `## ${s.title}\n\n${run.steps[s.id]!.text}`)
        .join("\n\n")
    : "";

  return (
    <>
      <StudioHeader>
        <Link href="/templates" className="inline-flex items-center gap-1.5 text-[14px] text-s-ink-2 hover:text-s-ink">
          <ArrowLeft className="h-4 w-4" /> Templates
        </Link>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[820px] px-4 pb-24 pt-2 sm:px-8">
          <span className="text-[12px] font-medium uppercase tracking-[0.08em] text-s-ink-3">{CATEGORY_LABELS[t.category]}</span>
          <h2 className="mt-1 font-serif text-[clamp(28px,4.6vw,38px)] leading-tight">{own?.name ?? t.name}</h2>
          <p className="mt-2 text-[15px] text-s-ink-2">{t.description}</p>
          <p className="mt-2 text-[13.5px] text-s-ink-3">
            <span className="text-s-ink-2">You get:</span> {t.outcome}
          </p>

          <form
            className="mt-7 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              start();
            }}
          >
            {t.inputs.map((f) => (
              <Field key={f.id} f={f} value={inputs[f.id] ?? ""} error={touched ? errors[f.id] : undefined} onChange={(v) => setInputs((x) => ({ ...x, [f.id]: v }))} />
            ))}

            {t.steps ? (
              <div className="rounded-2xl border border-s-line p-3.5 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-s-ink-2">Model</span>
                  <ModelSelector models={models} value={modelId} onChange={setModelId} auto={catalog?.auto ?? null} />
                  {modelId !== autoIdFor(t.suggested.router) && (
                    <button type="button" onClick={() => setModelId(autoIdFor(t.suggested.router))} className="text-[12.5px] text-s-ink-3 underline underline-offset-4 hover:text-s-ink">
                      Use the suggested setup
                    </button>
                  )}
                </div>
                <p className="mt-1.5 text-[12.5px] text-s-ink-3">
                  Suggested: {ROUTER_MODES.find((m) => m.id === t.suggested.router)?.label === "Auto" ? "Auto" : `Auto · ${ROUTER_MODES.find((m) => m.id === t.suggested.router)?.label}`}.{" "}
                  {t.suggested.why}
                </p>
                <p className="mt-1.5 text-[12.5px] text-s-ink-2">{est ? `Estimated: ${est.text}.` : "Estimate unavailable until models load."}</p>
              </div>
            ) : (
              <p className="rounded-2xl border border-s-line px-3.5 py-3 text-[13px] text-s-ink-2">{t.handoff!.why}</p>
            )}

            {t.steps && (
              <div>
                <button type="button" onClick={() => setCustomising((v) => !v)} aria-expanded={customising} className="inline-flex items-center gap-1.5 text-[13px] text-s-ink-2 hover:text-s-ink">
                  <SlidersHorizontal className="h-3.5 w-3.5" /> {customising ? "Hide the steps" : "Customise the steps"}
                </button>
                {customising && (
                  <div className="mt-3 space-y-3">
                    <p className="text-[12.5px] text-s-ink-3">
                      Each step’s instructions. Use {"{{name}}"} for an input ({t.inputs.map((f) => f.id).join(", ")}) and {"{{steps.id}}"} for an earlier step’s result.
                    </p>
                    {steps.map((s, i) => (
                      <label key={s.id} className="block text-[13px]">
                        <span className="flex items-center justify-between">
                          <span className="font-medium">
                            {i + 1}. {s.title}
                            <span className="ml-1.5 font-normal text-s-ink-3">
                              (id: {s.id}
                              {s.web ? ", uses web sources when available" : ""})
                            </span>
                          </span>
                          {instructions[s.id] && (
                            <button type="button" onClick={() => setInstructions((x) => ({ ...x, [s.id]: "" }))} className="text-[12px] text-s-ink-3 underline underline-offset-4 hover:text-s-ink">
                              Reset
                            </button>
                          )}
                        </span>
                        <textarea
                          value={instructions[s.id] || s.prompt}
                          onChange={(e) => setInstructions((x) => ({ ...x, [s.id]: e.target.value === s.prompt ? "" : e.target.value }))}
                          rows={8}
                          maxLength={8000}
                          className={cn(field, "mt-1 font-mono text-[12.5px]")}
                        />
                      </label>
                    ))}
                    <button type="button" onClick={saveMine} className={cn(btn, "border border-s-line-strong hover:bg-s-hover")}>
                      <FolderPlus /> {own ? "Update my version" : "Save as my template"}
                    </button>
                    <p className="text-[12px] text-s-ink-3">Saved in this browser, with your chosen model.</p>
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {busy ? (
                <button type="button" onClick={() => abort.current?.abort()} className={cn(btn, "border border-s-line-strong hover:bg-s-hover")}>
                  <Square /> Cancel
                </button>
              ) : (
                <button type="submit" className={cn(btn, "bg-s-accent text-s-accent-ink hover:brightness-110")}>
                  {t.handoff ? <ArrowRight /> : <Play />} {t.handoff ? t.handoff.label : run ? "Start over" : "Start"}
                </button>
              )}
              {!busy && run && !finished && !changed && (
                <button type="button" onClick={resume} className={cn(btn, "border border-s-line-strong hover:bg-s-hover")}>
                  <RotateCcw /> Continue from step {firstOpen + 1}
                </button>
              )}
              {!user && t.steps && <span className="text-[12.5px] text-s-ink-3">Sign in to run templates.</span>}
            </div>
            {touched && !valid && (
              <p role="alert" className="text-[13px] text-s-danger">
                Fill in the required details above.
              </p>
            )}
            {run && changed && !busy && <p className="text-[12.5px] text-s-ink-3">You changed the inputs since this run. Start over to use them; finished steps below used the earlier inputs.</p>}
          </form>

          {run && t.steps && (
            <section aria-label="Progress" className="mt-8 border-t border-s-line pt-6">
              <h3 className="text-[13px] font-medium uppercase tracking-[0.1em] text-s-ink-3">Progress</h3>
              <ol className="mt-3 space-y-2.5">
                {steps.map((s, i) => (
                  <StepRow
                    key={s.id}
                    n={i + 1}
                    title={s.title}
                    doing={s.doing}
                    state={run.steps[s.id] ?? emptyStep()}
                    canRedo={!busy && run.steps[s.id]?.status === "done" && !changed}
                    onRedo={() => redoFrom(i)}
                    isLast={i === steps.length - 1}
                  />
                ))}
              </ol>
              {finished && (
                <div className="mt-6 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.clipboard.writeText(result).then(() => {
                        studio.notify("Copied");
                        reportEvent("useful_result", { how: "copy", feature: "template" });
                      })
                    }
                    className={cn(btn, "border border-s-line-strong hover:bg-s-hover")}
                  >
                    <Copy /> Copy result
                  </button>
                  <button type="button" onClick={() => download(`${t.name}`, allText)} className={cn(btn, "border border-s-line-strong hover:bg-s-hover")}>
                    <Download /> Download all steps
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      reportEvent("useful_result", { how: "followup", feature: "template" });
                      studio.startChatWith(`Following up on the result of the "${t.name}" template:\n\n${result.slice(0, 6000)}\n\n`);
                    }}
                    className={cn(btn, "border border-s-line-strong hover:bg-s-hover")}
                  >
                    <MessageSquarePlus /> Continue in chat
                  </button>
                  {user && (
                    <button
                      type="button"
                      onClick={() => {
                        reportEvent("useful_result", { how: "note", feature: "template" });
                        setToSave({ id: crypto.randomUUID(), role: "assistant", content: allText, status: "done" });
                      }}
                      className={cn(btn, "border border-s-line-strong hover:bg-s-hover")}
                    >
                      <FolderPlus /> Save to a project
                    </button>
                  )}
                </div>
              )}
              {finished && user && <WasThisUseful className="mt-4" feature="template" subjectId={`${t.id}:${run.at}`.slice(0, 100)} />}
            </section>
          )}
        </div>
      </div>
      <SaveToProjectDialog message={toSave} onClose={() => setToSave(null)} />
    </>
  );
}

function Field({ f, value, error, onChange }: { f: TemplateInput; value: string; error?: string; onChange: (v: string) => void }) {
  const id = `tpl-${f.id}`;
  let control: ReactNode;
  if (f.kind === "select")
    control = (
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={cn(field, "h-10")}>
        {f.options!.map((o) => (
          <option key={o} value={o} className="bg-s-bg">
            {o}
          </option>
        ))}
      </select>
    );
  else if (f.kind === "longtext")
    control = (
      <textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={f.max > 5000 ? 8 : 3} maxLength={f.max} placeholder={f.placeholder} aria-invalid={!!error} className={field} />
    );
  else control = <input id={id} value={value} onChange={(e) => onChange(e.target.value)} maxLength={f.max} placeholder={f.placeholder} aria-invalid={!!error} className={cn(field, "h-10")} />;
  return (
    <div>
      <label htmlFor={id} className="mb-1 flex items-baseline gap-1.5 text-[13.5px] font-medium">
        {f.label}
        {!f.required && <span className="text-[12px] font-normal text-s-ink-3">optional</span>}
      </label>
      {control}
      {error ? <p className="mt-1 text-[12.5px] text-s-danger">{error}</p> : f.help && <p className="mt-1 text-[12px] text-s-ink-3">{f.help}</p>}
    </div>
  );
}

function StepRow({ n, title, doing, state, canRedo, onRedo, isLast }: { n: number; title: string; doing: string; state: StepState; canRedo: boolean; onRedo: () => void; isLast: boolean }) {
  const [open, setOpen] = useState(isLast);
  const icon = {
    pending: <CircleDashed className="h-4 w-4 text-s-ink-3" />,
    running: <Loader2 className="h-4 w-4 animate-spin text-s-accent" />,
    done: <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />,
    failed: <CircleX className="h-4 w-4 text-s-danger" />,
    cancelled: <CircleSlash className="h-4 w-4 text-s-ink-3" />,
  }[state.status];
  const label = { pending: "Waiting", running: doing, done: "Done", failed: "Failed", cancelled: "Cancelled" }[state.status];
  const showText = state.text && (open || state.status === "running");
  return (
    <li className="rounded-2xl border border-s-line px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        {icon}
        <span className="min-w-0 flex-1 text-[14px]">
          <span className="font-medium">
            {n}. {title}
          </span>
          <span className={cn("ml-2 text-[12.5px]", state.status === "failed" ? "text-s-danger" : "text-s-ink-3")}>
            {label}
            {state.model ? ` · ${state.model}` : ""}
            {typeof state.cost === "number" && state.cost > 0 ? ` · ≈ ${state.cost < 0.01 ? "<$0.01" : `$${state.cost.toFixed(2)}`}` : ""}
          </span>
        </span>
        {state.text && state.status !== "running" && (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="text-[12.5px] text-s-ink-2 hover:text-s-ink">
            {open ? "Hide" : "Show"}
          </button>
        )}
        {canRedo && (
          <button type="button" onClick={onRedo} title="Runs this step and the ones after it again (uses more allowance)" className="text-[12.5px] text-s-ink-3 hover:text-s-ink">
            Run again
          </button>
        )}
      </div>
      {state.error && <p className="mt-2 text-[13px] text-s-ink-2">{state.error}</p>}
      {state.notices.map((m) => (
        <p key={m} className="mt-1.5 text-[12.5px] text-s-ink-3">
          {m}
        </p>
      ))}
      {showText && (
        <div className={cn("mt-3 border-t border-s-line pt-3 text-[14px]", state.status === "running" && "s-caret")}>
          <Markdown text={state.text} className="s-prose" validCitations={new Set(state.sources.map((s) => s.index))} />
        </div>
      )}
      {open && state.sources.length > 0 && (
        <details className="mt-2 text-[12.5px] text-s-ink-2">
          <summary className="cursor-pointer">Web sources ({state.sources.length})</summary>
          <ol className="mt-1.5 space-y-1">
            {state.sources.map((s) => (
              <li key={s.index}>
                [{s.index}]{" "}
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:text-s-ink hover:underline">
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}

/** A plain next step for common failures. */
function actionable(e: unknown): string {
  const status = (e as { status?: number }).status;
  const msg = e instanceof Error && e.message ? e.message : "The step failed.";
  if (status === 401) return "Sign in to run templates.";
  if (status === 429) return `${msg} Earlier steps are kept: continue once your limit allows.`;
  return `${msg} Earlier steps are kept: run this step again, or choose another model.`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = conversationFileName(name);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
