"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CircleAlert, CircleCheck, CircleX, Copy, ExternalLink, FileUp, FlaskConical } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader, useStudio } from "@/components/studio/frame";
import { Segmented } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import { analyseLogs, type Analysis } from "@/lib/security/hunt/analyse";
import { filterEvents, NOT_CONNECTED, type FileInventory } from "@/lib/security/hunt/events";
import type { IndicatorRecord } from "@/lib/security/hunt/intel";
import { STATE_LABEL, type Investigation } from "@/lib/security/hunt/investigate";
import type { QaIssue } from "@/lib/security/hunt/qa";
import { HUNT_RULES, runRuleTests, techniqueUrl, type HuntRule } from "@/lib/security/hunt/rules";
import { validate, type ValidationSummary } from "@/lib/security/hunt/scenarios";
import { cn } from "@/lib/utils";
import { Section } from "./audit-views";
import { fmtTime, SEVERITY_DOT } from "./bits";
import { IntelRecords, SourceCoverage, StateBadge } from "./hunt-views";

/**
 * The Threat Hunter workspace: active investigations across your hunts, threat intelligence that touches
 * your stack, the detection library (with live test results and validation scenarios), the response
 * actions people recorded, and data coverage. Only real data from your runs; scenarios are labelled
 * synthetic.
 */

interface HuntRun {
  id: string;
  asset: string | null;
  status: string;
  started_at: string;
  stats: {
    investigations: Investigation[];
    investigationsTrimmed: string[];
    inventory: FileInventory[];
    baselines: { newSource: { assessed: number; insufficient: number } } | null;
    intel: IndicatorRecord[];
    qa: QaIssue[];
    events: number | null;
  };
}
interface Workspace {
  runs: HuntRun[];
  decisions: { id: number; action: string; run_id: string | null; detail: Record<string, unknown>; created_at: string }[];
}
interface IntelResponse {
  source: { name: string; url: string; version?: string; released?: string; retrievedAt?: string; entries?: number };
  stack: { cves: number; technologies: string[] };
  advisories: {
    cve: string;
    title: string;
    vendor: string;
    product: string;
    dateAdded: string;
    dueDate: string;
    ransomware: boolean;
    description: string;
    requiredAction: string;
    source: string;
    sourceUrl: string;
    match: { kind: string; detail: string; verified: boolean };
  }[];
  error?: string;
}

type Tab = "overview" | "intel" | "lab" | "response" | "coverage";
const CLOSED = new Set(["benign", "resolved", "contained"]);

export function HunterWorkspace() {
  const { user, integrations } = useApp();
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedOut = integrations.supabase ? !user : true;

  useEffect(() => {
    if (signedOut) return;
    let alive = true;
    jsonFetch<Workspace>("/api/security/hunter/workspace")
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [signedOut]);

  const all = useMemo(() => (data?.runs ?? []).flatMap((r) => r.stats.investigations.map((inv) => ({ inv, run: r }))), [data]);
  const header = (
    <StudioHeader>
      <Link href="/agents/security" className="inline-flex items-center gap-1.5 text-[14px] text-s-ink-2 transition hover:text-s-ink">
        <ArrowLeft className="h-4 w-4" aria-hidden /> <span className="max-sm:sr-only">Security</span>
      </Link>
      <span className="text-s-ink-3">/</span>
      <span className="whitespace-nowrap text-[14px] font-medium">Threat Hunter</span>
    </StudioHeader>
  );

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-5 px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(30px,4.5vw,42px)] leading-[1.05]">Threat Hunter</h1>
            <p className="mt-2 max-w-3xl text-[15px] text-s-ink-2">
              Investigations built from the logs you upload, with evidence, timelines, alternative explanations and response plans. Orbis reads what you give it — it doesn&apos;t monitor your systems
              or take action on them.
            </p>
          </div>
          <Segmented
            label="Threat Hunter sections"
            value={tab}
            onChange={setTab}
            options={[
              { value: "overview", label: "Overview" },
              { value: "intel", label: "Threat intelligence" },
              { value: "lab", label: "Detection lab" },
              { value: "response", label: "Response center" },
              { value: "coverage", label: "Coverage" },
            ]}
          />
          {signedOut && tab !== "lab" ? (
            <p className="rounded-[20px] border border-dashed border-s-line-strong px-6 py-8 text-center text-[14px] text-s-ink-2">
              Sign in to see your investigations.{" "}
              <button type="button" onClick={() => setTab("lab")} className="underline underline-offset-2">
                The Detection lab
              </button>{" "}
              works without an account.
            </p>
          ) : error ? (
            <p role="alert" className="flex items-center gap-2 text-[14px] text-s-danger">
              <CircleAlert className="h-4 w-4" /> {error}
            </p>
          ) : tab === "lab" ? (
            <DetectionLab />
          ) : !data ? (
            <div className="s-skeleton h-48 rounded-2xl" />
          ) : tab === "overview" ? (
            <Overview items={all} decisions={data.decisions} />
          ) : tab === "intel" ? (
            <Intelligence runs={data.runs} />
          ) : tab === "response" ? (
            <ResponseCenter items={all} decisions={data.decisions} />
          ) : (
            <CoverageTab runs={data.runs} items={all} />
          )}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-s-line px-3 py-2.5">
      <dt className="text-[12px] text-s-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[20px] font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Overview({ items, decisions }: { items: { inv: Investigation; run: HuntRun }[]; decisions: Workspace["decisions"] }) {
  const active = items.filter((x) => !CLOSED.has(x.inv.state));
  const confirmed = items.filter((x) => x.inv.state === "confirmed_malicious").length;
  const unconfirmed = active.filter((x) => x.inv.state !== "confirmed_malicious").length;
  const users = [...new Set(active.flatMap((x) => x.inv.entities.users))];
  const hosts = [...new Set(active.flatMap((x) => x.inv.entities.hosts))];
  if (!items.length)
    return (
      <Section title="No investigations yet">
        <p className="text-[13.5px] text-s-ink-2">
          Run Threat Hunter from the{" "}
          <Link href="/agents/security" className="underline underline-offset-2">
            Security Team
          </Link>{" "}
          with logs exported from your systems (web, SSH or Linux auth, CloudTrail, Okta, Windows/Sysmon JSON, DNS). Investigations appear here.
        </p>
      </Section>
    );
  const sorted = [...active].sort((a, b) => b.inv.priority - a.inv.priority);
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Active investigations" value={active.length} />
        <Stat label="Confirmed by you" value={confirmed} />
        <Stat label="Not yet confirmed" value={unconfirmed} />
        <Stat label="Affected accounts / hosts" value={`${users.length} / ${hosts.length}`} />
      </dl>
      <Section title="Highest priority" note="Priority orders the list; it isn't a verdict. Only you can confirm an incident.">
        <ul className="divide-y divide-s-line">
          {sorted.slice(0, 15).map(({ inv, run }) => (
            <li key={`${run.id}-${inv.id}`}>
              <Link href={`/agents/security/runs/${run.id}#${inv.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[13.5px] hover:underline">
                <span className={cn("h-2 w-2 rounded-full", SEVERITY_DOT[inv.severity])} aria-hidden />
                <span className="min-w-0 flex-1 font-medium">{inv.title}</span>
                <StateBadge state={inv.state} />
                <span className="text-[12px] text-s-ink-3">
                  {inv.urgency} urgency · {run.asset} · {fmtTime(run.started_at)}
                </span>
              </Link>
            </li>
          ))}
          {!sorted.length && <li className="py-2 text-[13px] text-s-ink-2">Nothing open: every investigation is marked benign, contained or resolved.</li>}
        </ul>
      </Section>
      {decisions.length > 0 && (
        <Section title="Recent decisions">
          <ol className="space-y-1 text-[12.5px] text-s-ink-2">
            {decisions.slice(0, 12).map((d) => (
              <li key={d.id}>
                <span className="text-s-ink-3">{fmtTime(d.created_at)}</span> · {describeDecision(d.detail)}
              </li>
            ))}
          </ol>
        </Section>
      )}
    </div>
  );
}

function describeDecision(d: Record<string, unknown>): string {
  const parts: string[] = [`${d.investigation ?? "Investigation"}:`];
  const st = d.state as { from: keyof typeof STATE_LABEL; to: keyof typeof STATE_LABEL } | undefined;
  if (st) parts.push(`${STATE_LABEL[st.from] ?? st.from} → ${STATE_LABEL[st.to] ?? st.to}.`);
  const a = d.action as { key: string; status: string } | undefined;
  if (a) parts.push(`action ${a.key} marked ${a.status}.`);
  if (d.note) parts.push(`“${String(d.note).slice(0, 120)}”`);
  return parts.join(" ");
}

function Intelligence({ runs }: { runs: HuntRun[] }) {
  const [intel, setIntel] = useState<IntelResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    jsonFetch<IntelResponse>("/api/security/intel")
      .then((d) => alive && setIntel(d))
      .catch((e: Error) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, []);
  const records = useMemo(() => {
    const m = new Map<string, IndicatorRecord>();
    for (const r of runs) for (const rec of r.stats.intel) if (!m.has(`${rec.type}:${rec.value}`)) m.set(`${rec.type}:${rec.value}`, rec);
    return [...m.values()];
  }, [runs]);
  return (
    <div className="space-y-4">
      <Section
        title="Actively exploited vulnerabilities that touch your stack"
        note="From CISA's Known Exploited Vulnerabilities catalogue. Dependency matches come from your own Code Guardian findings (version-specific); technology matches are leads — your version wasn't checked."
      >
        {err ? (
          <p className="text-[13px] text-s-danger">{err}</p>
        ) : !intel ? (
          <div className="s-skeleton h-24 rounded-xl" />
        ) : (
          <>
            <p className="mb-3 text-[12.5px] text-s-ink-3">
              Source: {intel.source.name}
              {intel.source.version
                ? ` · catalog ${intel.source.version}, released ${intel.source.released}, retrieved ${new Date(intel.source.retrievedAt!).toLocaleString()}, ${intel.source.entries} entries`
                : ""}
              . Your stack: {intel.stack.cves} CVE(s) from dependency findings;{" "}
              {intel.stack.technologies.length ? `technologies ${intel.stack.technologies.slice(0, 12).join(", ")}` : "no technologies known yet (run a Sentinel audit or Code Guardian)"}.
            </p>
            {intel.error && <p className="mb-2 text-[13px] text-s-danger">{intel.error}</p>}
            {intel.advisories.length === 0 ? (
              <p className="text-[13px] text-s-ink-2">No entries in the catalogue match your dependency findings or known technologies.</p>
            ) : (
              <ul className="space-y-3">
                {intel.advisories.map((a) => (
                  <li key={a.cve} className="rounded-xl border border-s-line px-3 py-2.5 text-[13px]">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <a href={a.sourceUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">
                        {a.cve} <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                      {a.title}
                      <span
                        className={cn(
                          "rounded-full border px-2 text-[11px]",
                          a.match.verified ? "border-[color-mix(in_srgb,var(--s-danger)_45%,transparent)] text-s-danger" : "border-s-line-strong text-s-ink-2",
                        )}
                      >
                        {a.match.verified ? "Matches your dependency" : "Lead: version not checked"}
                      </span>
                      {a.ransomware && <span className="rounded-full border border-s-line-strong px-2 text-[11px]">Known ransomware use</span>}
                    </p>
                    <p className="mt-1 text-s-ink-2">{a.description}</p>
                    <p className="mt-1 text-[12px] text-s-ink-3">
                      {a.match.detail} Added {a.dateAdded}; CISA due date {a.dueDate}. Required action: {a.requiredAction}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>
      {records.length ? (
        <IntelRecords records={records} />
      ) : (
        <Section title="Indicator intelligence">
          <p className="text-[13px] text-s-ink-2">No indicators have been enriched yet. Addresses from your hunts are checked against AbuseIPDB when it&apos;s connected.</p>
        </Section>
      )}
    </div>
  );
}

function ResponseCenter({ items, decisions }: { items: { inv: Investigation; run: HuntRun }[]; decisions: Workspace["decisions"] }) {
  const rows = items
    .filter((x) => !CLOSED.has(x.inv.state) || Object.keys(x.inv.actions ?? {}).length)
    .flatMap(({ inv, run }) =>
      (["containment", "credentials", "eradication"] as const).flatMap((sec) =>
        inv.response[sec].map((a, i) => ({ key: `${run.id}-${inv.id}-${sec}-${i}`, inv, run, text: a.text, approval: a.approval, status: inv.actions?.[`${sec}:${i}`] })),
      ),
    );
  return (
    <div className="space-y-4">
      <Section title="Recommended actions" note="Orbis doesn't perform any of these. Open an investigation to record approvals and results; verification means someone checked the action worked.">
        {!rows.length ? (
          <p className="text-[13px] text-s-ink-2">No recommended actions for open investigations.</p>
        ) : (
          <ul className="divide-y divide-s-line">
            {rows.slice(0, 60).map((r) => (
              <li key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px]">
                <span className="min-w-0 flex-1">
                  {r.text}
                  {r.approval && <span className="ml-1.5 rounded-full border border-amber-500/40 px-1.5 text-[10.5px] text-amber-700 dark:text-amber-300">needs approval</span>}
                </span>
                <span className="text-[12px] text-s-ink-3">{r.status ? `${r.status.status} ${fmtTime(r.status.at)}` : "not done"}</span>
                <Link href={`/agents/security/runs/${r.run.id}#${r.inv.id}`} className="text-[12px] underline underline-offset-2">
                  {r.inv.title.slice(0, 40)}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Action history">
        {!decisions.length ? (
          <p className="text-[13px] text-s-ink-2">No decisions recorded yet.</p>
        ) : (
          <ol className="space-y-1 text-[12.5px] text-s-ink-2">
            {decisions.map((d) => (
              <li key={d.id}>
                <span className="text-s-ink-3">{fmtTime(d.created_at)}</span> · {describeDecision(d.detail)}
              </li>
            ))}
          </ol>
        )}
      </Section>
    </div>
  );
}

function CoverageTab({ runs, items }: { runs: HuntRun[]; items: { inv: Investigation; run: HuntRun }[] }) {
  const latest = runs.find((r) => r.stats.inventory.length);
  const blocked = [...new Set(items.filter((x) => !CLOSED.has(x.inv.state)).flatMap((x) => x.inv.blocked))];
  return (
    <div className="space-y-4">
      {latest ? (
        <>
          <p className="text-[12.5px] text-s-ink-3">
            Most recent hunt: {latest.asset} · {fmtTime(latest.started_at)}
          </p>
          <SourceCoverage inventory={latest.stats.inventory} baselines={latest.stats.baselines} />
        </>
      ) : (
        <Section title="Coverage and blind spots">
          <p className="text-[13px] text-s-ink-2">No logs analysed yet.</p>
          <ul className="mt-3 space-y-1 text-[12.5px] text-s-ink-2">
            {NOT_CONNECTED.map((n) => (
              <li key={n.source}>
                <span className="font-medium text-s-ink">{n.source}:</span> not connected. {n.blocks}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {blocked.length > 0 && (
        <Section title="Investigations blocked by missing evidence">
          <ul className="list-disc space-y-1 pl-5 text-[13px] text-s-ink-2">
            {blocked.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

/* --------------------------------------------------------- detection lab */

function DetectionLab() {
  const [validation, setValidation] = useState<ValidationSummary | null>(null);
  const tests = useMemo(() => new Map(HUNT_RULES.map((r) => [r.id, runRuleTests(r)])), []);
  const total = [...tests.values()].flat();
  return (
    <div className="space-y-4">
      <LocalHunt />
      <Section
        title="Validation (synthetic scenarios)"
        note="Synthetic logs for controlled attack and benign situations, using documentation-only addresses. These measure the detections; they aren't your data."
      >
        {!validation ? (
          <button
            type="button"
            onClick={() => setValidation(validate())}
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-s-line-strong px-3.5 text-[13px] font-medium hover:bg-s-hover"
          >
            <FlaskConical className="h-4 w-4" aria-hidden /> Run the scenarios in this browser
          </button>
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Expected detections found" value={`${validation.foundDetections} / ${validation.expectedDetections}`} />
              <Stat label="Scenarios passing" value={`${validation.scenarios.filter((s) => s.passed).length} / ${validation.scenarios.length}`} />
              <Stat label="Benign scenarios with medium+ alerts" value={`${validation.benignWithAlerts} / ${validation.benignScenarios}`} />
              <Stat label="Benign scenarios escalated" value={`${validation.benignEscalated} / ${validation.benignScenarios}`} />
            </dl>
            <ul className="mt-3 divide-y divide-s-line">
              {validation.scenarios.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px]">
                  {s.passed ? <CircleCheck className="h-4 w-4 text-emerald-500" aria-label="passed" /> : <CircleX className="h-4 w-4 text-s-danger" aria-label="failed" />}
                  <span className="min-w-0 flex-1">
                    {s.name} <span className="text-[12px] text-s-ink-3">({s.kind})</span>
                  </span>
                  <span className="text-[12px] text-s-ink-3">
                    {s.topState ? STATE_LABEL[s.topState] : "no investigation"}
                    {s.missed.length ? ` · missed ${s.missed.join(", ")}` : ""}
                    {s.noisy.length ? ` · noisy ${s.noisy.join(", ")}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>
      <Section
        title={`Detection library (${HUNT_RULES.length} rules · ${total.filter((t) => t.passed).length}/${total.length} built-in tests passing)`}
        note="Queries are for you to run in your own SIEM or on your servers; Orbis isn't connected to them. Field names depend on your add-ons and connectors."
      >
        <ul className="space-y-2.5">
          {HUNT_RULES.map((r) => (
            <RuleCard key={r.id} rule={r} results={tests.get(r.id) ?? []} />
          ))}
        </ul>
      </Section>
    </div>
  );
}

function RuleCard({ rule, results }: { rule: HuntRule; results: ReturnType<typeof runRuleTests> }) {
  const { notify } = useStudio();
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<"splunk" | "sentinel" | "shell">("splunk");
  const passed = results.filter((r) => r.passed).length;
  return (
    <li className="s-card rounded-2xl">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left text-[13.5px]">
        <span className="min-w-0 flex-1 font-medium">{rule.title}</span>
        <span className="text-[12px] text-s-ink-3">
          {rule.tactic} · v{rule.version} · {results.length ? `${passed}/${results.length} tests pass` : "no built-in tests (needs history or volume)"}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-s-line px-4 pb-4 pt-3 text-[13px]">
          <p>
            <span className="font-medium">Hypothesis:</span> {rule.hypothesis}
          </p>
          <p>
            <span className="font-medium">ATT&amp;CK:</span>{" "}
            {rule.techniques.length
              ? rule.techniques.map((t) => (
                  <a key={t.id} href={techniqueUrl(t.id)} target="_blank" rel="noopener noreferrer" className="mr-2 underline underline-offset-2">
                    {t.id} {t.name}
                  </a>
                ))
              : "none mapped (the logs can't show which technique)"}
          </p>
          <p>
            <span className="font-medium">Needs:</span> {rule.requires.sources.join(", ")} · fields: {rule.requires.fields.join(", ")}
          </p>
          <p>
            <span className="font-medium">Logic:</span> {rule.logic}
          </p>
          <p>
            <span className="font-medium">Severity and confidence:</span> {rule.severityRule}
          </p>
          <p>
            <span className="font-medium">Benign explanations:</span> {rule.benign.join("; ")}
          </p>
          <p>
            <span className="font-medium">Tuning:</span> {rule.tuning.join(" ")} <span className="font-medium">Limitations:</span> {rule.limitations.join(" ")}
          </p>
          <div>
            <Segmented
              label="Query language"
              value={lang}
              onChange={setLang}
              options={[
                { value: "splunk", label: "Splunk SPL" },
                { value: "sentinel", label: "Microsoft Sentinel KQL" },
                { value: "shell", label: "Command line" },
              ]}
            />
            <div className="relative mt-2">
              <pre tabIndex={0} aria-label={`${rule.title} query`} className="s-scroll overflow-x-auto rounded-xl border border-s-line bg-s-hover/60 px-3 py-2 text-[12px]">
                <code>{rule.queries[lang]}</code>
              </pre>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(rule.queries[lang]);
                  notify("Query copied");
                }}
                className="absolute right-2 top-2 inline-flex h-7 items-center gap-1 rounded-lg border border-s-line bg-s-bg px-2 text-[11.5px]"
              >
                <Copy className="h-3 w-3" aria-hidden /> Copy
              </button>
            </div>
            <p className="mt-1 text-[12px] text-s-ink-3">{rule.queries.notes} Validate on a short time range first and compare with the built-in test cases.</p>
          </div>
          {results.length > 0 && (
            <ul className="space-y-0.5 text-[12.5px]">
              {results.map((t) => (
                <li key={t.name} className="flex items-center gap-1.5">
                  {t.passed ? <CircleCheck className="h-3.5 w-3.5 text-emerald-500" aria-label="pass" /> : <CircleX className="h-3.5 w-3.5 text-s-danger" aria-label="fail" />} {t.name} — expects{" "}
                  {t.expect === "match" ? "a match" : "no match"}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[12px] text-s-ink-3">Changes: {rule.changelog.join(" ")}</p>
        </div>
      )}
    </li>
  );
}

/** Hunt a log file entirely in the browser: nothing is uploaded or saved. */
function LocalHunt() {
  const ref = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<{ name: string; content: string }[]>([]);
  const [query, setQuery] = useState("");
  const analysis: Analysis | null = useMemo(() => (files.length ? analyseLogs(files, "local") : null), [files]);
  const matches = useMemo(() => (analysis ? filterEvents(analysis.parsed.events, query).slice(0, 200) : []), [analysis, query]);
  return (
    <Section
      title="Hunt a log file in this browser"
      note="The file is read and analysed on this device only — nothing is uploaded or saved. Run Threat Hunter from the Security Team to save investigations."
    >
      <input
        ref={ref}
        type="file"
        multiple
        aria-label="Choose log files to hunt locally"
        accept=".log,.txt,.json,.jsonl,.ndjson,text/plain,application/json"
        className="sr-only"
        onChange={async (e) => {
          const list = Array.from(e.target.files ?? []).filter((f) => f.size <= 5_000_000);
          setFiles(await Promise.all(list.slice(0, 10).map(async (f) => ({ name: f.name, content: await f.text() }))));
          e.target.value = "";
        }}
      />
      <button type="button" onClick={() => ref.current?.click()} className="inline-flex h-9 items-center gap-2 rounded-xl border border-s-line-strong px-3.5 text-[13px] font-medium hover:bg-s-hover">
        <FileUp className="h-4 w-4" aria-hidden /> Choose log files
      </button>
      {analysis && (
        <div className="mt-3 space-y-3">
          <p className="text-[13px]">
            {analysis.parsed.events.length} events from {files.length} file(s); {analysis.findings.length} signal(s) in {analysis.investigations.length} investigation(s):
          </p>
          <ul className="space-y-1 text-[13px]">
            {analysis.investigations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2">
                <StateBadge state={i.state} /> {i.title}{" "}
                <span className="text-[12px] text-s-ink-3">
                  ({i.signals.length} signal(s), {i.severity})
                </span>
              </li>
            ))}
          </ul>
          <label className="block text-[12.5px]">
            <span className="mb-1 block text-s-ink-3">Query the events — e.g. user:alice category:auth outcome:failure, or any text</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ip:203.0.113.7 category:privilege"
              className="h-9 w-full rounded-xl border border-s-line bg-transparent px-3 font-mono text-[12.5px]"
            />
          </label>
          <p className="text-[12px] text-s-ink-3">
            {matches.length} matching event(s)
            {matches.length === 200 ? " (first 200)" : ""}. Fields: user, ip, host, source, category, action, outcome, process, command, path, query.
          </p>
          <ol className="max-h-[320px] space-y-0.5 overflow-y-auto font-mono text-[11.5px]" tabIndex={0} aria-label="Matching events">
            {matches.map((e) => (
              <li key={e.ref}>
                <span className="text-s-ink-3">{e.time?.slice(0, 19) ?? "no time"}</span> {e.ref} · {e.category}/{e.action} · {e.user ?? "-"} · {e.ip ?? "-"}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Section>
  );
}
