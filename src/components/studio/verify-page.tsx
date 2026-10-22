"use client";
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, CircleAlert, CircleDashed, CircleX, Copy, ExternalLink, FileText, Loader2, Plus, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { Markdown } from "@/components/common/markdown";
import { useApp } from "@/components/layout/app-context";
import { jsonFetch } from "@/hooks/use-ndjson";
import { extractClaims } from "@/lib/claims/extract";
import { cn } from "@/lib/utils";
import { CATEGORIES, CATEGORY_ORDER, categoryOf, type Category } from "@/lib/verify/categories";
import { VERIFY_PREFILL_KEY } from "@/lib/verify/handoff";
import { MAX_CHECKED_CLAIMS, type VerifiedClaim, type VerifyResult, type VerifyScope } from "@/lib/verify/schema";
import { StudioHeader, useStudio } from "./frame";
import { Segmented, Switch } from "./ui";
import { reportEvent, WasThisUseful } from "./feedback";

const SCOPES: { value: VerifyScope; label: string }[] = [
  { value: "answer", label: "Whole answer" },
  { value: "claims", label: "Selected claims" },
  { value: "document", label: "A document" },
  { value: "responses", label: "Several responses" },
];

const TONE: Record<(typeof CATEGORIES)[Category]["tone"], string> = {
  good: "border-emerald-500/30 text-emerald-700 dark:text-emerald-400",
  partial: "border-sky-500/30 text-sky-700 dark:text-sky-400",
  bad: "border-red-500/30 text-s-danger",
  mixed: "border-amber-500/30 text-amber-700 dark:text-amber-400",
  neutral: "border-s-line text-s-ink-2",
};

const field = "w-full rounded-xl border border-s-line bg-transparent px-3 py-2 text-[14px] outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong";
const btn = "inline-flex h-9 items-center justify-center gap-1.5 rounded-xl px-3.5 text-[13.5px] font-medium transition disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4";

type Doc = { name: string; content: string };
type Run =
  | { status: "idle" }
  | { status: "running" }
  | { status: "error"; message: string }
  | { status: "done"; result: VerifyResult; scope: VerifyScope; answer: string; question: string; at: string };

/**
 * Verify: an explicit workflow for checking the important claims in an
 * answer, chosen claims, a document or several responses against sources,
 * showing what was checked, what wasn't, and why.
 */
export function VerifyPage() {
  const { integrations, user } = useApp();
  const { notify } = useStudio();
  const [scope, setScope] = useState<VerifyScope>("answer");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [responses, setResponses] = useState<{ label: string; text: string }[]>([
    { label: "Response A", text: "" },
    { label: "Response B", text: "" },
  ]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [web, setWeb] = useState(true);
  const [run, setRun] = useState<Run>({ status: "idle" });

  // An answer sent here from a chat.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(VERIFY_PREFILL_KEY);
      if (!raw) return;
      sessionStorage.removeItem(VERIFY_PREFILL_KEY);
      const v = JSON.parse(raw) as { question?: string; answer?: string };
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from storage after mount
      if (typeof v.answer === "string") setAnswer(v.answer.slice(0, 40000));
      if (typeof v.question === "string") setQuestion(v.question.slice(0, 4000));
    } catch {
      /* nothing to prefill */
    }
  }, []);

  const found = useMemo(() => (scope === "claims" && answer.trim() ? extractClaims(answer).claims : []), [scope, answer]);
  const searchOn = integrations.search && web;
  const evidenceNote = searchOn
    ? docs.length
      ? "Evidence: your documents and one web search."
      : "Evidence: one web search (result snippets, not full pages)."
    : docs.length
      ? "Evidence: your documents only."
      : integrations.search
        ? "Add a document or turn on web search, or nothing can be checked."
        : "Web search isn't set up on this site. Add a document to check against, or claims will be listed but not checked.";

  const ready = scope === "claims" ? picked.size > 0 : scope === "responses" ? responses.filter((r) => r.text.trim()).length >= 2 : !!answer.trim();

  const submit = async () => {
    if (!ready) return;
    setRun({ status: "running" });
    const body = {
      scope,
      question: question.trim(),
      answer: scope === "answer" || scope === "document" ? answer.trim() : "",
      claims: scope === "claims" ? found.filter((c) => picked.has(c.index)).map((c) => c.text) : undefined,
      responses: scope === "responses" ? responses.filter((r) => r.text.trim()).map((r) => ({ label: r.label.trim() || "Response", text: r.text.trim() })) : undefined,
      documents: docs.length ? docs : undefined,
      web: searchOn,
    };
    try {
      const result = await jsonFetch<VerifyResult>("/api/verify", { method: "POST", body: JSON.stringify(body) });
      setRun({ status: "done", result, scope, answer: body.answer, question: body.question, at: new Date().toISOString() });
    } catch (e) {
      setRun({ status: "error", message: (e as Error).message || "The check failed." });
    }
  };

  return (
    <>
      <StudioHeader>
        <h1 className="text-[14px] font-medium text-s-ink-2">Verify</h1>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[820px] px-4 pb-24 pt-2 sm:px-8">
          <h2 className="font-serif text-[clamp(30px,5vw,40px)] leading-tight">Verify claims</h2>
          <p className="mt-2 max-w-2xl text-[15px] text-s-ink-2">
            Check the important claims in an answer against sources. Results describe what the sources reviewed say, not whether something is true, and anything that couldn’t be checked is marked as
            such.
          </p>

          <ol className="mt-8 space-y-8">
            <Step n={1} title="What to review">
              <Segmented label="What to review" value={scope} onChange={(v) => setScope(v)} options={SCOPES} />
              <div className="mt-4 space-y-3">
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  maxLength={4000}
                  placeholder="The question it answers (optional, helps the search)"
                  aria-label="Question"
                  className={cn(field, "h-10")}
                />
                {scope === "responses" ? (
                  <Responses value={responses} onChange={setResponses} />
                ) : (
                  <textarea
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                    maxLength={40000}
                    rows={scope === "document" ? 10 : 7}
                    placeholder={scope === "document" ? "Paste the document whose claims you want checked" : "Paste the answer to check"}
                    aria-label={scope === "document" ? "Document to check" : "Answer to check"}
                    className={field}
                  />
                )}
                {scope === "claims" && <ClaimPicker claims={found.map((c) => ({ index: c.index, text: c.text }))} picked={picked} onChange={setPicked} hasText={!!answer.trim()} />}
              </div>
            </Step>

            <Step n={2} title="Evidence">
              <label className="flex items-center justify-between gap-3 rounded-xl border border-s-line px-3 py-2.5 text-[13.5px]">
                <span>
                  Search the web
                  <span className="block text-[12px] text-s-ink-3">
                    {integrations.search
                      ? "One search; result snippets are compared, not full pages. Counts as one of your plan’s web searches."
                      : "Not available: web search isn’t set up on this site."}
                  </span>
                </span>
                <Switch checked={searchOn} onChange={setWeb} label="Search the web" disabled={!integrations.search} />
              </label>
              <Documents value={docs} onChange={setDocs} />
              <p className="mt-3 text-[12.5px] text-s-ink-3">{evidenceNote}</p>
            </Step>

            <Step n={3} title="Check">
              <button type="button" onClick={() => void submit()} disabled={!ready || run.status === "running"} className={cn(btn, "bg-s-accent text-s-accent-ink hover:brightness-110")}>
                {run.status === "running" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                {run.status === "running" ? "Checking…" : "Check claims"}
              </button>
              <p className="mt-2 text-[12px] text-s-ink-3">Comparing uses one AI model call when sources are available. Finding the claims is free.</p>
              {run.status === "running" && (
                <div className="mt-4 space-y-2" role="status" aria-label="Checking">
                  <p className="text-[13px] text-s-ink-2">Finding claims, gathering sources and comparing…</p>
                  <div className="s-skeleton h-4 w-3/4" />
                  <div className="s-skeleton h-4 w-2/3" />
                </div>
              )}
              {run.status === "error" && (
                <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl border border-s-line px-3 py-2.5 text-[13.5px] text-s-ink-2">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-s-danger" />
                  <span className="flex-1">{run.message}</span>
                  <button type="button" onClick={() => void submit()} className="shrink-0 text-[12.5px] underline underline-offset-4">
                    Try again
                  </button>
                </p>
              )}
            </Step>
          </ol>

          {run.status === "done" && <Results run={run} notify={notify} signedIn={!!user} />}
        </div>
      </div>
    </>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li>
      <h3 className="mb-3 flex items-center gap-2 text-[13px] font-medium uppercase tracking-[0.1em] text-s-ink-3">
        <span className="grid h-5 w-5 place-items-center rounded-full border border-s-line-strong text-[11px] normal-case tracking-normal">{n}</span>
        {title}
      </h3>
      {children}
    </li>
  );
}

function ClaimPicker({ claims, picked, onChange, hasText }: { claims: { index: number; text: string }[]; picked: Set<number>; onChange: (s: Set<number>) => void; hasText: boolean }) {
  if (!hasText) return <p className="text-[13px] text-s-ink-3">Paste an answer above and its claims will be listed here to choose from.</p>;
  if (!claims.length) return <p className="text-[13px] text-s-ink-3">No checkable claims were found in this text.</p>;
  const toggle = (i: number) => {
    const next = new Set(picked);
    if (next.has(i)) next.delete(i);
    else if (next.size < MAX_CHECKED_CLAIMS) next.add(i);
    onChange(next);
  };
  return (
    <div className="rounded-xl border border-s-line">
      <div className="flex items-center justify-between border-b border-s-line px-3 py-2 text-[12.5px] text-s-ink-3">
        <span>
          {picked.size} of {claims.length} chosen{claims.length > MAX_CHECKED_CLAIMS ? ` (up to ${MAX_CHECKED_CLAIMS})` : ""}
        </span>
        <button
          type="button"
          onClick={() => onChange(picked.size ? new Set() : new Set(claims.slice(0, MAX_CHECKED_CLAIMS).map((c) => c.index)))}
          className="underline underline-offset-4 hover:text-s-ink"
        >
          {picked.size ? "Clear" : "Choose all"}
        </button>
      </div>
      <ul className="s-scroll max-h-72 overflow-y-auto p-1">
        {claims.map((c) => (
          <li key={c.index}>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-[13.5px] hover:bg-s-hover">
              <input type="checkbox" checked={picked.has(c.index)} onChange={() => toggle(c.index)} className="mt-1 accent-[var(--s-accent)]" />
              <span>{c.text}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Responses({ value, onChange }: { value: { label: string; text: string }[]; onChange: (v: { label: string; text: string }[]) => void }) {
  const set = (i: number, patch: Partial<{ label: string; text: string }>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-3">
      {value.map((r, i) => (
        <div key={i} className="rounded-xl border border-s-line p-2">
          <div className="flex items-center gap-2">
            <input
              value={r.label}
              onChange={(e) => set(i, { label: e.target.value })}
              maxLength={80}
              aria-label={`Name of response ${i + 1}`}
              className="h-8 min-w-0 flex-1 bg-transparent px-1 text-[13px] font-medium outline-none"
            />
            {value.length > 2 && (
              <button
                type="button"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                aria-label={`Remove ${r.label}`}
                className="grid h-7 w-7 place-items-center rounded-lg text-s-ink-3 hover:bg-s-hover hover:text-s-danger"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <textarea
            value={r.text}
            onChange={(e) => set(i, { text: e.target.value })}
            maxLength={20000}
            rows={5}
            placeholder="Paste a model's response"
            aria-label={`${r.label} text`}
            className="w-full bg-transparent px-1 text-[14px] outline-none placeholder:text-s-ink-3"
          />
        </div>
      ))}
      {value.length < 4 && (
        <button
          type="button"
          onClick={() => onChange([...value, { label: `Response ${String.fromCharCode(65 + value.length)}`, text: "" }])}
          className={cn(btn, "border border-s-line-strong hover:bg-s-hover")}
        >
          <Plus /> Add a response
        </button>
      )}
      <p className="text-[12px] text-s-ink-3">Claims are checked against the same evidence, and each result shows which responses made it.</p>
    </div>
  );
}

function Documents({ value, onChange }: { value: Doc[]; onChange: (v: Doc[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = (d: Doc) => {
    onChange([...value, { name: d.name.trim().slice(0, 120) || "Your document", content: d.content.slice(0, 40000) }]);
    setAdding(false);
    setName("");
    setText("");
  };
  return (
    <div className="mt-3">
      {value.length > 0 && (
        <ul className="mb-2 space-y-1.5">
          {value.map((d, i) => (
            <li key={i} className="flex items-center gap-2 rounded-xl border border-s-line px-3 py-2 text-[13px]">
              <FileText className="h-4 w-4 shrink-0 text-s-ink-3" />
              <span className="min-w-0 flex-1 truncate">{d.name}</span>
              <span className="shrink-0 text-[12px] text-s-ink-3">{d.content.length.toLocaleString()} characters</span>
              <button
                type="button"
                onClick={() => onChange(value.filter((_, j) => j !== i))}
                aria-label={`Remove ${d.name}`}
                className="grid h-7 w-7 place-items-center rounded-lg text-s-ink-3 hover:bg-s-hover hover:text-s-danger"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <div className="space-y-2 rounded-xl border border-s-line p-2">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Name (e.g. Annual report 2025)" aria-label="Document name" className={cn(field, "h-9")} />
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={40000}
            rows={6}
            placeholder="Paste the reference text to check against"
            aria-label="Reference text"
            className={field}
          />
          {error && <p className="text-[12.5px] text-s-danger">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={!text.trim()} onClick={() => add({ name, content: text })} className={cn(btn, "bg-s-accent text-s-accent-ink")}>
              Add document
            </button>
            <label className={cn(btn, "cursor-pointer border border-s-line-strong hover:bg-s-hover")}>
              <Upload /> Upload .txt or .md
              <input
                type="file"
                accept=".txt,.md,.markdown,.csv,text/plain,text/markdown"
                className="sr-only"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  if (f.size > 400_000) return setError("That file is too large. Paste the relevant part instead.");
                  setError(null);
                  add({ name: f.name, content: await f.text() });
                }}
              />
            </label>
            <button type="button" onClick={() => setAdding(false)} className={cn(btn, "text-s-ink-2 hover:bg-s-hover")}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        value.length < 3 && (
          <button type="button" onClick={() => setAdding(true)} className={cn(btn, "border border-s-line-strong hover:bg-s-hover")}>
            <Plus /> Add a reference document
          </button>
        )
      )}
    </div>
  );
}

function Results({ run, notify, signedIn }: { run: Extract<Run, { status: "done" }>; notify: (t: string) => void; signedIn: boolean }) {
  const { result } = run;
  const [filter, setFilter] = useState<Category | null>(null);
  const counts = useMemo(() => {
    const m = new Map<Category, number>();
    for (const c of result.claims) m.set(categoryOf(c.status), (m.get(categoryOf(c.status)) ?? 0) + 1);
    return m;
  }, [result.claims]);
  const sorted = useMemo(() => [...result.claims].sort((a, b) => CATEGORY_ORDER.indexOf(categoryOf(a.status)) - CATEGORY_ORDER.indexOf(categoryOf(b.status))), [result.claims]);
  const shown = filter ? sorted.filter((c) => categoryOf(c.status) === filter) : sorted;
  const canRevise = (run.scope === "answer" || run.scope === "document") && result.claims.some((c) => c.status !== null);

  return (
    <section aria-label="Results" className="s-in mt-10 border-t border-s-line pt-8">
      <h3 className="font-serif text-[26px] leading-tight">What was found</h3>
      {result.retrievedAt && (
        <p className="mt-1 text-[12.5px] text-s-ink-3">
          Sources retrieved {new Date(result.retrievedAt).toLocaleString()} · compared by {result.method === "model" ? "an AI model (quotes checked word-for-word)" : "keyword rules"}
        </p>
      )}

      {result.steps && (
        <ol className="mt-4 space-y-1.5 text-[13px]">
          {result.steps.map((s) => (
            <li key={s.id} className="flex items-start gap-2">
              {s.status === "done" ? (
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : s.status === "failed" ? (
                <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-s-danger" />
              ) : (
                <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-s-ink-3" />
              )}
              <span>
                <span className="font-medium">{s.label}</span>
                <span className="text-s-ink-3">{s.status === "skipped" ? " (skipped)" : s.status === "failed" ? " (failed)" : ""}: </span>
                <span className="text-s-ink-2">{s.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      )}

      {result.reason && (
        <p className="mt-4 flex items-start gap-2 rounded-xl border border-s-line bg-s-hover px-3 py-2.5 text-[13.5px] text-s-ink-2">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {result.reason}
        </p>
      )}

      {result.claims.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-1.5" role="group" aria-label="Filter by result">
          {CATEGORY_ORDER.filter((c) => counts.get(c)).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={filter === c}
              onClick={() => setFilter(filter === c ? null : c)}
              className={cn("rounded-full border px-2.5 py-1 text-[12px] transition", TONE[CATEGORIES[c].tone], filter === c ? "bg-s-hover" : "hover:bg-s-hover")}
            >
              {CATEGORIES[c].short} · {counts.get(c)}
            </button>
          ))}
        </div>
      )}

      <ul className="mt-4 space-y-2.5">
        {shown.map((c, i) => (
          <ClaimRow key={`${c.text}-${i}`} c={c} />
        ))}
      </ul>

      {result.sources.length > 0 && (
        <details className="mt-5 text-[13px] text-s-ink-2">
          <summary className="cursor-pointer">Sources reviewed ({result.sources.length})</summary>
          <ol className="mt-2 space-y-1">
            {result.sources.map((s, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <span className="text-s-ink-3">[{i + 1}]</span>
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:text-s-ink hover:underline">
                    {s.title} <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span>{s.title}</span>
                )}
                <span className="text-[11.5px] text-s-ink-3">· {s.origin === "document" ? "your document" : "web snippet"}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
      {result.notices.map((n) => (
        <p key={n} className="mt-2 text-[12.5px] text-s-ink-3">
          {n}
        </p>
      ))}

      {canRevise && <Revise run={run} notify={notify} />}
      {signedIn && result.claims.length > 0 && <WasThisUseful className="mt-6" feature="verify" subjectId={`verify:${result.retrievedAt ?? run.at}`} />}
    </section>
  );
}

function ClaimRow({ c }: { c: VerifiedClaim }) {
  const cat = CATEGORIES[categoryOf(c.status)];
  return (
    <li className="rounded-xl border border-s-line px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className={cn("rounded-full border px-2 py-0.5 text-[11.5px] font-medium", TONE[cat.tone])}>{cat.label}</span>
        {c.hedged && <span className="text-[11.5px] text-s-ink-3">hedged in the text</span>}
        {c.from && c.from.length > 0 && <span className="text-[11.5px] text-s-ink-3">from {c.from.join(", ")}</span>}
      </div>
      <p className="mt-1.5 text-[14px] leading-relaxed">{c.text}</p>
      {c.finding && <p className="mt-1 text-[13px] text-s-ink-2">{c.finding}</p>}
      {(c.evidence.length > 0 || (c.limitations?.length ?? 0) > 0) && (
        <details className="group mt-2 text-[12.5px]">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-s-ink-2 hover:text-s-ink">
            <ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" /> Inspect the evidence
          </summary>
          {c.evidence.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {c.evidence.map((e, j) => (
                <li key={j}>
                  <span className={e.stance === "contradicts" ? "text-s-danger" : "text-emerald-700 dark:text-emerald-400"}>{e.stance === "contradicts" ? "Conflicts" : "Supports"}</span>
                  {" · "}
                  {e.url ? (
                    <a href={e.url} target="_blank" rel="noopener noreferrer" className="underline decoration-s-line-strong underline-offset-2 hover:text-s-ink">
                      {e.title}
                    </a>
                  ) : (
                    e.title
                  )}
                  <span className="text-s-ink-3"> · {e.origin === "document" ? "your document" : "web snippet"}</span>
                  {e.quote ? <q className="mt-0.5 block italic text-s-ink-3">{e.quote}</q> : <span className="mt-0.5 block text-s-ink-3">Matched by keyword rules; no exact quote.</span>}
                </li>
              ))}
            </ul>
          )}
          {(c.limitations?.length ?? 0) > 0 && (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-s-ink-3">
              {c.limitations!.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          )}
        </details>
      )}
    </li>
  );
}

function Revise({ run, notify }: { run: Extract<Run, { status: "done" }>; notify: (t: string) => void }) {
  const [state, setState] = useState<{ status: "idle" | "running" } | { status: "error"; message: string } | { status: "done"; text: string; model: string }>({ status: "idle" });
  const go = async () => {
    setState({ status: "running" });
    try {
      const r = await jsonFetch<{ revised: string; model: { displayName: string } }>("/api/verify/revise", {
        method: "POST",
        body: JSON.stringify({
          question: run.question,
          answer: run.answer,
          findings: run.result.claims
            .slice(0, 60)
            .map((c) => ({ text: c.text, status: c.status, evidence: c.evidence.slice(0, 5).map((e) => ({ title: e.title, url: e.url, stance: e.stance, quote: e.quote })) })),
        }),
      });
      setState({ status: "done", text: r.revised, model: r.model.displayName });
    } catch (e) {
      setState({ status: "error", message: (e as Error).message });
    }
  };
  return (
    <div className="mt-8 rounded-2xl border border-s-line p-4">
      <h4 className="text-[14px] font-medium">Revised answer</h4>
      <p className="mt-1 text-[12.5px] text-s-ink-3">Keeps what the sources support, corrects or flags the rest, and cites only the sources reviewed above. One AI model call.</p>
      {state.status === "idle" && (
        <button type="button" onClick={() => void go()} className={cn(btn, "mt-3 border border-s-line-strong hover:bg-s-hover")}>
          Write a revised answer
        </button>
      )}
      {state.status === "running" && (
        <div className="mt-3 space-y-2" role="status" aria-label="Writing">
          <div className="s-skeleton h-4 w-5/6" />
          <div className="s-skeleton h-4 w-2/3" />
        </div>
      )}
      {state.status === "error" && (
        <p role="alert" className="mt-3 text-[13px] text-s-danger">
          {state.message}{" "}
          <button type="button" onClick={() => void go()} className="text-s-ink underline underline-offset-4">
            Try again
          </button>
        </p>
      )}
      {state.status === "done" && (
        <>
          <div className="mt-3 text-[14px]">
            <Markdown text={state.text} className="s-prose" />
          </div>
          <div className="mt-3 flex items-center gap-3 text-[12.5px] text-s-ink-3">
            <span>Written by {state.model}. Check it before you rely on it.</span>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(state.text).then(() => {
                  notify("Copied");
                  reportEvent("useful_result", { how: "copy", feature: "verify" });
                });
              }}
              className="inline-flex items-center gap-1 text-s-ink-2 hover:text-s-ink"
            >
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
          </div>
        </>
      )}
    </div>
  );
}
