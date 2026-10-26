"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Ban, CircleAlert, Download, Pause, Play, RefreshCw, RotateCcw } from "lucide-react";
import { Markdown } from "@/components/common/markdown";
import { StudioHeader } from "@/components/studio/frame";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { CheckResult, Plan, Step, Task, Verification } from "@/lib/workforce/types";
import { cn } from "@/lib/utils";
import { ApprovalCard, type ApprovalLite } from "./approval-card";
import { ACTIVE, btn, btnPrimary, DiffView, dur, field, STEP_ICON, TaskStatusBadge, usd, when } from "./bits";

interface Detail {
  task: Task;
  steps: Step[];
  approvals: ApprovalLite[];
  events: { id: number; step_key: string | null; level: string; type: string; message: string; created_at: string }[];
  project: { name: string; repo: string; branch: string } | null;
}

const AGENT_NAME: Record<string, string> = {
  commander: "Commander",
  archaeologist: "Archaeologist",
  architect: "Architect",
  builder: "Builder",
  qa_hunter: "QA Hunter",
  self_heal: "Self-Heal",
  reviewer: "Reviewer",
  sentinel: "Sentinel",
  devops: "DevOps",
};

export function TaskView({ id }: { id: string }) {
  const [d, setD] = useState<Detail | null>(null);
  const [events, setEvents] = useState<Detail["events"]>([]);
  const [error, setError] = useState<string | null>(null);
  const [runner, setRunner] = useState<{ on: boolean; note: string | null }>({ on: true, note: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [rework, setRework] = useState("");
  const [tab, setTab] = useState<"steps" | "diff" | "report" | "log">("steps");
  const lastEvent = useRef(0);

  const load = useCallback(async () => {
    try {
      const r = await jsonFetch<Detail>(`/api/workforce/tasks/${id}?after=${lastEvent.current}`);
      setD(r);
      if (r.events.length) {
        lastEvent.current = r.events.at(-1)!.id;
        setEvents((e) => [...e, ...r.events].slice(-800));
      }
      setError(null);
      return r;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [id]);

  // The runner: while this page is open and the task is active, advance it tick by tick.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      const cur = await load();
      if (!alive) return;
      const active = cur && ACTIVE.includes(cur.task.status) && !cur.task.cancel_requested;
      if (active && runner.on && document.visibilityState === "visible") {
        try {
          const r = await jsonFetch<{ note: string | null }>(`/api/workforce/tasks/${id}/advance`, { method: "POST" });
          if (alive) setRunner((s) => ({ ...s, note: r.note }));
        } catch (e) {
          if (alive) setRunner((s) => ({ ...s, note: (e as Error).message }));
        }
        await load();
      }
      if (alive) timer = setTimeout(loop, active ? 2500 : 6000);
    };
    void loop();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, load, runner.on]);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    try {
      await jsonFetch(`/api/workforce/tasks/${id}/action`, { method: "POST", body: JSON.stringify({ action, ...extra }) });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const header = (
    <StudioHeader>
      <Link href="/workforce?tab=tasks" className="inline-flex items-center gap-1.5 text-[14px] text-s-ink-2 hover:text-s-ink">
        <ArrowLeft className="h-4 w-4" /> Workforce
      </Link>
      <span className="text-s-ink-3">/</span>
      <span className="truncate text-[14px] font-medium">Task</span>
    </StudioHeader>
  );
  if (!d)
    return (
      <>
        {header}
        <div className="mx-auto w-full max-w-[1100px] space-y-3 px-4 pt-6 sm:px-8">
          {error ? <div role="alert"><h1 className="text-[15px] font-normal text-s-danger">{error}</h1></div> : <><div className="s-skeleton h-10 w-2/3 rounded-xl" /><div className="s-skeleton h-60 rounded-2xl" /></>}
        </div>
      </>
    );

  const t = d.task;
  const active = ACTIVE.includes(t.status);
  const pending = d.approvals.filter((a) => a.status === "pending");
  const budgetUse = t.budget_usd ? Math.min(1, t.spent_usd / t.budget_usd) : 0;
  const tokenUse = Math.min(1, t.tokens_used / t.token_budget);

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1100px] space-y-5 px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in">
            <div className="flex flex-wrap items-center gap-2">
              <TaskStatusBadge status={t.status} />
              <span className="rounded-full border border-s-line px-2.5 py-0.5 text-[11.5px] capitalize text-s-ink-2">{t.autonomy}</span>
              <span className="rounded-full border border-s-line px-2.5 py-0.5 text-[11.5px] text-s-ink-2">{t.risk} risk</span>
              <span className="rounded-full border border-s-line px-2.5 py-0.5 text-[11.5px] text-s-ink-2">{t.priority}</span>
              {t.benchmark && <span className="rounded-full border border-s-line px-2.5 py-0.5 text-[11.5px] text-s-ink-2">benchmark: {t.benchmark}</span>}
            </div>
            <h1 className="mt-3 text-[clamp(22px,3vw,30px)] font-semibold leading-tight tracking-[-0.01em]">{t.title}</h1>
            <p className="mt-1 text-[13px] text-s-ink-3">
              {d.project ? `${d.project.name} · ${d.project.repo}@${d.project.branch}` : "project"} · created {when(t.created_at)}
              {t.finished_at ? ` · finished ${when(t.finished_at)}` : ""}
            </p>
            {t.status_reason && <p className={cn("mt-3 rounded-xl border px-3 py-2 text-[13.5px]", ["failed", "needs_attention", "blocked"].includes(t.status) ? "border-amber-500/30 bg-amber-400/10" : "border-s-line bg-s-hover")}>{t.status_reason}</p>}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {active && (
              <button type="button" onClick={() => setRunner((s) => ({ ...s, on: !s.on }))} className={btn} title="The runner advances the task while this page is open">
                {runner.on ? <Pause /> : <Play />} {runner.on ? "Runner on" : "Runner off"}
              </button>
            )}
            {["created", "analyzing", "planned", "running", "verifying"].includes(t.status) && (
              <button type="button" onClick={() => void act("pause")} disabled={!!busy} className={btn}>
                <Pause /> Pause
              </button>
            )}
            {t.status === "paused" && (
              <button type="button" onClick={() => void act("resume")} disabled={!!busy} className={btnPrimary}>
                <Play /> Resume
              </button>
            )}
            {["failed", "needs_attention", "blocked"].includes(t.status) && (
              <button type="button" onClick={() => void act("retry")} disabled={!!busy} className={btn}>
                <RefreshCw /> Retry
              </button>
            )}
            {!["completed", "failed", "cancelled"].includes(t.status) && (
              <button
                type="button"
                onClick={() => confirm("Cancel this task? Running checks are stopped and the workspace is destroyed.") && void act("cancel")}
                disabled={!!busy || t.cancel_requested}
                className={btn}
              >
                <Ban /> {t.cancel_requested ? "Cancelling…" : "Cancel"}
              </button>
            )}
            {t.diff && (
              <a href={`/api/workforce/tasks/${id}/diff`} className={btn}>
                <Download /> Patch
              </a>
            )}
            {active && runner.note && <span className="text-[12.5px] text-s-ink-3">{runner.note}</span>}
            {active && runner.on && <span className="ml-auto text-[12px] text-s-ink-3">Runs while this page is open. Closing it pauses progress until you return.</span>}
          </div>

          {pending.map((a) => (
            <ApprovalCard key={a.id} a={a} onDone={() => void load()} />
          ))}

          {["needs_attention", "completed"].includes(t.status) && t.plan && (
            <section className="glass rounded-[20px] p-4">
              <p className="text-[13px] font-medium">Rework</p>
              <p className="mt-0.5 text-[12.5px] text-s-ink-3">Send the change back to the builder with the verification problems and review findings{t.status === "completed" ? " — for example to refine a verified change" : ""}.</p>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input value={rework} onChange={(e) => setRework(e.target.value)} placeholder="Optional instructions for the builder" aria-label="Rework instructions" className={cn(field, "text-[13px]")} />
                <button type="button" onClick={() => void act("rework", { note: rework })} disabled={!!busy} className={btn}>
                  <RotateCcw /> Rework
                </button>
              </div>
            </section>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <Usage label="Budget (estimated cost)" used={usd(t.spent_usd)} total={usd(t.budget_usd)} frac={budgetUse} />
            <Usage label="Tokens" used={t.tokens_used.toLocaleString("en-US")} total={t.token_budget.toLocaleString("en-US")} frac={tokenUse} />
            <div className="glass rounded-[18px] px-4 py-3 text-[12.5px]">
              <p className="text-s-ink-3">Execution</p>
              <p className="mt-1">
                {d.steps.length} steps · {t.ticks} ticks{t.spent_unpriced_calls ? ` · ${t.spent_unpriced_calls} unpriced call(s)` : ""}
              </p>
              <p className="text-s-ink-3">Workspace: {t.sandbox_name ?? "stopped"}</p>
            </div>
          </div>

          <nav aria-label="Task sections" className="flex gap-1.5">
            {(["steps", "diff", "report", "log"] as const).map((x) => (
              <button key={x} type="button" aria-current={tab === x ? "page" : undefined} onClick={() => setTab(x)} className={cn("h-9 rounded-full border px-3.5 text-[13px] capitalize transition", tab === x ? "border-transparent bg-s-ink text-s-bg" : "border-s-line text-s-ink-2 hover:text-s-ink")}>
                {x === "diff" ? `Diff${t.changed_files.length ? ` · ${t.changed_files.length}` : ""}` : x}
              </button>
            ))}
          </nav>

          {tab === "steps" && (
            <ol className="space-y-2">
              {d.steps.map((s) => (
                <StepCard key={s.id} s={s} />
              ))}
              {!d.steps.length && <li className="text-[13.5px] text-s-ink-2">{t.status === "created" ? (t.status_reason ?? "Waiting to start…") : "No steps yet."}</li>}
            </ol>
          )}
          {tab === "diff" && (t.diff ? <DiffView diff={t.diff} /> : <p className="text-[13.5px] text-s-ink-2">No changes yet.</p>)}
          {tab === "report" &&
            (t.report ? (
              <div className="glass s-prose rounded-[20px] p-5 text-[14px]">
                <Markdown text={t.report} />
              </div>
            ) : (
              <p className="text-[13.5px] text-s-ink-2">The report is written when the task finishes. It is assembled from recorded results, not by a model.</p>
            ))}
          {tab === "log" && (
            <ol className="glass max-h-[600px] space-y-1 overflow-y-auto rounded-[20px] p-4 font-mono text-[12px]">
              {events.map((e) => (
                <li key={e.id} className={cn(e.level === "error" && "text-s-danger", e.level === "warn" && "text-amber-700 dark:text-amber-300", e.level === "audit" && "font-semibold")}>
                  <span className="text-s-ink-3">{new Date(e.created_at).toLocaleTimeString()}</span> {e.step_key ? `[${e.step_key}] ` : ""}
                  {e.message}
                </li>
              ))}
            </ol>
          )}
          {error && (
            <p role="alert" className="flex items-center gap-2 text-[13px] text-s-danger">
              <CircleAlert className="h-4 w-4" /> {error}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

function Usage({ label: l, used, total, frac }: { label: string; used: string; total: string; frac: number }) {
  return (
    <div className="glass rounded-[18px] px-4 py-3">
      <p className="text-[12.5px] text-s-ink-3">{l}</p>
      <p className="mt-1 text-[14px] font-medium tabular-nums">
        {used} <span className="text-s-ink-3">of {total}</span>
      </p>
      <div className="mt-2 h-1.5 rounded-full bg-s-hover" role="progressbar" aria-valuenow={Math.round(frac * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={l}>
        <div className={cn("h-full rounded-full", frac > 0.9 ? "bg-red-500" : frac > 0.7 ? "bg-amber-400" : "bg-s-accent")} style={{ width: `${frac * 100}%` }} />
      </div>
    </div>
  );
}

function StepCard({ s }: { s: Step }) {
  const [open, setOpen] = useState(false);
  const waiting = s.status === "pending" && typeof s.state.waiting === "string";
  const ms = s.started_at && s.finished_at ? new Date(s.finished_at).getTime() - new Date(s.started_at).getTime() : null;
  const out = s.output as Record<string, unknown> | null;
  return (
    <li className="glass rounded-2xl">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0">
        {STEP_ICON[waiting ? "waiting" : s.status]}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-medium">
            <span className="text-s-ink-3">{AGENT_NAME[s.agent] ?? s.agent} · </span>
            {s.title}
          </p>
          <p className="truncate text-[12px] text-s-ink-3">
            {s.key}
            {s.depends_on.length ? ` ← ${s.depends_on.join(", ")}` : ""}
            {s.attempt > 1 ? ` · attempt ${s.attempt}/${s.max_attempts}` : ""}
            {ms !== null ? ` · ${dur(ms)}` : ""}
            {s.model_id ? ` · ${s.model_id}` : ""}
            {s.tokens ? ` · ${s.tokens.toLocaleString("en-US")} tokens` : ""}
            {s.cost_usd !== null && s.cost_usd !== undefined ? ` · ≈ ${usd(Number(s.cost_usd))}` : ""}
            {waiting ? ` · ${String(s.state.waiting)}` : ""}
          </p>
        </div>
      </button>
      {open && (
        <div className="border-t border-s-line px-4 py-3 text-[13px]">
          {s.error && <p className={cn("mb-2", s.status === "skipped" ? "text-s-ink-2" : "text-s-danger")}>{s.error}</p>}
          <StepOutput k={s.key} out={out} />
          {!out && !s.error && <p className="text-s-ink-3">{s.status === "running" ? `Working… ${typeof s.state.detail === "string" ? s.state.detail : ""}` : "No output yet."}</p>}
        </div>
      )}
    </li>
  );
}

function StepOutput({ k, out }: { k: string; out: Record<string, unknown> | null }) {
  if (!out) return null;
  const base = k.replace(/-\d+$/, "");
  if (base === "baseline" || base === "test" || base === "buildcheck") {
    const results = (out.results ?? []) as CheckResult[];
    return (
      <div className="space-y-2">
        {base === "test" && (out.newFailures as string[])?.length ? <p className="text-s-danger">New failures: {(out.newFailures as string[]).join(", ")}</p> : null}
        {base === "test" && (out.preexisting as string[])?.length ? <p className="text-amber-700 dark:text-amber-300">Failing before the change too: {(out.preexisting as string[]).join(", ")}</p> : null}
        {results.map((r) => (
          <details key={r.id} className="rounded-xl border border-s-line">
            <summary className="cursor-pointer px-3 py-2">
              <span className={r.passed ? "text-emerald-600 dark:text-emerald-400" : "text-s-danger"}>{r.passed ? "passed" : r.timedOut ? "timed out" : "failed"}</span> · {r.label} · exit {r.exitCode ?? "—"} · {dur(r.durationMs)}
            </summary>
            <pre className="s-scroll max-h-72 overflow-auto whitespace-pre-wrap border-t border-s-line p-3 text-[11.5px]">{r.outputTail}</pre>
          </details>
        ))}
      </div>
    );
  }
  if (base === "plan" && out.plan) {
    const p = out.plan as Plan;
    return (
      <div className="space-y-2">
        <p>{p.summary}</p>
        <ul className="list-disc pl-5 text-s-ink-2">{p.changes.map((c) => <li key={c.path}><code>{c.path}</code> ({c.action}) — {c.intent}</li>)}</ul>
        {p.risks.length > 0 && <p className="text-s-ink-3">Risks: {p.risks.join("; ")}</p>}
      </div>
    );
  }
  if (base === "map") {
    const files = (out.relevantFiles ?? []) as { path: string; why: string }[];
    return (
      <div className="space-y-2">
        <p>{String(out.summary ?? "")}</p>
        <ul className="list-disc pl-5 text-s-ink-2">{files.map((f) => <li key={f.path}><code>{f.path}</code> — {f.why}</li>)}</ul>
        <p className="text-[12px] text-s-ink-3">Searched: {((out.searchTerms ?? []) as string[]).join(", ")} · {String(out.fileCount ?? "")} files in repo</p>
      </div>
    );
  }
  if (base === "review") {
    const findings = (out.findings ?? []) as { severity: string; issue: string; file?: string; evidence: string }[];
    const criteria = (out.criteria ?? []) as { criterion: string; status: string; evidence: string }[];
    return (
      <div className="space-y-2">
        <p>
          Recommendation: <strong>{String(out.recommendation)}</strong> — {String(out.summary ?? "")}
        </p>
        {findings.map((f, i) => <p key={i} className="text-s-ink-2">[{f.severity}] {f.issue}{f.file ? ` (${f.file})` : ""}</p>)}
        <ul className="list-disc pl-5 text-s-ink-2">{criteria.map((c) => <li key={c.criterion}>{c.status === "met" ? "✅" : c.status === "not_met" ? "❌" : "❔"} {c.criterion} — {c.evidence}</li>)}</ul>
      </div>
    );
  }
  if (base === "security") {
    const findings = (out.findings ?? []) as { severity: string; issue: string; file: string; source: string; evidence: string }[];
    return findings.length ? (
      <ul className="space-y-1">{findings.map((f, i) => <li key={i}>[{f.severity}] {f.issue} <span className="text-s-ink-3">({f.file}; {f.source})</span></li>)}</ul>
    ) : (
      <p className="text-s-ink-2">No security findings on the added lines{out.aiReview ? " (rules + AI review)" : " (rules only)"}.</p>
    );
  }
  if (base === "verify") {
    const v = out as unknown as Verification;
    return (
      <div className="space-y-1">
        <p className="font-medium">{v.verdict === "verified" ? "✅ Verified" : "⚠️ Not verified"}</p>
        {v.checks.map((c) => <p key={c.name}>{c.passed ? "✅" : "❌"} {c.name} — {c.evidence}</p>)}
        {v.reasons.map((r) => <p key={r} className="text-s-danger">{r}</p>)}
      </div>
    );
  }
  if (base === "build" || base === "repair") {
    return (
      <div className="space-y-1">
        {typeof out.rootCause === "string" && <p>Root cause: {out.rootCause}</p>}
        <p className="text-s-ink-2">{String(out.notes ?? "")}</p>
        <p className="text-[12px] text-s-ink-3">Files: {((out.files ?? []) as string[]).join(", ")} {out.checkpoint ? `· checkpoint ${String(out.checkpoint).slice(0, 10)}` : ""}</p>
      </div>
    );
  }
  return <pre className="s-scroll max-h-60 overflow-auto whitespace-pre-wrap text-[11.5px] text-s-ink-2">{JSON.stringify(out, null, 2).slice(0, 4000)}</pre>;
}
