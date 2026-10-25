"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, CircleAlert, CircleDashed, CircleMinus, Copy, ExternalLink, Loader2, RefreshCw, Wrench } from "lucide-react";
import { highlight } from "@/components/common/highlight";
import { StudioHeader, useStudio } from "@/components/studio/frame";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { Classification, FindingDetails, InvestigationStep } from "@/lib/security/details";
import { cn, isSafeHttpUrl } from "@/lib/utils";
import { ClassificationBadge } from "./audit-views";
import {
  AGENT_NAME,
  AgentBadge,
  ConfidenceBadge,
  EMPTY_RUN,
  FINDING_STATUS_LABEL,
  FindingStatus,
  fmtTime,
  ICON_OF,
  RunProgress,
  SeverityBadge,
  streamRun,
  VERIFICATION_LABEL,
  type RunState,
} from "./bits";
import type { FindingSummary } from "./findings-panel";
import { inputCls, labelCls } from "./forms";

interface Finding extends FindingSummary {
  rule_id: string;
  description: string;
  rationale: string;
  evidence: { source: string; detail: string }[];
  remediation: string;
  refs: string[];
  verification_note: string | null;
  related: string[];
  user_note: string | null;
  patch: string | null;
  tests: string | null;
  first_seen: string;
}
interface Mini {
  id: string;
  title: string;
  severity: string;
  agent: string;
  status: string;
  asset: string;
}
interface Detail {
  finding: Finding;
  related: Mini[];
  duplicates: Mini[];
  history: { id: number; action: string; detail: Record<string, unknown>; created_at: string }[];
  run: { id: string; agent: string; action: string; started_at: string } | null;
  classification: Classification;
  details: FindingDetails;
  investigation: InvestigationStep[];
}

const STEP_ICON: Record<InvestigationStep["state"], React.ReactNode> = {
  done: <Check className="text-emerald-500" />,
  partial: <CircleDashed className="text-amber-500" />,
  not_done: <CircleMinus className="text-s-ink-3" />,
};

const selectCls = "h-9 w-full rounded-xl border border-s-line bg-transparent px-2.5 text-[13px] text-s-ink outline-none focus:border-s-line-strong";

export function FindingView({ id }: { id: string }) {
  const { notify } = useStudio();
  const router = useRouter();
  const [fixing, setFixing] = useState(false);
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<FindingSummary[]>([]);
  const [recheck, setRecheck] = useState<RunState>(EMPTY_RUN);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    jsonFetch<Detail>(`/api/security/findings/${id}`)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
        void jsonFetch<{ findings: FindingSummary[] }>(`/api/security/findings?asset=${encodeURIComponent(d.finding.asset)}&agent=${d.finding.agent}`).then((r) => alive && setCandidates(r.findings.filter((f) => f.id !== id && !f.duplicate_of)));
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [id, version]);

  const patch = async (body: Record<string, unknown>, message: string) => {
    setSaving(true);
    try {
      await jsonFetch(`/api/security/findings/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      notify(message);
      setVersion((v) => v + 1);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runRecheck = async () => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setRecheck({ ...EMPTY_RUN, phase: "running" });
    try {
      const r = await streamRun(`/api/security/findings/${id}/recheck`, {}, ctrl.signal, setRecheck);
      setRecheck((s) => ({ ...s, phase: r.ok ? "done" : "error" }));
    } catch {
      setRecheck((s) => ({ ...s, phase: "cancelled" }));
    }
    abort.current = null;
    setVersion((v) => v + 1);
  };

  // Opens a Code project with the audited repository and starts the coding agent with plan approval and edit review on.
  const fixWithAgent = async () => {
    setFixing(true);
    try {
      const { projectId, task } = await jsonFetch<{ projectId: string; task: string }>(`/api/security/findings/${id}/fix`, { method: "POST", body: "{}" });
      const r = await jsonFetch<{ run: { id: string } }>(`/api/code/projects/${projectId}/agent`, {
        method: "POST",
        body: JSON.stringify({ request: task, options: { approvePlans: true, reviewEdits: true, commands: "safe" } }),
      });
      router.push(`/code/${projectId}?run=${r.run.id}`);
    } catch (e) {
      notify((e as Error).message);
      setFixing(false);
    }
  };

  const header = (
    <StudioHeader>
      <Link href="/agents/security" className="inline-flex items-center gap-1.5 text-[14px] text-s-ink-2 transition hover:text-s-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden /> <span className="max-sm:sr-only">Security</span>
      </Link>
      <span className="text-s-ink-3">/</span>
      <span className="truncate text-[14px] font-medium">Finding</span>
    </StudioHeader>
  );

  if (error)
    return (
      <>
        {header}
        <div role="alert" className="mx-auto mt-16 flex max-w-md flex-col items-center px-6 text-center">
          <CircleAlert className="h-6 w-6 text-s-danger" />
          <h1 className="mt-3 text-[15px] font-normal">{error}</h1>
        </div>
      </>
    );
  if (!data)
    return (
      <>
        {header}
        <div className="mx-auto w-full max-w-[1100px] space-y-3 px-4 pt-6 sm:px-8">
          <div className="s-skeleton h-10 w-2/3 rounded-xl" />
          <div className="s-skeleton h-40 rounded-2xl" />
        </div>
      </>
    );

  const f = data.finding;
  const canRecheck = f.agent === "sentinel" || (f.agent === "code_guardian" && f.asset.startsWith("github:"));
  const userNote = note ?? f.user_note ?? "";

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-[1100px] gap-6 px-4 pb-24 pt-2 sm:px-8 lg:grid-cols-[1fr_300px]">
          <div className="min-w-0 space-y-5">
            <div className="s-in">
              <div className="flex items-center gap-2 text-[12.5px] text-s-ink-3">
                <AgentBadge agent={f.agent} icon={ICON_OF[f.agent]!} size="sm" /> {AGENT_NAME[f.agent]} · {f.rule_id} · source: {f.evidence_source}
              </div>
              <h1 className="mt-3 text-[clamp(22px,3vw,28px)] font-semibold leading-tight tracking-[-0.01em]">{f.title}</h1>
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <SeverityBadge severity={f.severity} />
                <ClassificationBadge value={data.classification} />
                <ConfidenceBadge confidence={f.confidence} />
                <FindingStatus status={f.status} />
                {f.duplicate_of && (
                  <Link href={`/agents/security/findings/${f.duplicate_of}`} className="rounded-full border border-s-line px-2.5 py-0.5 text-[11.5px] text-s-ink-2 hover:bg-s-hover">
                    Duplicate — open original
                  </Link>
                )}
              </div>
              <dl className="mt-4 grid gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2">
                <div>
                  <dt className="inline text-s-ink-3">Asset: </dt>
                  <dd className="inline break-all">{f.asset}</dd>
                </div>
                {f.location && (
                  <div>
                    <dt className="inline text-s-ink-3">Location: </dt>
                    <dd className="inline break-all">{f.location}</dd>
                  </div>
                )}
                <div>
                  <dt className="inline text-s-ink-3">First seen: </dt>
                  <dd className="inline">
                    {fmtTime(f.first_seen)}
                    {data.run && (
                      <Link href={`/agents/security/runs/${data.run.id}`} className="ml-1 text-s-ink-2 underline underline-offset-2">
                        (run)
                      </Link>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-s-ink-3">Last seen: </dt>
                  <dd className="inline">
                    {fmtTime(f.last_seen)} · {f.occurrences}× detected
                  </dd>
                </div>
              </dl>
            </div>

            <Section title="What's wrong">
              <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-s-ink-2">{f.description}</p>
            </Section>
            <Section title="Severity vs. confidence">
              <p className="text-[13.5px] text-s-ink-2">
                <strong className="font-medium capitalize text-s-ink">{f.severity}</strong> — {f.rationale}
              </p>
              <p className="mt-1.5 text-[12.5px] text-s-ink-3">Severity is how serious this would be if real. Confidence ({f.confidence}) is how sure the tool is that it is real.</p>
            </Section>
            <Section title="Evidence">
              <ul className="space-y-2">
                {f.evidence.map((e, i) => (
                  <li key={i}>
                    <p className="text-[12.5px] text-s-ink-3">{e.source}</p>
                    <pre tabIndex={0} aria-label={`Evidence from ${e.source}`} className="s-scroll mt-1 overflow-x-auto rounded-xl border border-s-line bg-s-hover/60 px-3 py-2 text-[12.5px]">
                      <code>{e.detail}</code>
                    </pre>
                  </li>
                ))}
              </ul>
            </Section>
            <Section title="Expected vs observed">
              <dl className="space-y-2 text-[13.5px]">
                <div>
                  <dt className="text-[12.5px] text-s-ink-3">Expected (secure behaviour)</dt>
                  <dd>{data.details.expected}</dd>
                </div>
                <div>
                  <dt className="text-[12.5px] text-s-ink-3">Observed</dt>
                  <dd className="break-words">{data.details.observed}</dd>
                </div>
              </dl>
            </Section>
            <Section title="Reproduce (in your authorised environment)">
              <ol className="list-decimal space-y-1 pl-5 text-[13.5px] text-s-ink-2">
                {data.details.reproduce.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ol>
              <p className="mt-2 text-[12px] text-s-ink-3">Use test accounts and synthetic data; never real users&apos; data.</p>
            </Section>
            <Section title="Impact and root cause">
              <dl className="space-y-2 text-[13.5px]">
                <div>
                  <dt className="text-[12.5px] text-s-ink-3">Realistic impact</dt>
                  <dd>{data.details.impact}</dd>
                </div>
                <div>
                  <dt className="text-[12.5px] text-s-ink-3">What an attacker needs first</dt>
                  <dd>{data.details.privileges}</dd>
                </div>
                <div>
                  <dt className="text-[12.5px] text-s-ink-3">Root cause</dt>
                  <dd>{data.details.rootCause}</dd>
                </div>
                {data.details.cvss && (
                  <div>
                    <dt className="text-[12.5px] text-s-ink-3">CVSS 3.1 vector (typical for this kind of issue; the explanation above is what matters)</dt>
                    <dd className="font-mono text-[12px]">{data.details.cvss}</dd>
                  </div>
                )}
              </dl>
            </Section>
            <Section title="How to fix it">
              <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{f.remediation}</p>
            </Section>
            <Section title="Verify the fix">
              <ol className="list-decimal space-y-1 pl-5 text-[13.5px] text-s-ink-2">
                {data.details.verify.map((v, i) => (
                  <li key={i}>{v}</li>
                ))}
              </ol>
              <p className="mt-2 text-[12px] text-s-ink-3">A finding counts as fixed only when a check shows it — editing the code isn&apos;t enough.</p>
            </Section>
            <Section title="Investigation">
              <ol className="space-y-2">
                {data.investigation.map((st) => (
                  <li key={st.id} className="flex items-start gap-2.5 text-[13.5px] [&>svg]:mt-0.5 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0">
                    {STEP_ICON[st.state]}
                    <span>
                      <span className="font-medium">{st.label}</span>
                      <span className="sr-only"> ({st.state.replace("_", " ")})</span>
                      <span className="block text-[12.5px] text-s-ink-2">{st.detail}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </Section>
            {f.patch && (
              <Section title="Proposed patch">
                <p className="mb-2 text-[12.5px] text-s-ink-3">AI-proposed and not applied or tested. Review it, apply it in your codebase, run the tests, then re-check.</p>
                <CodeBlock code={f.patch} lang="diff" />
                {f.tests && (
                  <>
                    <p className="mb-2 mt-4 text-[12.5px] font-medium text-s-ink-2">Suggested regression test</p>
                    <CodeBlock code={f.tests} lang="ts" />
                  </>
                )}
              </Section>
            )}
            {f.refs.length > 0 && (
              <Section title="References">
                <ul className="space-y-1">
                  {f.refs.map((r) => (
                    <li key={r}>
                      {/* References come from scanners and models: only http(s) links are clickable. */}
                      {isSafeHttpUrl(r) ? (
                        <a href={r} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1.5 break-all text-[13px] text-s-ink-2 underline-offset-2 hover:text-s-ink hover:underline">
                          <ExternalLink className="h-3.5 w-3.5 shrink-0" /> {r}
                        </a>
                      ) : (
                        <span className="break-all text-[13px] text-s-ink-2">{r}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            {(data.related.length > 0 || data.duplicates.length > 0) && (
              <Section title="Related findings">
                <ul className="space-y-1.5">
                  {[...data.related.map((r) => ({ ...r, tag: "related" })), ...data.duplicates.map((r) => ({ ...r, tag: "duplicate of this" }))].map((r) => (
                    <li key={`${r.tag}-${r.id}`}>
                      <Link href={`/agents/security/findings/${r.id}`} className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-[13px] hover:bg-s-hover">
                        <AgentBadge agent={r.agent} icon={ICON_OF[r.agent]!} size="sm" />
                        <span className="min-w-0 flex-1 truncate">{r.title}</span>
                        <span className="text-[11.5px] text-s-ink-3">{r.tag}</span>
                        <SeverityBadge severity={r.severity} />
                      </Link>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[12px] text-s-ink-3">Links between agents’ findings are leads to check, not proof of exploitation.</p>
              </Section>
            )}
            {data.history.length > 0 && (
              <Section title="History">
                <ol className="space-y-1.5 text-[12.5px] text-s-ink-2">
                  {data.history.map((h) => (
                    <li key={h.id}>
                      <span className="text-s-ink-3">{fmtTime(h.created_at)}</span> · {h.action.replace(".", " ")}{" "}
                      {h.action === "finding.updated" &&
                        Object.entries(h.detail as Record<string, { from: unknown; to: unknown }>)
                          .map(([k, v]) => `${k.replace("_", " ")}: ${String(v.from ?? "—").slice(0, 40)} → ${String(v.to ?? "—").slice(0, 40)}`)
                          .join("; ")}
                    </li>
                  ))}
                </ol>
              </Section>
            )}
          </div>

          <aside className="space-y-4 lg:sticky lg:top-2 lg:self-start">
            <div className="glass rounded-[20px] p-4">
              <h2 className="text-[13.5px] font-semibold">Status</h2>
              <select aria-label="Status" value={f.status} disabled={saving} onChange={(e) => void patch({ status: e.target.value }, `Marked ${FINDING_STATUS_LABEL[e.target.value]}`)} className={cn(selectCls, "mt-2")}>
                {Object.entries(FINDING_STATUS_LABEL).filter(([k]) => k !== "verified" || f.status === "verified").map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              {f.status !== "false_positive" && (
                <button type="button" disabled={saving} onClick={() => void patch({ status: "false_positive" }, "Marked as false positive")} className="mt-2 h-9 w-full rounded-xl border border-s-line text-[13px] transition hover:bg-s-hover">
                  Mark as false positive
                </button>
              )}
              <div className="mt-4 border-t border-s-line pt-3">
                <p className="text-[12.5px] text-s-ink-3">Verification</p>
                <p className="mt-0.5 text-[13.5px]">{VERIFICATION_LABEL[f.verification]}</p>
                {f.verification_note && <p className="mt-0.5 text-[12px] text-s-ink-3">{f.verification_note}</p>}
                <button
                  type="button"
                  onClick={() => (recheck.phase === "running" ? abort.current?.abort() : void runRecheck())}
                  disabled={!canRecheck}
                  title={canRecheck ? undefined : f.agent === "code_guardian" ? "Re-run Audit code with updated files under the same project name." : "Investigate newer logs to see if the activity continues."}
                  className="mt-2 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-s-ink text-[13px] font-medium text-s-bg transition hover:opacity-90 disabled:opacity-40"
                >
                  {recheck.phase === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {recheck.phase === "running" ? "Cancel re-check" : "Re-check now"}
                </button>
                {!canRecheck && <p className="mt-1.5 text-[12px] text-s-ink-3">{f.agent === "code_guardian" ? "Uploaded code: run Audit code again with the fixed files and the same project name." : "Log findings: investigate newer logs to see whether it continues."}</p>}
                <RunProgress state={recheck} />
                {f.agent === "code_guardian" && f.asset.startsWith("github:") && f.location && !["fixed", "verified", "false_positive"].includes(f.status) && (
                  <>
                    <button
                      type="button"
                      onClick={() => void fixWithAgent()}
                      disabled={fixing}
                      className="mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl border border-s-line-strong text-[13px] font-medium transition hover:bg-s-hover disabled:opacity-50"
                    >
                      {fixing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Wrench className="h-4 w-4" aria-hidden />} Fix with the coding agent
                    </button>
                    <p className="mt-1.5 text-[12px] text-s-ink-3">
                      Opens a Code project with this repository. You approve the agent&apos;s plan and edits; it adds a regression test and runs the checks. Nothing is pushed or deployed.
                    </p>
                  </>
                )}
              </div>
            </div>

            <div className="glass rounded-[20px] p-4">
              <h2 className="text-[13.5px] font-semibold">Corrections</h2>
              <label className={cn(labelCls, "mt-3")} htmlFor="sev">
                Severity
              </label>
              <select id="sev" value={f.severity} disabled={saving} onChange={(e) => void patch({ severity: e.target.value }, "Severity updated")} className={selectCls}>
                {["critical", "high", "medium", "low", "info"].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <label className={cn(labelCls, "mt-3")} htmlFor="conf">
                Confidence
              </label>
              <select id="conf" value={f.confidence} disabled={saving} onChange={(e) => void patch({ confidence: e.target.value }, "Confidence updated")} className={selectCls}>
                {["confirmed", "firm", "tentative"].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <label className={cn(labelCls, "mt-3")} htmlFor="note">
                Reviewer note
              </label>
              <textarea id="note" rows={3} value={userNote} onChange={(e) => setNote(e.target.value)} placeholder="Why you changed it, context for teammates…" className={cn(inputCls, "h-auto py-2 text-[13px]")} />
              <button
                type="button"
                disabled={saving || userNote === (f.user_note ?? "")}
                onClick={() => void patch({ user_note: userNote || null }, "Note saved").then(() => setNote(null))}
                className="mt-2 h-9 w-full rounded-xl border border-s-line-strong text-[13px] font-medium transition hover:bg-s-hover disabled:opacity-40"
              >
                Save note
              </button>
            </div>

            <div className="glass rounded-[20px] p-4">
              <h2 className="text-[13.5px] font-semibold">Duplicates</h2>
              {f.duplicate_of ? (
                <button type="button" disabled={saving} onClick={() => void patch({ duplicate_of: null }, "No longer a duplicate")} className="mt-2 h-9 w-full rounded-xl border border-s-line text-[13px] hover:bg-s-hover">
                  Not a duplicate
                </button>
              ) : candidates.length === 0 ? (
                <p className="mt-1.5 text-[12.5px] text-s-ink-3">No other findings from this agent on this asset.</p>
              ) : (
                <>
                  <label htmlFor="dup" className="sr-only">
                    Mark as duplicate of
                  </label>
                  <select id="dup" defaultValue="" disabled={saving} onChange={(e) => e.target.value && void patch({ duplicate_of: e.target.value }, "Marked as duplicate")} className={cn(selectCls, "mt-2")}>
                    <option value="">Mark as duplicate of…</option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title.slice(0, 70)}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1.5 text-[12px] text-s-ink-3">Duplicates are hidden from the findings list by default.</p>
                </>
              )}
            </div>
          </aside>
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="glass rounded-[20px] p-5">
      <h2 className="mb-2.5 text-[13px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">{title}</h2>
      {children}
    </section>
  );
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-lg border border-s-line bg-s-bg px-2 py-1 text-[11.5px]"
      >
        {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? "Copied" : "Copy"}
      </button>
      <pre className="s-scroll max-h-[420px] overflow-auto rounded-xl border border-s-line bg-s-hover/60 p-3 pr-16 text-[12.5px]">
        <code>{highlight(code, lang)}</code>
      </pre>
    </div>
  );
}
