"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, CircleAlert, Download, ShieldCheck } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader, useStudio } from "@/components/studio/frame";
import { Segmented } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { Asset } from "@/lib/security/aegis/model";
import { canTransition, PERSON_STATUSES, REMEDIATION_LABEL, type RemediationStatus } from "@/lib/security/aegis/remediation-states";
import type { AegisState } from "@/lib/security/aegis/state";
import { Section } from "./audit-views";
import { ConfidenceBadge, fmtTime, SeverityBadge } from "./bits";

/**
 * Orbis Aegis command center: what's happening across the security team, what matters, the evidence, what to
 * do next and whether it's resolved. Everything is assembled from the agents' stored results and the decisions
 * people recorded; attack paths are hypotheses, unavailable agents are shown as unavailable, and a remediation
 * is "Verified" only when a re-check after the fix says so.
 */

type Tab = "overview" | "risks" | "paths" | "investigations" | "remediation" | "assets" | "coverage" | "tasks" | "reports";
const TIER_LABEL = { immediate: "Immediate", priority: "Priority", strategic: "Strategic" } as const;
const TIER_NOTE = {
  immediate: "Act now: serious, exposed or with signs of exploitation.",
  priority: "Fix this week or in the next planned change.",
  strategic: "Improve over time; not urgent on the evidence Orbis has.",
} as const;
const STATE_STYLE: Record<string, string> = {
  assessed: "text-emerald-700 dark:text-emerald-300",
  partial: "text-amber-700 dark:text-amber-300",
  not_assessed: "text-s-ink-2",
  unavailable: "text-s-ink-3",
};
const STATE_LABEL: Record<string, string> = { assessed: "Assessed", partial: "Partly assessed", not_assessed: "Not assessed", unavailable: "Unavailable" };

export function AegisWorkspace() {
  const { user, integrations } = useApp();
  const { notify } = useStudio();
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<AegisState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedOut = integrations.supabase ? !user : true;

  const load = useCallback(() => jsonFetch<AegisState>("/api/security/aegis").then(setData), []);
  useEffect(() => {
    if (signedOut) return;
    let alive = true;
    void load().catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [signedOut, load]);

  /** Record a decision, then reload (the state is rebuilt from the recorded decisions). One at a time, so a
   *  double click can't record the same note, exception or task decision twice. */
  const acting = useRef(false);
  const act = useCallback(
    async (body: Record<string, unknown>, done?: string) => {
      if (acting.current) return false;
      acting.current = true;
      try {
        await jsonFetch("/api/security/aegis/actions", { method: "POST", body: JSON.stringify(body) });
        await load();
        if (done) notify(done);
        return true;
      } catch (e) {
        notify((e as Error).message);
        return false;
      } finally {
        acting.current = false;
      }
    },
    [load, notify],
  );

  return (
    <>
      <StudioHeader>
        <Link href="/agents/security" className="inline-flex items-center gap-1.5 text-[14px] text-s-ink-2 transition hover:text-s-ink">
          <ArrowLeft className="h-4 w-4" aria-hidden /> <span className="max-sm:sr-only">Security</span>
        </Link>
        <span className="text-s-ink-3">/</span>
        <span className="whitespace-nowrap text-[14px] font-medium">Aegis</span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-5 px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(30px,4.5vw,42px)] leading-[1.05]">Aegis</h1>
            <p className="mt-2 max-w-3xl text-[15px] text-s-ink-2">
              The security team&apos;s command center: one prioritised view of what your agents found, how findings connect, what to do next and what&apos;s really been fixed. Aegis decides and
              coordinates; it doesn&apos;t scan, and it never changes your systems.
            </p>
          </div>
          <div className="max-w-full overflow-x-auto">
            <Segmented
              label="Aegis sections"
              value={tab}
              onChange={setTab}
              options={[
                { value: "overview", label: "Overview" },
                { value: "risks", label: "Risks" },
                { value: "paths", label: "Attack paths" },
                { value: "investigations", label: "Investigations" },
                { value: "remediation", label: "Remediation" },
                { value: "assets", label: "Assets" },
                { value: "coverage", label: "Coverage" },
                { value: "tasks", label: "Tasks & agents" },
                { value: "reports", label: "Reports" },
              ]}
            />
          </div>
          {signedOut ? (
            <p className="rounded-[20px] border border-dashed border-s-line-strong px-6 py-8 text-center text-[14px] text-s-ink-2">Sign in to see your security posture.</p>
          ) : error ? (
            <p role="alert" className="flex items-center gap-2 text-[14px] text-s-danger">
              <CircleAlert className="h-4 w-4" /> {error}
            </p>
          ) : !data ? (
            <div className="s-skeleton h-48 rounded-2xl" />
          ) : tab === "overview" ? (
            <Overview s={data} onViewed={() => void act({ kind: "viewed" }, "Marked as reviewed. Changes are now counted from today.")} />
          ) : tab === "risks" ? (
            <Risks s={data} act={act} />
          ) : tab === "paths" ? (
            <Paths s={data} />
          ) : tab === "investigations" ? (
            <Investigations s={data} act={act} />
          ) : tab === "remediation" ? (
            <Remediations s={data} act={act} />
          ) : tab === "assets" ? (
            <Assets s={data} act={act} />
          ) : tab === "coverage" ? (
            <CoverageView s={data} />
          ) : tab === "tasks" ? (
            <Tasks s={data} act={act} />
          ) : (
            <Reports />
          )}
        </div>
      </div>
    </>
  );
}

type Act = (body: Record<string, unknown>, done?: string) => Promise<boolean>;

const btn = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-s-line-strong px-2.5 text-[12.5px] transition hover:bg-s-hover disabled:opacity-50";
const input = "h-9 rounded-xl border border-s-line bg-transparent px-2.5 text-[13.5px] text-s-ink";

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-s-line px-3 py-2.5">
      <dt className="text-[12px] text-s-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[20px] font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-[11.5px] text-s-ink-3">{hint}</dd>}
    </div>
  );
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-s-ink-2">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

/* --------------------------------------------------------------- overview */

function Overview({ s, onViewed }: { s: AegisState; onViewed: () => void }) {
  const immediate = s.ranked.filter((r) => r.tier === "immediate").length;
  const priority = s.ranked.filter((r) => r.tier === "priority").length;
  const q: [string, string[]][] = [
    ["What is happening?", s.answers.happening],
    ["What matters most?", s.answers.matters],
    ["What's the evidence?", s.answers.evidence],
    ["What should happen next?", s.answers.next],
    ["Is it resolved?", s.answers.resolved],
  ];
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Immediate" value={immediate} hint="act now" />
        <Stat label="Priority" value={priority} hint="this week" />
        <Stat label="Attack-path hypotheses" value={s.paths.length} hint="none reproduced" />
        <Stat label="Domains assessed" value={`${s.coverage.domains.filter((d) => d.state === "assessed").length}/${s.coverage.domains.length}`} />
      </dl>
      <div className="grid gap-4 md:grid-cols-2">
        {q.map(([title, lines]) => (
          <Section key={title} title={title}>
            <Bullets items={lines} />
          </Section>
        ))}
        <Section title="Since you last looked" note={s.changes.since ? `Counted from ${s.changes.since.slice(0, 10)}.` : undefined}>
          <p className="text-[13.5px] text-s-ink-2">
            {s.changes.newSince} new security finding(s), {s.changes.resolvedSince} no longer detected by a re-check.
          </p>
          <button type="button" className={`${btn} mt-3`} onClick={onViewed}>
            Mark as reviewed
          </button>
        </Section>
      </div>
      <Section title="Recent activity">
        {s.timeline.length ? (
          <ul className="space-y-1.5 text-[13px]">
            {s.timeline.slice(0, 15).map((t, i) => (
              <li key={i} className="flex gap-3">
                <span className="w-28 shrink-0 text-s-ink-3">{fmtTime(t.at)}</span>
                {t.ref ? (
                  <Link href={t.ref} className="min-w-0 hover:underline">
                    {t.text}
                  </Link>
                ) : (
                  <span className="min-w-0">{t.text}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13.5px] text-s-ink-2">Nothing recorded yet. Run an agent from the Security Team page to start.</p>
        )}
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ risks */

function Risks({ s, act }: { s: AegisState; act: Act }) {
  const [except, setExcept] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      {(["immediate", "priority", "strategic"] as const).map((tier) => {
        const rows = s.ranked.filter((r) => r.tier === tier);
        return (
          <Section key={tier} title={`${TIER_LABEL[tier]} · ${rows.length}`} note={TIER_NOTE[tier]}>
            {!rows.length ? (
              <p className="text-[13.5px] text-s-ink-2">Nothing here.</p>
            ) : (
              <ul className="divide-y divide-s-line">
                {rows.slice(0, 40).map((r) => (
                  <li key={r.finding.id} className="py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/agents/security/findings/${r.finding.id}`} className="min-w-0 flex-1 basis-[240px] text-[13.5px] font-medium hover:underline">
                        {r.finding.title}
                      </Link>
                      <SeverityBadge severity={r.finding.severity} />
                      <ConfidenceBadge confidence={r.finding.confidence} />
                      <span className="rounded-full border border-s-line px-2 py-0.5 text-[11.5px] text-s-ink-2">{r.urgency}</span>
                    </div>
                    <p className="mt-1 text-[12.5px] text-s-ink-2">
                      {r.finding.asset.replace(/^github:/, "")} · {r.finding.agent.replace("_", " ")} · {r.why}
                    </p>
                    <details className="mt-1 text-[12.5px]">
                      <summary className="cursor-pointer text-s-ink-3">Why this rank ({r.points} points)</summary>
                      <ul className="mt-1 space-y-0.5 pl-4 text-s-ink-2">
                        {r.factors.map((f, i) => (
                          <li key={i}>
                            {f.points > 0 ? "+" : ""}
                            {f.points} {f.label}
                          </li>
                        ))}
                      </ul>
                    </details>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <button
                        type="button"
                        className={btn}
                        onClick={() =>
                          void act(
                            { kind: "remediation", title: `Fix: ${r.finding.title}`.slice(0, 200), findingIds: [r.finding.id], status: "proposed" },
                            "Remediation proposed. Track it under Remediation.",
                          )
                        }
                      >
                        Propose remediation
                      </button>
                      <button type="button" className={btn} onClick={() => setExcept(except === r.finding.id ? null : r.finding.id)}>
                        Accept risk for a time…
                      </button>
                    </div>
                    {except === r.finding.id && <ExceptionForm id={r.finding.id} act={act} onDone={() => setExcept(null)} />}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        );
      })}
      <Section title={`Not ranked · ${s.excluded.length}`} note="Resolved, false positives, duplicates, engineering-only notes and accepted risks with an active exception.">
        {s.excluded.length ? <Bullets items={s.excluded.slice(0, 30).map((e) => `${e.title} — ${e.reason}`)} /> : <p className="text-[13.5px] text-s-ink-2">Nothing excluded.</p>}
      </Section>
      <Section title="How Aegis ranks" note="These assumptions are applied the same way to every finding.">
        <Bullets items={s.assumptions} />
      </Section>
    </div>
  );
}

function ExceptionForm({ id, act, onDone }: { id: string; act: Act; onDone: () => void }) {
  const [until, setUntil] = useState(() => new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2 rounded-xl border border-s-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void act({ kind: "exception", findingId: id, until, reason }, "Exception recorded. It ends on the date you chose.").then((ok) => (ok ? onDone() : setBusy(false)));
      }}
    >
      <label className="flex flex-col gap-1 text-[12px] text-s-ink-3">
        Until
        <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className={input} required />
      </label>
      <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[12px] text-s-ink-3">
        Reason (who decided, and what compensates)
        <input value={reason} onChange={(e) => setReason(e.target.value)} className={input} minLength={10} maxLength={1000} required />
      </label>
      <button type="submit" className={btn} disabled={busy}>
        Record exception
      </button>
    </form>
  );
}

/* ------------------------------------------------------------------ paths */

function Paths({ s }: { s: AegisState }) {
  if (!s.paths.length) {
    return (
      <Section title="No attack-path hypotheses">
        <p className="text-[13.5px] text-s-ink-2">Aegis didn&apos;t find findings that combine into a plausible path. More coverage (see Coverage) can change that.</p>
      </Section>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-s-ink-2">
        Each path is a hypothesis built from recorded findings. None has been reproduced; Orbis doesn&apos;t try to exploit anything. Links between assets you haven&apos;t confirmed are marked as
        assumed.
      </p>
      {s.paths.map((p) => (
        <Section key={p.id} title={`${p.source === "cross-agent" ? "Cross-agent" : "Single domain"} · ${p.confidence} confidence`}>
          <h3 className="text-[15px] font-medium">{p.title}</h3>
          <p className="mt-1 text-[12.5px] text-s-ink-3">
            {p.agents.map((a) => a.replace("_", " ")).join(", ")} · {p.assets.map((a) => a.replace(/^github:/, "")).join(", ")}
          </p>
          <ol className="mt-3 space-y-1.5 text-[13px]">
            {p.steps.map((st, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-24 shrink-0 text-[12px] text-s-ink-3">{st.kind}</span>
                <span>{st.text}</span>
              </li>
            ))}
          </ol>
          <div className="mt-3 grid gap-3 text-[13px] md:grid-cols-2">
            <div>
              <p className="font-medium">Impact if real</p>
              <p className="text-s-ink-2">{p.impact}</p>
              <p className="mt-2 font-medium">Why this confidence</p>
              <p className="text-s-ink-2">{p.confidenceBasis}</p>
              {p.relations.length > 0 && (
                <>
                  <p className="mt-2 font-medium">How the pieces relate</p>
                  <Bullets items={p.relations.map((r) => `${r.basis}: ${r.detail}`)} />
                </>
              )}
            </div>
            <div>
              <p className="font-medium">How to check it safely</p>
              <Bullets items={p.validation} />
              <p className="mt-2 font-medium">What breaks it</p>
              <Bullets items={p.mitigations} />
              {p.alternatives.length > 0 && (
                <>
                  <p className="mt-2 font-medium">Other explanations</p>
                  <Bullets items={p.alternatives} />
                </>
              )}
            </div>
          </div>
          <p className="mt-3 text-[12px] text-s-ink-3">{p.reproducedNote}</p>
        </Section>
      ))}
    </div>
  );
}

/* --------------------------------------------------------- investigations */

function Investigations({ s, act }: { s: AegisState; act: Act }) {
  const [open, setOpen] = useState<string | null>(s.investigations[0]?.findingId ?? null);
  if (!s.investigations.length) {
    return (
      <Section title="No investigations">
        <p className="text-[13.5px] text-s-ink-2">Aegis opens an investigation record for each immediate or serious priority risk. There are none right now.</p>
      </Section>
    );
  }
  const title = (id: string) => s.ranked.find((r) => r.finding.id === id)?.finding.title ?? id;
  return (
    <div className="space-y-3">
      {s.investigations.map((inv) => (
        <Section key={inv.findingId} title={inv.conclusion ? `Concluded: ${inv.conclusion.outcome.replace("_", " ")}` : "Open"}>
          <button
            type="button"
            className="text-left text-[14.5px] font-medium hover:underline"
            onClick={() => setOpen(open === inv.findingId ? null : inv.findingId)}
            aria-expanded={open === inv.findingId}
          >
            {title(inv.findingId)}
          </button>
          {open === inv.findingId && (
            <div className="mt-3 space-y-3">
              <ol className="space-y-2">
                {inv.steps.map((st) => (
                  <li key={st.n} className="text-[13px]">
                    <p className="font-medium">
                      {st.n}. {st.label}
                    </p>
                    <Bullets items={st.content} />
                  </li>
                ))}
              </ol>
              {inv.trail.length > 0 && (
                <div>
                  <p className="text-[13px] font-medium">Evidence trail</p>
                  <Bullets items={inv.trail.map((t) => `${fmtTime(t.at)} — ${t.note}`)} />
                </div>
              )}
              <InvestigationForm id={inv.findingId} act={act} />
            </div>
          )}
        </Section>
      ))}
    </div>
  );
}

function InvestigationForm({ id, act }: { id: string; act: Act }) {
  const [note, setNote] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [outcome, setOutcome] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-2 rounded-xl border border-s-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void act(
          { kind: "investigation", findingId: id, ...(note.trim() ? { note } : {}), ...(conclusion.trim() ? { conclusion, outcome: outcome || undefined } : {}) },
          conclusion.trim() ? "Conclusion recorded." : "Note added.",
        ).then((ok) => {
          setBusy(false);
          if (ok) {
            setNote("");
            setConclusion("");
          }
        });
      }}
    >
      <label className="flex flex-col gap-1 text-[12px] text-s-ink-3">
        Add evidence or a note
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} className="rounded-xl border border-s-line bg-transparent p-2.5 text-[13.5px] text-s-ink" />
      </label>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[12px] text-s-ink-3">
          Conclusion (optional)
          <input value={conclusion} onChange={(e) => setConclusion(e.target.value)} maxLength={2000} className={input} />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-s-ink-3">
          Outcome
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className={input} required={!!conclusion.trim()}>
            <option value="">Choose…</option>
            <option value="exploitable">Exploitable</option>
            <option value="exploited">Exploited</option>
            <option value="not_exploitable">Not exploitable here</option>
            <option value="false_positive">False positive</option>
            <option value="inconclusive">Inconclusive</option>
          </select>
        </label>
        <button type="submit" className={btn} disabled={busy || (!note.trim() && !conclusion.trim())}>
          Save
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------ remediation */

function Remediations({ s, act }: { s: AegisState; act: Act }) {
  if (!s.remediations.length) {
    return (
      <Section title="No remediations yet">
        <p className="text-[13.5px] text-s-ink-2">Propose one from a risk under Risks. Its status moves as you approve and apply it; only a re-check after the fix can mark it verified.</p>
      </Section>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-s-ink-2">
        &ldquo;Verified&rdquo;, &ldquo;Partially resolved&rdquo; and &ldquo;Failed&rdquo; come only from re-checks run after you mark the fix as applied (Verification required). Submitting or
        deploying a fix doesn&apos;t count as verifying it.
      </p>
      {s.remediations.map((r) => (
        <Section key={r.id} title={`${r.id} · ${REMEDIATION_LABEL[r.status]}`}>
          <p className="text-[14.5px] font-medium">{r.title}</p>
          <p className="mt-1 text-[12.5px] text-s-ink-3">
            {r.findingIds.length} finding(s){r.appliedAt ? ` · applied ${fmtTime(r.appliedAt)}` : ""}
            {r.rollback ? ` · rollback: ${r.rollback}` : ""}
          </p>
          {r.remaining.length > 0 && <Bullets items={r.remaining} />}
          <ol className="mt-2 space-y-0.5 text-[12.5px] text-s-ink-2">
            {r.history.map((h, i) => (
              <li key={i}>
                {fmtTime(h.at)} — {REMEDIATION_LABEL[h.status]} ({h.by === "evidence" ? "re-check" : "you"}){h.note ? `: ${h.note}` : ""}
              </li>
            ))}
          </ol>
          <div className="mt-2 flex flex-wrap gap-2">
            {PERSON_STATUSES.filter((to) => !canTransition(r.status as RemediationStatus, to)).map((to) => (
              <button
                key={to}
                type="button"
                className={btn}
                onClick={() => {
                  const rollback = to === "rolled_back" ? (window.prompt("How was it rolled back?") ?? "") : undefined;
                  void act({ kind: "remediation", remediationId: r.id, title: r.title, findingIds: r.findingIds, status: to, ...(rollback ? { rollback } : {}) }, `Marked ${REMEDIATION_LABEL[to]}.`);
                }}
              >
                {to === "verification_required" ? "Fix applied — re-check needed" : REMEDIATION_LABEL[to]}
              </button>
            ))}
          </div>
        </Section>
      ))}
    </div>
  );
}

/* ----------------------------------------------------------------- assets */

function Assets({ s, act }: { s: AegisState; act: Act }) {
  const [edit, setEdit] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-s-ink-2">
        Tell Aegis how important each asset is and which belong together. Links you confirm are used to connect findings across agents; suggested links are only hypotheses until you do.
      </p>
      {s.assets.map((a) => (
        <Section key={a.key} title={`${a.kind.replace("_", " ")} · ${a.findings.open} open`}>
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-[14.5px] font-medium">{a.label}</p>
            <button type="button" className={btn} onClick={() => setEdit(edit === a.key ? null : a.key)} aria-expanded={edit === a.key}>
              Edit facts
            </button>
          </div>
          <p className="mt-1 text-[12.5px] text-s-ink-3">
            Criticality: {a.facts.criticality ?? "not set"} · Exposure: {a.facts.exposure ?? "not set"} · Data: {a.facts.data.length ? a.facts.data.join(", ") : "not set"}
            {a.facts.owner ? ` · Owner: ${a.facts.owner}` : ""}
          </p>
          {a.related.length > 0 && (
            <ul className="mt-2 space-y-1 text-[12.5px]">
              {a.related.map((r) => (
                <li key={r.key} className="flex flex-wrap items-center gap-2">
                  <span className={r.basis === "declared" ? "font-medium" : "text-s-ink-2"}>
                    {r.basis === "declared" ? "Linked" : "Suggested"}: {r.key.replace(/^github:/, "")}
                  </span>
                  {r.basis === "suggested" && (
                    <button type="button" className={btn} onClick={() => void act({ kind: "asset", asset: a.key, links: [...a.facts.links, r.key] }, "Link confirmed.")}>
                      Confirm link
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[12px] text-s-ink-3">
            {a.lastAssessed.length ? `Last assessed: ${a.lastAssessed.map((l) => `${l.agent.replace("_", " ")} ${fmtTime(l.at)}`).join("; ")}` : "Not assessed by any agent yet."}
          </p>
          {edit === a.key && <AssetForm a={a} act={act} onDone={() => setEdit(null)} />}
        </Section>
      ))}
      {s.identities.length > 0 && (
        <Section title="Identities seen in investigations">
          <Bullets items={s.identities.slice(0, 30).map((i) => `${i.name} — ${i.assets.join(", ") || "no asset"}; ${i.investigations.length} investigation(s)`)} />
        </Section>
      )}
    </div>
  );
}

function AssetForm({ a, act, onDone }: { a: Asset; act: Act; onDone: () => void }) {
  const [criticality, setCriticality] = useState(a.facts.criticality ?? "");
  const [exposure, setExposure] = useState(a.facts.exposure ?? "");
  const [data, setData] = useState<string[]>(a.facts.data);
  const [owner, setOwner] = useState(a.facts.owner ?? "");
  const kinds = ["personal", "financial", "credentials", "health", "public"];
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-3 space-y-2 rounded-xl border border-s-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        void act({ kind: "asset", asset: a.key, criticality: criticality || null, exposure: exposure || null, data, owner: owner.trim() || null }, "Saved.").then((ok) => (ok ? onDone() : setBusy(false)));
      }}
    >
      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1 text-[12px] text-s-ink-3">
          Criticality
          <select value={criticality} onChange={(e) => setCriticality(e.target.value)} className={input}>
            <option value="">Not set</option>
            {["critical", "high", "medium", "low"].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-s-ink-3">
          Exposure
          <select value={exposure} onChange={(e) => setExposure(e.target.value)} className={input}>
            <option value="">Not set</option>
            <option value="internet">Internet-facing</option>
            <option value="internal">Internal only</option>
          </select>
        </label>
        <label className="flex min-w-[180px] flex-1 flex-col gap-1 text-[12px] text-s-ink-3">
          Owner
          <input value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={120} className={input} />
        </label>
      </div>
      <fieldset className="flex flex-wrap gap-3 text-[13px]">
        <legend className="mb-1 text-[12px] text-s-ink-3">Data it holds</legend>
        {kinds.map((k) => (
          <label key={k} className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={data.includes(k)} onChange={(e) => setData(e.target.checked ? [...data, k] : data.filter((x) => x !== k))} />
            {k}
          </label>
        ))}
      </fieldset>
      <button type="submit" className={btn} disabled={busy}>
        Save facts
      </button>
    </form>
  );
}

/* --------------------------------------------------------------- coverage */

function CoverageView({ s }: { s: AegisState }) {
  return (
    <div className="space-y-4">
      <Section
        title="Security domains"
        note="Assessed means an agent ran there recently. Unavailable means Orbis has no agent or data source for it — it isn't monitored, whatever else this page says."
      >
        <ul className="divide-y divide-s-line">
          {s.coverage.domains.map((d) => (
            <li key={d.id} className="py-2.5 text-[13.5px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 font-medium">{d.label}</span>
                <span className={`text-[12.5px] ${STATE_STYLE[d.state]}`}>{STATE_LABEL[d.state]}</span>
              </div>
              {d.sources.length > 0 && <p className="text-[12.5px] text-s-ink-3">From: {d.sources.join(", ")}</p>}
              {d.gaps.length > 0 && <p className="text-[12.5px] text-s-ink-2">Gaps: {d.gaps.join("; ")}</p>}
            </li>
          ))}
        </ul>
      </Section>
      {s.coverage.stale.length > 0 && (
        <Section title="Out of date">
          <Bullets items={s.coverage.stale.map((x) => `${x.asset.replace(/^github:/, "")}: last ${x.agent.replace("_", " ")} run ${x.at.slice(0, 10)}`)} />
        </Section>
      )}
      <Section title="Threat intelligence">
        <Bullets
          items={[
            s.intel.kevAvailable
              ? `CISA Known Exploited Vulnerabilities catalogue loaded ${s.intel.kevRetrievedAt ? `(${s.intel.kevRetrievedAt.slice(0, 10)})` : ""}.`
              : "CISA's catalogue couldn't be loaded just now, so exploitation in the wild isn't factored in.",
            s.intel.abuseIpdb ? "IP reputation (AbuseIPDB) is available to Threat Hunter." : "IP reputation isn't configured on this server.",
            "Aegis doesn't monitor your systems continuously; it works from the results of the scans and uploads you run.",
          ]}
        />
      </Section>
    </div>
  );
}

/* ------------------------------------------------------------------ tasks */

function Tasks({ s, act }: { s: AegisState; act: Act }) {
  const open = s.tasks.filter((t) => t.state !== "done" && t.state !== "dismissed");
  const name = (id: string) => (id === "you" ? "You" : (s.agents.find((a) => a.agent.id === id)?.agent.name ?? id));
  return (
    <div className="space-y-4">
      <Section
        title={`Tasks · ${open.length} open`}
        note="Tasks run in parallel only when they don't depend on each other. Accepting a task doesn't start anything by itself; use its link to start the agent."
      >
        {!s.tasks.length ? (
          <p className="text-[13.5px] text-s-ink-2">No tasks.</p>
        ) : (
          <ul className="divide-y divide-s-line">
            {s.tasks.map((t) => (
              <li key={t.id} className="py-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11.5px] text-s-ink-3">{t.id}</span>
                  <span className="min-w-0 flex-1 basis-[220px] font-medium">{t.title}</span>
                  <span className="rounded-full border border-s-line px-2 py-0.5 text-[11.5px]">{t.state}</span>
                </div>
                <p className="mt-1 text-s-ink-2">
                  {name(t.agent)} · {t.scope} · within {t.dueInDays} day(s){t.dependsOn.length ? ` · after ${t.dependsOn.join(", ")}` : ""}
                  {t.parallel ? " · can run in parallel" : ""}
                </p>
                <p className="text-s-ink-2">Objective: {t.objective}</p>
                <p className="text-s-ink-3">Done when: {t.completion}</p>
                {t.stateReason && <p className="text-s-ink-3">{t.stateReason}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {t.state === "proposed" && (
                    <button type="button" className={btn} onClick={() => void act({ kind: "task", taskId: t.id, action: "accept" }, "Task accepted.")}>
                      Accept
                    </button>
                  )}
                  {(t.state === "proposed" || t.state === "accepted") && (
                    <button type="button" className={btn} onClick={() => void act({ kind: "task", taskId: t.id, action: "dismiss" }, "Task dismissed.")}>
                      Dismiss
                    </button>
                  )}
                  {t.start && (t.state === "accepted" || t.state === "proposed") && (
                    <Link href={t.start} className={btn}>
                      Open
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="The security team" note="Unavailable agents aren't simulated: their domains show as unavailable in Coverage.">
        <ul className="divide-y divide-s-line">
          {s.agents.map((a) => (
            <li key={a.agent.id} className="py-2.5 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 font-medium">{a.agent.name}</span>
                <span className={`text-[12.5px] ${a.agent.status === "available" ? STATE_STYLE.assessed : a.agent.status === "partial" ? STATE_STYLE.partial : STATE_STYLE.unavailable}`}>
                  {a.agent.status === "available" ? "Available" : a.agent.status === "partial" ? "Partly available" : "Unavailable"}
                </span>
              </div>
              <p className="text-s-ink-2">{a.agent.domain}</p>
              {a.runs > 0 && (
                <p className="text-s-ink-3">
                  {a.runs} run(s), {a.failed} failed{a.lastRun ? ` · last ${fmtTime(a.lastRun)}` : ""}
                </p>
              )}
              {a.agent.gaps.length > 0 && <p className="text-s-ink-3">Limits: {a.agent.gaps.join("; ")}</p>}
            </li>
          ))}
        </ul>
        {s.bastion && (
          <p className="mt-3 flex items-start gap-2 text-[12.5px] text-s-ink-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Orbis Bastion {s.bastion.available ? (s.bastion.lockdown ? "is in lockdown" : "is enforcing its policy") : "can't confirm its controls (protected actions are paused)"}:{" "}
              {s.bastion.denied} refused and {s.bastion.needsApproval} approval-needed action(s) recorded for your agents.{" "}
              <Link href="/agents/security/bastion" className="underline underline-offset-2">
                Open Bastion
              </Link>
            </span>
          </p>
        )}
      </Section>
    </div>
  );
}

/* ---------------------------------------------------------------- reports */

function Reports() {
  const types = [
    { id: "executive", title: "Executive summary", text: "Posture, what needs attention, business impact and decisions needed, in plain language." },
    { id: "technical", title: "Technical report", text: "Every ranked risk with its factors, evidence, attack-path hypotheses, duplicates and coverage gaps." },
    { id: "operational", title: "Operational plan", text: "Tasks with owners, order and completion criteria, remediation status and what's waiting for a re-check." },
  ];
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {types.map((t) => (
        <Section key={t.id} title={t.title}>
          <p className="text-[13.5px] text-s-ink-2">{t.text}</p>
          <a href={`/api/security/aegis/report?type=${t.id}`} className={`${btn} mt-3`} download>
            <Download className="h-3.5 w-3.5" /> Download (Markdown)
          </a>
        </Section>
      ))}
    </div>
  );
}
