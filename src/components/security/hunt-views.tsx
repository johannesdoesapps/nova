"use client";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { ChevronDown, CircleAlert, CircleCheck, CircleDashed, CircleHelp, Copy, ExternalLink, Search } from "lucide-react";
import { useStudio } from "@/components/studio/frame";
import { jsonFetch } from "@/hooks/use-ndjson";
import { NOT_CONNECTED, SOURCE_LABEL, type FileInventory, type SourceKind } from "@/lib/security/hunt/events";
import type { IndicatorRecord } from "@/lib/security/hunt/intel";
import { ACTION_STATUSES, INVESTIGATION_STATES, STATE_LABEL, type ActionStatus, type Investigation, type InvestigationState } from "@/lib/security/hunt/investigate";
import type { QaIssue } from "@/lib/security/hunt/qa";
import { techniqueUrl } from "@/lib/security/hunt/rules";
import { cn } from "@/lib/utils";
import { Section } from "./audit-views";
import { SEVERITY_DOT } from "./bits";

/**
 * Threat Hunter's investigation workspace pieces. Everything shown is the stored investigation record from a
 * real run; recommended actions are shown as recommendations, and their statuses are what people recorded.
 */

const STATE_STYLE: Record<InvestigationState, string> = {
  new: "border-s-line-strong text-s-ink-2",
  investigating: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  suspicious: "border-amber-500/40 text-amber-700 dark:text-amber-300",
  likely_malicious: "border-[color-mix(in_srgb,var(--s-danger)_45%,transparent)] text-s-danger",
  confirmed_malicious: "border-[color-mix(in_srgb,var(--s-danger)_70%,transparent)] bg-[color-mix(in_srgb,var(--s-danger)_10%,transparent)] text-s-danger",
  benign: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
  inconclusive: "border-s-line-strong text-s-ink-3",
  contained: "border-sky-500/40 text-sky-700 dark:text-sky-300",
  resolved: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
};

export function StateBadge({ state }: { state: InvestigationState }) {
  return <span className={cn("inline-flex h-6 items-center rounded-full border px-2 text-[11.5px] font-medium", STATE_STYLE[state])}>{STATE_LABEL[state]}</span>;
}

const URGENCY_LABEL: Record<Investigation["urgency"], string> = { immediate: "Act now", high: "High urgency", normal: "Normal urgency", low: "Low urgency" };

export function InvestigationList({ runId, investigations, trimmed, onChange }: { runId: string; investigations: Investigation[]; trimmed?: string[]; onChange?: (inv: Investigation) => void }) {
  const [open, setOpen] = useState<string | null>(investigations[0]?.id ?? null);
  if (!investigations.length)
    return (
      <Section title="Investigations">
        <p className="text-[13.5px] text-s-ink-2">
          No detection fired on the data provided. That only covers the sources and time range in the coverage list below — it isn&apos;t evidence that nothing happened.
        </p>
      </Section>
    );
  return (
    <section aria-labelledby="investigations">
      <h2 id="investigations" className="mb-3 text-[15px] font-semibold">
        Investigations ({investigations.length})
      </h2>
      <ul className="space-y-2.5">
        {investigations.map((inv) => (
          <li key={inv.id} id={inv.id} className="glass rounded-[20px]">
            <button
              type="button"
              onClick={() => setOpen(open === inv.id ? null : inv.id)}
              aria-expanded={open === inv.id}
              className="flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-5 py-4 text-left"
            >
              <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", SEVERITY_DOT[inv.severity])} aria-hidden />
              <span className="min-w-0 flex-1 text-[14.5px] font-semibold">{inv.title}</span>
              <StateBadge state={inv.state} />
              <span className="text-[12px] text-s-ink-3">
                {inv.severity} · {URGENCY_LABEL[inv.urgency]} · {inv.confidence.level} confidence
              </span>
              <ChevronDown className={cn("h-4 w-4 text-s-ink-3 transition", open === inv.id && "rotate-180")} aria-hidden />
            </button>
            {open === inv.id && (
              <div className="border-t border-s-line px-5 pb-5 pt-4">
                <InvestigationPanel runId={runId} inv={inv} onChange={onChange} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {trimmed && trimmed.length > 0 && <p className="mt-2 text-[12px] text-s-ink-3">{trimmed.join(" ")}</p>}
    </section>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">{title}</h3>
      {children}
    </div>
  );
}

/** Red when the evidence points towards harm (malicious supported, or benign contradicted), green when away from it. */
function verdictIcon(h: Investigation["hypotheses"][number]) {
  if (h.verdict === "open") return <CircleHelp className="text-s-ink-3" aria-hidden />;
  const towardsHarm = (h.kind === "malicious") === (h.verdict === "supported");
  return <CircleCheck className={towardsHarm ? "text-s-danger" : "text-emerald-500"} aria-hidden />;
}

export function InvestigationPanel({ runId, inv, onChange }: { runId: string; inv: Investigation; onChange?: (inv: Investigation) => void }) {
  const [q, setQ] = useState("");
  const [record, setRecord] = useState(inv);
  const timeline = useMemo(() => record.timeline.filter((t) => !q || `${t.label} ${t.ref} ${t.time}`.toLowerCase().includes(q.toLowerCase())), [record.timeline, q]);
  const update = (next: Investigation) => {
    setRecord(next);
    onChange?.(next);
  };
  return (
    <div className="space-y-5 text-[13.5px]">
      <p className="leading-relaxed">{record.assessment}</p>
      <p className="text-[12.5px] text-s-ink-3">Confidence basis: {record.confidence.basis}</p>

      <Block title="Signals">
        <ul className="space-y-1.5">
          {record.signals.map((s) => (
            <li key={s.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", SEVERITY_DOT[s.severity])} aria-hidden />
              {/^[0-9a-f-]{36}$/.test(s.id) ? (
                <Link href={`/agents/security/findings/${s.id}`} className="font-medium underline underline-offset-2">
                  {s.title}
                </Link>
              ) : (
                <span className="font-medium">{s.title}</span>
              )}
              <span className="text-[12px] text-s-ink-3">
                {s.severity}/{s.confidence}
              </span>
              <span className="w-full pl-4 text-[12.5px] text-s-ink-2">{s.observed}</span>
            </li>
          ))}
        </ul>
      </Block>

      {record.chain.length > 0 && (
        <Block title="Attack chain (only stages the evidence shows)">
          <ol className="flex flex-wrap items-stretch gap-2">
            {record.chain.map((c, i) => (
              <li key={c.tactic} className="flex items-center gap-2">
                <div className={cn("rounded-xl border px-3 py-2", c.status === "observed" ? "border-s-line-strong" : "border-dashed border-s-line-strong")}>
                  <p className="text-[12.5px] font-semibold">{c.tactic}</p>
                  <p className="text-[11.5px] text-s-ink-3">{c.status === "observed" ? "Observed" : c.status === "attempted" ? "Attempted (success not shown)" : "Inferred"}</p>
                  <p className="mt-0.5 text-[11.5px]">
                    {c.techniques.map((t) => (
                      <a key={t.id} href={techniqueUrl(t.id)} target="_blank" rel="noopener noreferrer" className="mr-1.5 text-s-ink-2 underline underline-offset-2" title={t.name}>
                        {t.id}
                      </a>
                    ))}
                  </p>
                </div>
                {i < record.chain.length - 1 && (
                  <span aria-hidden className="text-s-ink-3">
                    →
                  </span>
                )}
              </li>
            ))}
          </ol>
        </Block>
      )}

      {record.hypotheses.length > 0 && (
        <Block title="Hypotheses">
          <ul className="space-y-2">
            {record.hypotheses.map((h, i) => (
              <li key={i} className="flex items-start gap-2 [&>svg]:mt-0.5 [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0">
                {verdictIcon(h)}
                <div>
                  <p>
                    <span className="font-medium">{h.kind === "malicious" ? "Malicious" : "Benign"}:</span> {h.statement}{" "}
                    <span className="text-[12px] text-s-ink-3">
                      ({h.verdict === "supported" ? "supported by the evidence" : h.verdict === "contradicted" ? "contradicted by the evidence" : "can't tell from the data"})
                    </span>
                  </p>
                  {h.supports.length > 0 && <p className="text-[12.5px] text-s-ink-2">For: {h.supports.join(" ")}</p>}
                  {h.contradicts.length > 0 && <p className="text-[12.5px] text-s-ink-2">Against: {h.contradicts.join(" ")}</p>}
                </div>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {!record.summaryOnly && (
        <Block title={`Timeline (${record.timeline.length})`}>
          <label className="relative mb-2 block max-w-sm">
            <span className="sr-only">Search the timeline</span>
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-s-ink-3" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search events, accounts, lines…"
              className="h-8 w-full rounded-lg border border-s-line bg-transparent pl-8 pr-2 text-[12.5px] outline-none focus:border-s-line-strong"
            />
          </label>
          <ol className="max-h-[360px] space-y-1 overflow-y-auto border-l border-s-line pl-3" tabIndex={0} aria-label="Investigation timeline">
            {timeline.map((t, i) => (
              <li key={`${t.ref}-${i}`} className={cn("text-[12.5px]", t.signal ? "font-medium" : "text-s-ink-2")}>
                <span className="text-s-ink-3">{t.time ? new Date(t.time).toISOString().replace("T", " ").slice(0, 19) + "Z" : "no time"}</span> · {t.label}{" "}
                <span className="text-[11px] text-s-ink-3">({t.ref})</span>
              </li>
            ))}
            {!timeline.length && <li className="text-[12.5px] text-s-ink-3">No matching events.</li>}
          </ol>
          <p className="mt-1.5 text-[12px] text-s-ink-3">Times in UTC. Bold lines are the signals; the rest is surrounding activity by the same accounts or addresses.</p>
          {record.gaps.length > 0 && (
            <p className="mt-1 text-[12px] text-amber-700 dark:text-amber-300">
              Gaps in the logs during this window: {record.gaps.map((g) => `${g.hours}h in ${g.file} from ${g.from.slice(0, 16)}`).join("; ")}.
            </p>
          )}
        </Block>
      )}

      <Block title="Entities and how they're linked">
        <p className="text-[12.5px]">
          Accounts: {record.entities.users.join(", ") || "—"} · Hosts: {record.entities.hosts.join(", ") || "—"} · Addresses: {record.entities.ips.join(", ") || "—"}
        </p>
        {record.links.length > 0 && <p className="mt-1 text-[12.5px] text-s-ink-2">{record.links.join(" ")}</p>}
        {(record.prior?.length ?? 0) > 0 && (
          <p className="mt-1 text-[12.5px] text-s-ink-2">
            Earlier related investigations:{" "}
            {record.prior!.map((p) => (
              <Link key={`${p.runId}-${p.invId}`} href={`/agents/security/runs/${p.runId}#${p.invId}`} className="mr-2 underline underline-offset-2">
                {p.title.slice(0, 60)} ({STATE_LABEL[p.state]}; shares {p.overlap.join(", ")})
              </Link>
            ))}
          </p>
        )}
      </Block>

      {(record.questions.length > 0 || record.blocked.length > 0) && (
        <Block title="Open questions and checks that couldn't be done">
          <ul className="list-disc space-y-0.5 pl-5 text-[12.5px] text-s-ink-2">
            {record.questions.map((x, i) => (
              <li key={`q${i}`}>{x}</li>
            ))}
            {record.blocked.map((x, i) => (
              <li key={`b${i}`}>Not possible with this data: {x}</li>
            ))}
          </ul>
        </Block>
      )}

      {record.summaryOnly ? (
        <p className="rounded-xl border border-dashed border-s-line-strong px-3 py-2 text-[12.5px] text-s-ink-2">
          Only a summary of this investigation could be stored with this run (the record has a size limit), so its timeline, explanations and response plan aren&apos;t shown. Open its signals above
          for the full evidence, or run Threat Hunter again on these logs alone.
        </p>
      ) : (
        <ResponsePlanView runId={runId} inv={record} onSaved={update} />
      )}
      <Decisions runId={runId} inv={record} onSaved={update} />
      {!record.summaryOnly && <Handoffs inv={record} />}
    </div>
  );
}

const STATUS_LABEL: Record<ActionStatus, string> = { approved: "Approved", declined: "Declined", done: "Done", verified: "Verified" };

function ResponsePlanView({ runId, inv, onSaved }: { runId: string; inv: Investigation; onSaved: (i: Investigation) => void }) {
  const { notify } = useStudio();
  const [busy, setBusy] = useState<string | null>(null);
  const r = inv.response;
  const set = async (key: string, status: ActionStatus) => {
    setBusy(key);
    try {
      const res = await jsonFetch<{ investigation: Investigation }>(`/api/security/runs/${runId}/investigations/${inv.id}`, { method: "PATCH", body: JSON.stringify({ action: { key, status } }) });
      onSaved(res.investigation);
      notify(`Recorded: ${STATUS_LABEL[status].toLowerCase()}`);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const list = (items: string[]) =>
    items.length > 0 && (
      <ul className="list-disc space-y-0.5 pl-5 text-[12.5px]">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    );
  const actions = (section: "containment" | "credentials" | "eradication", label: string) =>
    r[section].length > 0 && (
      <div>
        <p className="mt-2 text-[12.5px] font-medium">{label}</p>
        <ul className="mt-1 space-y-1.5">
          {r[section].map((a, i) => {
            const key = `${section}:${i}`;
            const st = inv.actions?.[key];
            return (
              <li key={key} className="rounded-xl border border-s-line px-3 py-2">
                <p className="text-[12.5px]">
                  {a.text} {a.approval && <span className="ml-1 rounded-full border border-amber-500/40 px-1.5 text-[10.5px] text-amber-700 dark:text-amber-300">needs approval</span>}
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="text-[11.5px] text-s-ink-3">{st ? `${STATUS_LABEL[st.status]} ${new Date(st.at).toLocaleString()}` : "Recommended — not done"}</span>
                  {ACTION_STATUSES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={busy === key || st?.status === s}
                      onClick={() => void set(key, s)}
                      className="h-7 rounded-lg border border-s-line px-2 text-[11.5px] transition hover:bg-s-hover disabled:opacity-40"
                    >
                      Mark {STATUS_LABEL[s].toLowerCase()}
                    </button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    );
  return (
    <Block title="Recommended response">
      <p className="mb-2 text-[12px] text-s-ink-3">Recommendations only — Orbis hasn&apos;t done any of these. Statuses are what you record here.</p>
      {r.priorities.length > 0 && <p className="text-[12.5px] font-medium">Priorities</p>}
      {list(r.priorities)}
      {r.preserve.length > 0 && <p className="mt-2 text-[12.5px] font-medium">Preserve evidence first</p>}
      {list(r.preserve)}
      {r.scope.length > 0 && <p className="mt-2 text-[12.5px] font-medium">Establish scope</p>}
      {list(r.scope)}
      {actions("containment", "Containment")}
      {actions("credentials", "Credentials and tokens")}
      {r.investigate.length > 0 && <p className="mt-2 text-[12.5px] font-medium">Investigate further</p>}
      {list(r.investigate)}
      {actions("eradication", "Eradication and recovery")}
      {r.validation.length > 0 && <p className="mt-2 text-[12.5px] font-medium">Validate</p>}
      {list(r.validation)}
      {r.followUp.length > 0 && <p className="mt-2 text-[12.5px] font-medium">Follow up</p>}
      {list(r.followUp)}
    </Block>
  );
}

function Decisions({ runId, inv, onSaved }: { runId: string; inv: Investigation; onSaved: (i: Investigation) => void }) {
  const { notify } = useStudio();
  const [state, setState] = useState<InvestigationState>(inv.state);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const body = state !== inv.state ? { state, note } : { note };
      const res = await jsonFetch<{ investigation: Investigation }>(`/api/security/runs/${runId}/investigations/${inv.id}`, { method: "PATCH", body: JSON.stringify(body) });
      onSaved(res.investigation);
      setNote("");
      notify("Decision recorded");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const changing = state !== inv.state;
  return (
    <Block title="Decision">
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[12.5px]">
          <span className="mb-1 block text-s-ink-3">State</span>
          <select value={state} onChange={(e) => setState(e.target.value as InvestigationState)} className="h-9 rounded-xl border border-s-line bg-transparent px-2.5 text-[13px]">
            {INVESTIGATION_STATES.map((s) => (
              <option key={s} value={s}>
                {STATE_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-[220px] flex-1 text-[12.5px]">
          <span className="mb-1 block text-s-ink-3">{changing ? "Why (required)" : "Note"}</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            placeholder={changing ? "e.g. Owner confirmed it was them" : "Add a note"}
            className="h-9 w-full rounded-xl border border-s-line bg-transparent px-2.5 text-[13px]"
          />
        </label>
        <button
          type="button"
          disabled={busy || (changing ? note.trim().length < 3 : !note.trim())}
          onClick={() => void save()}
          className="h-9 rounded-xl bg-s-ink px-3.5 text-[13px] font-medium text-s-bg disabled:opacity-40"
        >
          Record
        </button>
      </div>
      <p className="mt-1.5 text-[12px] text-s-ink-3">Only you can mark an investigation confirmed malicious, benign, contained or resolved. Every change is kept in the audit trail.</p>
      {(inv.decisions?.length ?? 0) > 0 && (
        <ol className="mt-2 space-y-0.5 text-[12.5px] text-s-ink-2">
          {inv.decisions!.map((d, i) => (
            <li key={i}>
              <span className="text-s-ink-3">{new Date(d.at).toLocaleString()}</span> · {d.state ? `State → ${STATE_LABEL[d.state]}. ` : ""}
              {d.note}
            </li>
          ))}
        </ol>
      )}
    </Block>
  );
}

const HANDOFF_LABEL: Record<Investigation["handoffs"][number]["to"], string> = {
  sentinel: "Orbis Sentinel",
  code_guardian: "Orbis Code Guardian",
  research: "Deep Research",
  writing: "Summary for others",
};

function Handoffs({ inv }: { inv: Investigation }) {
  const { notify } = useStudio();
  if (!inv.handoffs.length) return null;
  const summary = () =>
    [
      `# ${inv.title}`,
      `State: ${STATE_LABEL[inv.state]} · Severity: ${inv.severity} · Urgency: ${URGENCY_LABEL[inv.urgency]} · Confidence: ${inv.confidence.level}`,
      "",
      inv.assessment,
      "",
      "## Signals",
      ...inv.signals.map((s) => `- ${s.title} (${s.severity}/${s.confidence}): ${s.observed}`),
      "",
      "## Open questions",
      ...inv.questions.map((x) => `- ${x}`),
      "",
      "## Recommended next steps (not yet done)",
      ...[...inv.response.priorities, ...inv.response.containment.map((c) => `${c.text}${c.approval ? " (needs approval)" : ""}`)].map((x) => `- ${x}`),
    ].join("\n");
  return (
    <Block title="Hand-offs to other agents">
      <ul className="space-y-2">
        {inv.handoffs.map((h, i) => (
          <li key={i} className="rounded-xl border border-s-line px-3 py-2 text-[12.5px]">
            <p className="font-medium">
              {HANDOFF_LABEL[h.to]}: <span className="font-normal">{h.task}</span>
            </p>
            <p className="text-s-ink-3">
              Scope: {h.scope} Permissions: {h.permissions}
            </p>
            {h.questions.length > 0 && <p className="text-s-ink-2">Questions: {h.questions.join(" ")}</p>}
            <div className="mt-1.5">
              {h.to === "research" && (
                <Link href={`/research?q=${encodeURIComponent(h.task)}&context=${encodeURIComponent(h.questions.join("\n"))}`} className="inline-flex items-center gap-1 underline underline-offset-2">
                  Open in Deep Research <ExternalLink className="h-3 w-3" aria-hidden />
                </Link>
              )}
              {(h.to === "sentinel" || h.to === "code_guardian") && (
                <Link href="/agents/security" className="inline-flex items-center gap-1 underline underline-offset-2">
                  Open the Security Team to run it <ExternalLink className="h-3 w-3" aria-hidden />
                </Link>
              )}
              {h.to === "writing" && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(summary());
                    notify("Summary copied");
                  }}
                  className="inline-flex items-center gap-1 underline underline-offset-2"
                >
                  <Copy className="h-3 w-3" aria-hidden /> Copy the investigation summary
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[12px] text-s-ink-3">
        Hand-offs open the other agent with the task filled in; nothing starts until you start it, and their answers are checked against this evidence, not taken as proof.
      </p>
    </Block>
  );
}

/* ------------------------------------------------------------ coverage */

const FIELD_LABEL = { time: "time", user: "account", ip: "address", host: "host", process: "process" } as const;

export function SourceCoverage({ inventory, baselines, shared }: { inventory: FileInventory[]; baselines?: { newSource: { assessed: number; insufficient: number } } | null; shared?: string[] }) {
  return (
    <Section title="Coverage and blind spots" id="coverage">
      {inventory.length === 0 ? (
        <p className="text-[13px] text-s-ink-2">No logs were analysed in this run.</p>
      ) : (
        <ul className="space-y-3">
          {inventory.map((f) => (
            <li key={f.file} className="text-[13px]">
              <p className="font-medium">
                {f.file}{" "}
                <span className="font-normal text-s-ink-3">
                  · {f.events} events
                  {f.unparsed ? `, ${f.unparsed} lines not recognised` : ""}
                </span>
              </p>
              <p className="text-[12.5px] text-s-ink-2">
                {Object.entries(f.formats)
                  .map(([k, v]) => `${SOURCE_LABEL[k as SourceKind] ?? k} (${v})`)
                  .join(", ") || "No supported format recognised"}
                {f.first ? ` · ${f.first.slice(0, 16)} → ${(f.last ?? "").slice(0, 16)} UTC` : ""}
              </p>
              <p className="text-[12px] text-s-ink-3">
                Fields present: {(Object.keys(FIELD_LABEL) as (keyof typeof FIELD_LABEL)[]).map((k) => `${FIELD_LABEL[k]} ${Math.round(f.fields[k] * 100)}%`).join(", ")}. Ingestion delay: not
                applicable (uploaded export).
              </p>
              {f.gaps.length > 0 && <p className="text-[12px] text-amber-700 dark:text-amber-300">Gaps: {f.gaps.map((g) => `${g.hours}h from ${g.from.slice(0, 16)}`).join("; ")}</p>}
              {f.assumptions.map((a, i) => (
                <p key={i} className="text-[12px] text-s-ink-3">
                  {a}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
      {baselines && (
        <p className="mt-3 text-[12.5px] text-s-ink-2">
          Behavioural baseline (new sign-in sources): {baselines.newSource.assessed} account(s) had enough history (7+ days, 10+ sign-ins) to compare; {baselines.newSource.insufficient} didn&apos;t,
          so they weren&apos;t assessed.
        </p>
      )}
      {shared && shared.length > 0 && <p className="mt-1 text-[12.5px] text-s-ink-2">Shared addresses (several users sign in from them; not used to link activity): {shared.join(", ")}.</p>}
      <div className="mt-4 rounded-xl border border-s-line bg-s-hover/50 p-3">
        <h3 className="text-[13px] font-semibold">Not connected</h3>
        <ul className="mt-1.5 space-y-1 text-[12.5px] text-s-ink-2">
          {NOT_CONNECTED.map((n) => (
            <li key={n.source} className="flex items-start gap-2">
              <CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0 text-s-ink-3" aria-hidden />
              <span>
                <span className="font-medium text-s-ink">{n.source}.</span> Blocked: {n.blocks}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

export function IntelRecords({ records }: { records: IndicatorRecord[] }) {
  if (!records.length) return null;
  return (
    <Section title="Indicator intelligence" note="Third-party reputation is context, not proof: shared hosting, CDNs, VPNs and recycled addresses can carry reports about someone else.">
      <ul className="space-y-2">
        {records.map((r) => (
          <li key={`${r.type}:${r.value}`} className="text-[13px]">
            <p>
              <span className="font-mono text-[12.5px]">{r.value}</span> <span className="text-s-ink-3">({r.type})</span> · {r.checked ? r.rating : "not checked"}
              {r.seenInLogs ? <span className="text-s-ink-3"> · {r.seenInLogs} event(s) in your logs</span> : null}
            </p>
            <p className="text-[12px] text-s-ink-3">
              Source: {r.source}
              {r.retrievedAt ? `, retrieved ${new Date(r.retrievedAt).toLocaleString()}` : ""}
              {r.lastSeen ? `; last reported ${r.lastSeen.slice(0, 10)}` : ""}
              {r.context.length ? `; ${r.context.join(", ")}` : ""}
            </p>
            {r.caveats.length > 0 && <p className="text-[12px] text-amber-700 dark:text-amber-300">{r.caveats.join(" ")}</p>}
          </li>
        ))}
      </ul>
    </Section>
  );
}

const QA_LABEL: Record<QaIssue["kind"], string> = {
  attribution: "Unsupported attribution",
  overconfidence: "More certain than the evidence",
  unseen_source: "Refers to data Orbis didn't have",
  monitoring_claim: "Claims monitoring",
};

export function QaNotes({ issues }: { issues: QaIssue[] }) {
  if (!issues.length) return null;
  return (
    <section role="note" className="rounded-[20px] border border-amber-500/40 bg-amber-500/[0.06] p-4">
      <p className="flex items-center gap-2 text-[13.5px] font-semibold">
        <CircleAlert className="h-4 w-4 text-amber-600" aria-hidden /> Quality check: {issues.length} statement(s) in the report need care
      </p>
      <ul className="mt-2 space-y-1.5 text-[12.5px]">
        {issues.map((i, n) => (
          <li key={n}>
            <span className="font-medium">{QA_LABEL[i.kind]}:</span> “{i.quote}” — <span className="text-s-ink-2">{i.why}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
