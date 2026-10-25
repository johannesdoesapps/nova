"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, CircleAlert, Download, Lock, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader, useStudio } from "@/components/studio/frame";
import { Segmented } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { BastionFinding } from "@/lib/bastion/customer/findings";
import { APP_MODE_INFO, GATE_CRITERIA, type AppMode } from "@/lib/bastion/customer/gate";
import { APPROVABLE_LABEL, APPROVABLE_OPS, CODE_AGENT_REFS, CUSTOM_CAPS, CUSTOMER_CAPABILITIES, type CustomerPolicy } from "@/lib/bastion/customer/policy";
import { ASSIGNABLE_ROLES, ROLE_LABEL, ROLE_NOTE, type WorkspaceRole } from "@/lib/bastion/customer/roles";
import { FEATURES, TIER_LABEL, type Feature } from "@/lib/bastion/customer/tiers";
import type { workspaceState } from "@/lib/bastion/customer/workspace";
import { CAPABILITIES } from "@/lib/bastion/policy";
import { Section } from "./audit-views";
import { CoreControls, CoreOverview, CorePolicy, Decisions, type UserView } from "./bastion-workspace";
import { fmtTime, SeverityBadge } from "./bits";

/**
 * Orbis Bastion page. Customer Security for the workspace (overview, findings, agents, applications, workspace,
 * policies, audit log) on top of Bastion Core, which is explained for everyone and controlled by administrators
 * on the Platform tab. Everything shown comes from the workspace's own records; checks that couldn't run say so.
 */

type State = Awaited<ReturnType<typeof workspaceState>>;
type Tab = "overview" | "findings" | "agents" | "applications" | "workspace" | "policies" | "audit" | "core" | "platform";

const btn = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-s-line-strong px-2.5 text-[12.5px] transition hover:bg-s-hover disabled:opacity-50";
const input = "h-9 rounded-xl border border-s-line bg-transparent px-2.5 text-[13.5px] text-s-ink";
const LEVEL = {
  at_risk: { label: "At risk", icon: ShieldAlert, tone: "text-s-danger" },
  needs_attention: { label: "Needs attention", icon: ShieldAlert, tone: "text-amber-700 dark:text-amber-300" },
  insufficient_coverage: { label: "Not enough coverage to judge", icon: ShieldQuestion, tone: "text-s-ink-2" },
  no_known_serious: { label: "No known serious issues", icon: ShieldCheck, tone: "text-emerald-700 dark:text-emerald-300" },
} as const;
const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  acknowledged: "Acknowledged",
  investigating: "Investigating",
  pending_verification: "Waiting for a re-check",
  resolved: "Resolved",
  suppressed: "Suppressed",
};
const VERIFY_LABEL: Record<string, string> = {
  not_verified: "Not re-checked",
  awaiting_recheck: "Fix reported — re-check needed",
  still_present: "Still found by the re-check",
  verified_resolved: "Re-check: no longer found",
};
const KIND_LABEL: Record<string, string> = { verified: "Verified", suspected: "Suspected", informational: "Informational" };
const COV_STYLE: Record<string, string> = {
  assessed: "text-emerald-700 dark:text-emerald-300",
  partial: "text-amber-700 dark:text-amber-300",
  not_assessed: "text-s-ink-2",
  unavailable: "text-s-ink-3",
  not_applicable: "text-s-ink-3",
};
const COV_LABEL: Record<string, string> = {
  assessed: "Assessed",
  partial: "Partly assessed",
  not_assessed: "Not assessed",
  unavailable: "Not available in Orbis",
  not_applicable: "Nothing to assess",
};

export function BastionPage() {
  const { user, integrations } = useApp();
  const { notify } = useStudio();
  const signedOut = integrations.supabase ? !user : true;
  const [tab, setTab] = useState<Tab>("overview");
  const [ws, setWs] = useState<string | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [core, setCore] = useState<UserView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const q = ws ? `?workspace=${ws}` : "";
    const [s, c] = await Promise.all([jsonFetch<State>(`/api/bastion/workspace${q}`), jsonFetch<UserView>("/api/bastion")]);
    setState(s);
    setCore(c);
    setError(null);
  }, [ws]);
  useEffect(() => {
    if (signedOut) return;
    let alive = true;
    Promise.all([jsonFetch<State>(`/api/bastion/workspace${ws ? `?workspace=${ws}` : ""}`), jsonFetch<UserView>("/api/bastion")])
      .then(([s, c]) => {
        if (!alive) return;
        setState(s);
        setCore(c);
        setError(null);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [signedOut, ws]);

  /** Run an action; with `preview`, the server answers with the impact and nothing changes. */
  const act = useCallback(
    async (body: Record<string, unknown>, done?: string) => {
      try {
        const r = await jsonFetch<Record<string, unknown>>("/api/bastion/workspace", { method: "POST", body: JSON.stringify({ ...body, workspace: ws }) });
        if (!r.preview) await load();
        if (done && !r.preview) notify(typeof r.note === "string" ? r.note : done);
        return r;
      } catch (e) {
        notify((e as Error).message);
        return null;
      }
    },
    [load, notify, ws],
  );

  const perms = new Set(state?.workspace.permissions ?? []);
  const feat = (f: Feature) => !!state?.entitlement.features[f];
  const tabs: { value: Tab; label: string }[] = [
    { value: "overview", label: "Overview" },
    { value: "findings", label: "Findings" },
    { value: "agents", label: "Agents" },
    { value: "applications", label: "Applications" },
    { value: "workspace", label: "Workspace" },
    { value: "policies", label: "Policies" },
    ...(perms.has("audit_view") ? [{ value: "audit" as const, label: "Audit log" }] : []),
    { value: "core", label: "How Bastion works" },
    ...(core?.admin ? [{ value: "platform" as const, label: "Platform (admin)" }] : []),
  ];

  return (
    <>
      <StudioHeader>
        <Link href="/agents/security" className="inline-flex items-center gap-1.5 text-[14px] text-s-ink-2 transition hover:text-s-ink">
          <ArrowLeft className="h-4 w-4" aria-hidden /> <span className="max-sm:sr-only">Security</span>
        </Link>
        <span className="text-s-ink-3">/</span>
        <span className="whitespace-nowrap text-[14px] font-medium">Bastion</span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] space-y-5 px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(30px,4.5vw,42px)] leading-[1.05]">Bastion</h1>
            <p className="mt-2 max-w-3xl text-[15px] text-s-ink-2">
              Security for your workspace: what your agents, connected services and projects can do, what Bastion found, and the rules you add. Underneath, Bastion Core checks every agent&apos;s
              actions on Orbis&apos;s servers before they run — on every plan, whatever your settings.
            </p>
          </div>
          {state && (state.workspace.sharedWithMe.length > 0 || state.workspace.shared) && (
            <label className="flex max-w-md flex-col gap-1 text-[12.5px] text-s-ink-3">
              Workspace
              <select value={ws ?? ""} onChange={(e) => setWs(e.target.value || null)} className={input}>
                <option value="">Your workspace</option>
                {state.workspace.sharedWithMe.map((s) => (
                  <option key={s.ownerId} value={s.ownerId}>
                    Shared with you ({ROLE_LABEL[s.role as WorkspaceRole] ?? s.role}) — {s.ownerId.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="max-w-full overflow-x-auto">
            <Segmented label="Bastion sections" value={tab} onChange={setTab} options={tabs} />
          </div>
          {signedOut ? (
            <p className="rounded-[20px] border border-dashed border-s-line-strong px-6 py-8 text-center text-[14px] text-s-ink-2">Sign in to see your workspace&apos;s security.</p>
          ) : error ? (
            <p role="alert" className="flex items-center gap-2 text-[14px] text-s-danger">
              <CircleAlert className="h-4 w-4" /> {error}
            </p>
          ) : !state || !core ? (
            <div className="s-skeleton h-48 rounded-2xl" aria-label="Loading" />
          ) : (
            <>
              {state.workspace.shared && (
                <p className="rounded-[14px] border border-s-line px-4 py-2.5 text-[13px] text-s-ink-2">
                  You&apos;re viewing someone else&apos;s workspace as <strong>{state.workspace.roleLabel}</strong>. {ROLE_NOTE[state.workspace.role]}
                </p>
              )}
              {tab === "overview" ? (
                <Overview s={state} canRun={perms.has("assess") && feat("workspace_checks")} run={() => act({ kind: "run_checks" }, "Checks finished.")} go={setTab} />
              ) : tab === "findings" ? (
                <Findings s={state} act={act} perms={perms} feat={feat} />
              ) : tab === "agents" ? (
                <Agents s={state} act={act} perms={perms} feat={feat} />
              ) : tab === "applications" ? (
                <Applications s={state} act={act} perms={perms} feat={feat} />
              ) : tab === "workspace" ? (
                <Workspace s={state} act={act} perms={perms} feat={feat} />
              ) : tab === "policies" ? (
                <Policies key={state.policy?.current.version ?? -1} s={state} act={act} perms={perms} feat={feat} />
              ) : tab === "audit" ? (
                <Audit ws={ws} canExport={feat("export")} />
              ) : tab === "core" ? (
                <div className="space-y-4">
                  <CoreOverview d={core} />
                  <CorePolicy d={core} />
                  <Section title="Bastion's decisions on your actions">
                    <Decisions summary={core.summary} empty="Bastion hasn't refused or asked approval for anything you or your agents did." />
                  </Section>
                </div>
              ) : (
                <CoreControls onSaved={() => void load()} />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

type Act = (body: Record<string, unknown>, done?: string) => Promise<Record<string, unknown> | null>;
interface P {
  s: State;
  act: Act;
  perms: Set<string>;
  feat: (f: Feature) => boolean;
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-s-line px-3 py-2.5">
      <dt className="text-[12px] text-s-ink-3">{label}</dt>
      <dd className="mt-0.5 text-[20px] font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="text-[11.5px] text-s-ink-3">{hint}</dd>}
    </div>
  );
}

function Locked({ f, children }: { f: Feature; children?: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-[14px] border border-dashed border-s-line-strong px-4 py-3 text-[13px] text-s-ink-2">
      <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        {FEATURES[f].label} is part of Bastion {TIER_LABEL[FEATURES[f].tier]}.{" "}
        <Link href="/usage" className="underline underline-offset-2">
          See plans
        </Link>
        . {children}
      </span>
    </p>
  );
}

/** A two-step action: preview what it will do, then confirm. */
function useConfirm(act: Act) {
  const [pending, setPending] = useState<{ body: Record<string, unknown>; impact: string[]; summary: string } | null>(null);
  const preview = async (body: Record<string, unknown>) => {
    const r = await act({ ...body, confirm: false });
    if (r?.preview) setPending({ body, impact: (r.impact as string[]) ?? [], summary: String(r.summary ?? "") });
  };
  const confirm = async (done: string) => {
    if (!pending) return;
    const r = await act({ ...pending.body, confirm: true }, done);
    if (r) setPending(null);
  };
  const panel = pending && (
    <div className="mt-3 rounded-xl border border-s-line-strong p-3 text-[13px]" role="dialog" aria-label="Confirm change">
      <p className="font-medium">This will change what agents may do:</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-s-ink-2">
        {(pending.impact.length ? pending.impact : [pending.summary || "No change."]).map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-s-ink-3">It takes effect within seconds and is recorded in the audit log. You can undo it the same way.</p>
      <div className="mt-2 flex gap-2">
        <button type="button" className={btn} onClick={() => void confirm("Saved.")}>
          Confirm
        </button>
        <button type="button" className={btn} onClick={() => setPending(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
  return { preview, panel };
}

/* ---------------------------------------------------------------- overview */

function Overview({ s, canRun, run, go }: { s: State; canRun: boolean; run: () => Promise<unknown>; go: (t: Tab) => void }) {
  const [busy, setBusy] = useState(false);
  const L = LEVEL[s.posture.level];
  const open = s.findings.filter((f) => f.status !== "resolved" && f.status !== "suppressed");
  const attention = s.integrations.filter((c) => c.status !== "connected" || c.writeEnabled);
  return (
    <div className="space-y-4">
      <section className={`glass rounded-[20px] p-5`} aria-labelledby="posture">
        <div className="flex flex-wrap items-start gap-3">
          <L.icon className={`mt-1 h-6 w-6 shrink-0 ${L.tone}`} aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id="posture" className={`text-[18px] font-semibold ${L.tone}`}>
              {L.label}
            </h2>
            <p className="text-[14px] text-s-ink-2">{s.posture.headline}</p>
            <p className="mt-1 text-[12.5px] text-s-ink-3">
              {s.lastAssessment
                ? `Workspace checks last recorded ${fmtTime(s.lastAssessment)}; the counts below are from checks run just now.`
                : "Workspace checks haven't been recorded yet; the counts below are from checks run just now."}
            </p>
          </div>
          {canRun && (
            <button
              type="button"
              className={btn}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await run();
                setBusy(false);
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> {busy ? "Checking…" : "Run and record checks"}
            </button>
          )}
        </div>
        <details className="mt-3 text-[12.5px]">
          <summary className="cursor-pointer text-s-ink-3">How this is decided</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-s-ink-2">
            {s.posture.rules.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </details>
      </section>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Critical" value={s.posture.counts.critical} />
        <Stat label="High" value={s.posture.counts.high} />
        <Stat label="Medium" value={s.posture.counts.medium} />
        <Stat label="Low" value={s.posture.counts.low} hint={s.hiddenByTier ? `${s.hiddenByTier} lower-severity hidden on Basic` : undefined} />
      </dl>
      <div className="grid gap-4 md:grid-cols-2">
        <Section title={`Alerts · ${s.alerts.length}`} note="Detections to review — none of these is a confirmed incident.">
          {s.alerts.length ? (
            <ul className="space-y-1.5 text-[13px]">
              {s.alerts.map((a, i) => (
                <li key={i} className="flex gap-2">
                  <span className="w-24 shrink-0 text-s-ink-3">{fmtTime(a.at)}</span>
                  <span className="min-w-0">
                    {a.href ? (
                      <Link href={a.href} className="hover:underline">
                        {a.text}
                      </Link>
                    ) : (
                      a.text
                    )}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13.5px] text-s-ink-2">No active alerts.</p>
          )}
        </Section>
        <Section title="Monitoring and enforcement health">
          <ul className="space-y-1.5 text-[13px]">
            {s.health.map((h) => (
              <li key={h.id} className="flex gap-2">
                <span className={`w-14 shrink-0 font-medium ${h.ok ? "text-emerald-700 dark:text-emerald-300" : "text-s-danger"}`}>{h.ok ? "OK" : "Issue"}</span>
                <span className="min-w-0">
                  <span className="font-medium">{h.label}</span> <span className="text-s-ink-2">— {h.note}</span>
                </span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="To work on">
          {open.length ? (
            <ul className="space-y-1.5 text-[13px]">
              {open.slice(0, 6).map((f) => (
                <li key={f.id} className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={f.severity} />
                  <span className="min-w-0 flex-1">{f.title}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13.5px] text-s-ink-2">Nothing open.</p>
          )}
          <button type="button" className={`${btn} mt-3`} onClick={() => go("findings")}>
            All findings
          </button>
        </Section>
        <Section title="What Bastion covers">
          <ul className="space-y-1.5 text-[13px]">
            {s.coverage.map((c) => (
              <li key={c.id}>
                <span className="font-medium">{c.label}</span> <span className={COV_STYLE[c.state]}>· {COV_LABEL[c.state]}</span>
                <span className="block text-[12.5px] text-s-ink-3">{c.note}</span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="Covered by Bastion">
          <ul className="space-y-1 text-[13px] text-s-ink-2">
            <li>{s.inventory.length} agents (Orbis agents available to you and your custom agents)</li>
            <li>
              {s.applications.filter((a) => a.kind === "project").length} Orbis Code projects, {s.applications.filter((a) => a.kind === "website").length} verified websites,{" "}
              {s.applications.filter((a) => a.kind === "repository").length} audited repositories
            </li>
            <li>
              {s.integrations.length} connected services{attention.length ? `, ${attention.length} with write access or needing attention` : ""}
            </li>
          </ul>
        </Section>
        <Section title="Recent enforcement">
          {s.recentEvents.length ? (
            <ul className="space-y-1 text-[13px]">
              {s.recentEvents.slice(0, 8).map((e, i) => (
                <li key={i} className="flex gap-2">
                  <span className="w-24 shrink-0 text-s-ink-3">{fmtTime(e.at)}</span>
                  <span>
                    {e.outcome === "deny" ? "Refused" : e.outcome === "needs_approval" ? "Asked approval" : "Allowed (approved)"}: {e.op} — {e.agent.replace("_", " ") || "you"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13.5px] text-s-ink-2">No refusals or approvals in the last 30 days.</p>
          )}
        </Section>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- findings */

function Findings({ s, act, perms, feat }: P) {
  const [q, setQ] = useState("");
  const [sev, setSev] = useState("");
  const [status, setStatus] = useState("active");
  const [source, setSource] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const list = useMemo(
    () =>
      s.findings.filter(
        (f) =>
          (!q || `${f.title} ${f.assetLabel} ${f.id}`.toLowerCase().includes(q.toLowerCase())) &&
          (!sev || f.severity === sev) &&
          (!source || f.source === source) &&
          (status === "all" || (status === "active" ? f.status !== "resolved" && f.status !== "suppressed" : f.status === status)),
      ),
    [s.findings, q, sev, status, source],
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search findings" aria-label="Search findings" className={`${input} min-w-[180px] flex-1`} />
        <select value={sev} onChange={(e) => setSev(e.target.value)} className={input} aria-label="Severity">
          <option value="">All severities</option>
          {["critical", "high", "medium", "low", "info"].map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={input} aria-label="Status">
          <option value="active">Open and in progress</option>
          <option value="all">All</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} className={input} aria-label="Found by">
          <option value="">All sources</option>
          {[...new Set(s.findings.map((f) => f.source))].map((x) => (
            <option key={x} value={x}>
              {x.replace("_", " ")}
            </option>
          ))}
        </select>
      </div>
      {s.hiddenByTier > 0 && <Locked f="all_findings">{s.hiddenByTier} medium, low and informational findings aren&apos;t shown.</Locked>}
      {!list.length ? (
        <p className="rounded-[20px] border border-dashed border-s-line-strong px-6 py-8 text-center text-[14px] text-s-ink-2">
          No findings match. That only covers what Bastion can see — see the coverage on the Overview.
        </p>
      ) : (
        <ul className="glass divide-y divide-s-line rounded-[20px]">
          {list.map((f) => (
            <li key={f.id} className="px-4 py-3">
              <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen(open === f.id ? null : f.id)} aria-expanded={open === f.id}>
                <SeverityBadge severity={f.severity} />
                <span className="min-w-0 flex-1 basis-[220px] text-[13.5px] font-medium">{f.title}</span>
                <span className="text-[12px] text-s-ink-3">{KIND_LABEL[f.kind]}</span>
                <span className="rounded-full border border-s-line px-2 py-0.5 text-[11.5px]">{STATUS_LABEL[f.status]}</span>
              </button>
              <p className="mt-0.5 text-[12px] text-s-ink-3">
                {f.id.length > 12 ? f.id.slice(0, 8) : f.id} · {f.assetLabel || f.asset} · {f.source.replace("_", " ")} · {VERIFY_LABEL[f.verification]}
              </p>
              {open === f.id && <FindingDetail f={f} act={act} perms={perms} feat={feat} s={s} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FindingDetail({ f, act, perms, feat, s }: { f: BastionFinding } & P) {
  const [owner, setOwner] = useState(f.owner ?? "");
  const [note, setNote] = useState("");
  const [until, setUntil] = useState("");
  const triage = perms.has("findings_triage");
  const manage = perms.has("findings_manage") && feat("finding_workflow");
  const project = f.asset.startsWith("orbis:") ? f.asset.slice(6) : null;
  const doIt = (action: string, extra: Record<string, unknown> = {}) => act({ kind: "finding", findingId: f.id, action, ...extra }, "Recorded.");
  return (
    <div className="mt-3 space-y-3 text-[13px]">
      {f.description && <p className="text-s-ink-2">{f.description}</p>}
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[160px_1fr]">
        <dt className="text-s-ink-3">Finding id</dt>
        <dd className="font-mono text-[12px]">{f.id}</dd>
        <dt className="text-s-ink-3">Severity / confidence</dt>
        <dd>
          {f.severity} · {f.confidence} ({KIND_LABEL[f.kind].toLowerCase()})
        </dd>
        <dt className="text-s-ink-3">Affected</dt>
        <dd>{f.assetLabel || f.asset}</dd>
        <dt className="text-s-ink-3">How it was found</dt>
        <dd>
          {f.method} · first {fmtTime(f.detectedAt)}, last {fmtTime(f.lastSeen)}
        </dd>
        {f.evidence.length > 0 && (
          <>
            <dt className="text-s-ink-3">Evidence</dt>
            <dd>
              <ul className="list-disc pl-4">
                {f.evidence.map((e, i) => (
                  <li key={i} className="break-words">
                    {e}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {f.impact && (
          <>
            <dt className="text-s-ink-3">Impact</dt>
            <dd>{f.impact}</dd>
          </>
        )}
        <dt className="text-s-ink-3">What to do</dt>
        <dd>{f.remediation}</dd>
        <dt className="text-s-ink-3">Verification</dt>
        <dd>
          {VERIFY_LABEL[f.verification]}
          {f.verificationNote ? ` — ${f.verificationNote}` : ""}
        </dd>
        {f.owner && (
          <>
            <dt className="text-s-ink-3">Owner</dt>
            <dd>{f.owner}</dd>
          </>
        )}
      </dl>
      {f.history.length > 0 && (
        <ol className="space-y-0.5 text-[12.5px] text-s-ink-2">
          {f.history.map((h, i) => (
            <li key={i}>
              {fmtTime(h.at)} — {h.action.replace("_", " ")}
              {h.note ? `: ${h.note}` : ""}
            </li>
          ))}
        </ol>
      )}
      {f.status !== "resolved" && (
        <div className="flex flex-wrap gap-2">
          {triage && f.status === "open" && (
            <button type="button" className={btn} onClick={() => void doIt("acknowledge")}>
              Acknowledge
            </button>
          )}
          {triage && feat("finding_workflow") && f.status !== "investigating" && (
            <button type="button" className={btn} onClick={() => void doIt("investigate")}>
              Investigating
            </button>
          )}
          {triage && f.status !== "pending_verification" && (
            <button type="button" className={btn} onClick={() => void doIt("resolve_requested", note ? { note } : {})}>
              I&apos;ve fixed it — re-check needed
            </button>
          )}
          {f.source === "bastion" && perms.has("assess") && (
            <button type="button" className={btn} onClick={() => void act({ kind: "run_checks" }, "Re-checked.")}>
              Re-check now
            </button>
          )}
          {project && perms.has("assess") && feat("recheck") && (
            <button type="button" className={btn} onClick={() => void act({ kind: "assess_app", projectId: project, mode: "recheck", findingIds: [f.id] }, "Rechecked.")}>
              Targeted recheck
            </button>
          )}
          {f.href && (
            <Link href={f.href} className={btn}>
              Open
            </Link>
          )}
        </div>
      )}
      {manage && f.status !== "resolved" && (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-s-line p-3">
          <label className="flex min-w-[160px] flex-col gap-1 text-[12px] text-s-ink-3">
            Owner
            <input value={owner} onChange={(e) => setOwner(e.target.value)} maxLength={120} className={input} />
          </label>
          <button type="button" className={btn} onClick={() => void doIt("assign", { owner: owner || null })}>
            Assign
          </button>
          <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-[12px] text-s-ink-3">
            Note or reason
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className={input} />
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-s-ink-3">
            Suppress until
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className={input} />
          </label>
          {f.status === "suppressed" ? (
            <button type="button" className={btn} onClick={() => void doIt("unsuppress")}>
              Unsuppress
            </button>
          ) : (
            <button type="button" className={btn} disabled={note.length < 10} onClick={() => void doIt("suppress", { note, ...(until ? { until } : {}) })}>
              Suppress
            </button>
          )}
        </div>
      )}
      {!feat("finding_workflow") && triage && <Locked f="finding_workflow" />}
      {s.workspace.shared && !triage && <p className="text-[12px] text-s-ink-3">Your role can&apos;t change findings in this workspace.</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ agents */

function Agents({ s, act, perms, feat }: P) {
  const { preview, panel } = useConfirm(act);
  const [limitFor, setLimitFor] = useState<string | null>(null);
  const manage = perms.has("agents_manage");
  return (
    <div className="space-y-4">
      {panel}
      <Section title={`Agents · ${s.inventory.length}`} note="Orbis's own internal agents and operator tools aren't listed: they don't act in your workspace.">
        <ul className="divide-y divide-s-line">
          {s.inventory.map((a) => (
            <li key={a.ref} className="py-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 basis-[200px] text-[14px] font-medium">{a.name}</span>
                <span className="text-[12px] text-s-ink-3">{a.kind === "custom" ? "Your agent" : "Orbis agent"}</span>
                <span className={`rounded-full border border-s-line px-2 py-0.5 text-[11.5px] ${a.compliance === "attention" ? "text-amber-700 dark:text-amber-300" : ""}`}>
                  {a.paused ? `Paused by ${a.paused.by === "workspace" ? "your policy" : "an administrator"}` : a.compliance === "attention" ? "Needs attention" : "Within policy"}
                </span>
              </div>
              <p className="text-s-ink-2">{a.purpose}</p>
              <dl className="mt-1 grid gap-x-4 gap-y-0.5 text-[12.5px] sm:grid-cols-[150px_1fr]">
                <dt className="text-s-ink-3">Tools</dt>
                <dd>{a.tools.length ? a.tools.join("; ") : "None"}</dd>
                <dt className="text-s-ink-3">Data it can reach</dt>
                <dd>{a.dataSources.length ? a.dataSources.join("; ") : "—"}</dd>
                {a.execution.length > 0 && (
                  <>
                    <dt className="text-s-ink-3">Can execute</dt>
                    <dd>{a.execution.join("; ")}</dd>
                  </>
                )}
                {a.approvals.length > 0 && (
                  <>
                    <dt className="text-s-ink-3">Needs your approval</dt>
                    <dd>{a.approvals.join("; ")}</dd>
                  </>
                )}
                {a.limits.length > 0 && (
                  <>
                    <dt className="text-s-ink-3">Your restrictions</dt>
                    <dd>{a.limits.join("; ")}</dd>
                  </>
                )}
                <dt className="text-s-ink-3">Last 7 days</dt>
                <dd>
                  {a.blocked7d} refused, {a.needsApproval7d} asked approval{a.findings ? `, ${a.findings} open finding(s)` : ""} · last active {a.lastActivity ? fmtTime(a.lastActivity) : "—"}
                </dd>
              </dl>
              {manage && a.paused?.by !== "administrator" && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {feat("pause_agents") && (
                    <button type="button" className={btn} onClick={() => void preview({ kind: "agent", ref: a.ref, action: a.paused ? "resume" : "pause" })}>
                      {a.paused ? "Resume" : "Pause"}
                    </button>
                  )}
                  {a.kind === "custom" && (
                    <button type="button" className={btn} onClick={() => setLimitFor(limitFor === a.ref ? null : a.ref)} aria-expanded={limitFor === a.ref}>
                      Limit tools
                    </button>
                  )}
                </div>
              )}
              {limitFor === a.ref &&
                (feat("policies") ? (
                  <ToolLimits
                    refId={a.ref}
                    current={s.policy?.current.policy.customAgentLimits[a.ref] ?? []}
                    onPreview={(removeTools) => void preview({ kind: "agent", ref: a.ref, action: "limit", removeTools })}
                  />
                ) : (
                  <Locked f="policies" />
                ))}
            </li>
          ))}
        </ul>
      </Section>
      <Section title={`Connected services · ${s.integrations.length}`} note="Revoking deletes Orbis's stored sign-in. Remove Orbis in the service's own settings too to revoke its grant there.">
        {s.integrations.length ? (
          <ul className="divide-y divide-s-line">
            {s.integrations.map((c) => (
              <li key={c.connectorId} className="flex flex-wrap items-center gap-2 py-2.5 text-[13px]">
                <span className="min-w-0 flex-1 basis-[200px]">
                  <span className="font-medium">{c.name}</span>{" "}
                  <span className="text-s-ink-3">
                    — {c.status.replace("_", " ")}, {c.writeEnabled ? "read and write (each action confirmed)" : "read-only"}, last used {c.lastUsedAt ? fmtTime(c.lastUsedAt) : "never"}
                  </span>
                </span>
                {perms.has("integrations_revoke") && (
                  <RevokeButton name={c.name} onConfirm={() => void act({ kind: "revoke_integration", connectorId: c.connectorId, confirm: true }, `${c.name} disconnected.`)} />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13.5px] text-s-ink-2">No connected services.</p>
        )}
      </Section>
    </div>
  );
}

function RevokeButton({ name, onConfirm }: { name: string; onConfirm: () => void }) {
  const [ask, setAsk] = useState(false);
  return ask ? (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-[12.5px] text-s-ink-2">Disconnect {name}? Agents and chats lose access at once; reconnecting needs a new sign-in.</span>
      <button type="button" className={btn} onClick={onConfirm}>
        Disconnect
      </button>
      <button type="button" className={btn} onClick={() => setAsk(false)}>
        Cancel
      </button>
    </span>
  ) : (
    <button type="button" className={btn} onClick={() => setAsk(true)}>
      Revoke
    </button>
  );
}

function ToolLimits({ refId, current, onPreview }: { refId: string; current: string[]; onPreview: (remove: string[]) => void }) {
  const [remove, setRemove] = useState<string[]>(current);
  const LABEL: Record<string, string> = { web_search: "Web search", file_analysis: "Reading attached files", data_analysis: "Data analysis", code_execution: "Running code" };
  return (
    <fieldset className="mt-2 rounded-xl border border-s-line p-3 text-[13px]">
      <legend className="px-1 text-[12px] text-s-ink-3">Remove tools from this agent</legend>
      {CUSTOM_CAPS.map((c) => (
        <label key={c} className="mr-4 inline-flex items-center gap-1.5">
          <input type="checkbox" checked={remove.includes(c)} onChange={(e) => setRemove(e.target.checked ? [...remove, c] : remove.filter((x) => x !== c))} /> {LABEL[c]}
        </label>
      ))}
      <button type="button" className={`${btn} mt-2`} onClick={() => onPreview(remove)} data-ref={refId}>
        Preview change
      </button>
    </fieldset>
  );
}

/* ------------------------------------------------------------ applications */

function Applications({ s, act, perms, feat }: P) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, Record<string, unknown>>>({});
  const run = async (id: string, mode: AppMode) => {
    setBusy(`${id}:${mode}`);
    const r = await act({ kind: "assess_app", projectId: id, mode }, `${APP_MODE_INFO[mode].label} finished.`);
    if (r) setResult((x) => ({ ...x, [id]: r }));
    setBusy(null);
  };
  const featOf: Record<AppMode, Feature> = { quick: "quick_check", deep: "deep_assessment", gate: "deploy_gate", recheck: "recheck" };
  return (
    <div className="space-y-4">
      <Section
        title="What the checks are"
        note="None of these runs your application. Runtime findings come only from Sentinel scans of a verified live site, or logs you give Threat Hunter, and are labelled that way."
      >
        <ul className="space-y-1 text-[13px]">
          {(Object.keys(APP_MODE_INFO) as AppMode[]).map((m) => (
            <li key={m}>
              <span className="font-medium">{APP_MODE_INFO[m].label}</span> <span className="text-s-ink-2">— {APP_MODE_INFO[m].does}</span>
              {!feat(featOf[m]) && <span className="text-s-ink-3"> (Bastion {TIER_LABEL[FEATURES[featOf[m]].tier]})</span>}
            </li>
          ))}
        </ul>
        <details className="mt-2 text-[12.5px]">
          <summary className="cursor-pointer text-s-ink-3">Gate criteria</summary>
          <ul className="mt-1 list-disc pl-5 text-s-ink-2">
            {GATE_CRITERIA.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </details>
      </Section>
      {!s.applications.length ? (
        <p className="rounded-[20px] border border-dashed border-s-line-strong px-6 py-8 text-center text-[14px] text-s-ink-2">
          No applications yet. Build one in{" "}
          <Link href="/code" className="underline underline-offset-2">
            Orbis Code
          </Link>
          , or verify a website on the{" "}
          <Link href="/agents/security" className="underline underline-offset-2">
            Security Team
          </Link>{" "}
          page.
        </p>
      ) : (
        <ul className="glass divide-y divide-s-line rounded-[20px]">
          {s.applications.map((a) => {
            const r = result[a.id];
            const gate = (r?.gate as { passed: boolean; reasons: string[] } | null | undefined) ?? a.gate;
            return (
              <li key={a.asset} className="px-4 py-3 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 basis-[200px] text-[14px] font-medium">{a.name}</span>
                  <span className="text-[12px] text-s-ink-3">
                    {a.kind === "project" ? "Orbis Code project" : a.kind === "website" ? "Verified website (runtime scans by Sentinel)" : "GitHub repository (Code Guardian)"}
                  </span>
                </div>
                <p className="text-[12.5px] text-s-ink-3">
                  {a.lastAssessed ? `Last assessed ${fmtTime(a.lastAssessed)}${a.lastMode ? ` (${a.lastMode})` : ""}` : "Never assessed"} · {a.open} open finding(s)
                  {a.runId ? (
                    <>
                      {" · "}
                      <Link href={`/agents/security/runs/${a.runId}`} className="underline underline-offset-2">
                        last run
                      </Link>
                    </>
                  ) : null}
                </p>
                {gate && (
                  <p className={`mt-1 text-[13px] ${gate.passed ? "text-emerald-700 dark:text-emerald-300" : "text-s-danger"}`}>
                    Pre-deployment gate {gate.passed ? "passed" : "failed"} (static checks only){!gate.passed && gate.reasons?.length ? `: ${gate.reasons.slice(0, 3).join("; ")}` : ""}
                  </p>
                )}
                {r && <p className="mt-1 text-[12.5px] text-s-ink-2">{String(r.summary ?? "")}</p>}
                {a.kind === "project" && perms.has("assess") && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(["quick", "deep", "gate"] as AppMode[]).map((m) => (
                      <button
                        key={m}
                        type="button"
                        className={btn}
                        disabled={!!busy || !feat(featOf[m])}
                        onClick={() => void run(a.id, m)}
                        title={feat(featOf[m]) ? APP_MODE_INFO[m].does : `Bastion ${TIER_LABEL[FEATURES[featOf[m]].tier]}`}
                      >
                        {busy === `${a.id}:${m}` ? "Running…" : APP_MODE_INFO[m].label}
                      </button>
                    ))}
                  </div>
                )}
                {a.kind !== "project" && (
                  <Link href="/agents/security" className={`${btn} mt-2`}>
                    {a.kind === "website" ? "Scan with Sentinel" : "Audit with Code Guardian"}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- workspace */

function Workspace({ s, act, perms, feat }: P) {
  const [note, setNote] = useState("");
  const team = s.team;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Section title="Your access">
          <p className="text-[13.5px]">
            <span className="font-medium">{s.workspace.roleLabel}</span> — {ROLE_NOTE[s.workspace.role]}
          </p>
          <p className="mt-2 text-[12.5px] text-s-ink-3">Platform administrator rights are never a workspace role: Bastion Core is managed by Orbis.</p>
        </Section>
        <Section title={`Plan: Bastion ${s.entitlement.tierLabel}`} note={`History and the audit log go back ${s.entitlement.historyDays} days. Bastion Core's protections apply on every plan.`}>
          <ul className="space-y-0.5 text-[13px]">
            {(Object.keys(FEATURES) as Feature[]).map((f) => (
              <li key={f} className={s.entitlement.features[f] ? "" : "text-s-ink-3"}>
                {s.entitlement.features[f] ? "✓" : "—"} {FEATURES[f].label}
                {!s.entitlement.features[f] ? ` (${TIER_LABEL[FEATURES[f].tier]})` : ""}
              </li>
            ))}
          </ul>
        </Section>
      </div>
      <Section title="Team access" note={team ? undefined : "This account isn't in a team, so nobody else has access to its workspace."}>
        {team ? (
          <>
            <ul className="divide-y divide-s-line text-[13px]">
              {team.members.map((m) => {
                const grant = team.grants?.find((g) => g.userId === m.userId);
                const self = m.userId === s.workspace.id;
                return (
                  <li key={m.userId} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="min-w-0 flex-1 basis-[200px]">
                      {self ? "Workspace owner" : `Member ${m.userId.slice(0, 8)}`}{" "}
                      <span className="text-s-ink-3">
                        — team {m.role}, joined {m.joinedAt.slice(0, 10)}
                      </span>
                    </span>
                    {!self &&
                      (perms.has("roles_manage") && feat("roles") && team.grants !== null ? (
                        <select
                          aria-label={`Role for member ${m.userId.slice(0, 8)}`}
                          value={grant?.role ?? ""}
                          onChange={(e) => void act({ kind: "role", userId: m.userId, role: e.target.value || null, confirm: true }, "Role updated.")}
                          className={input}
                        >
                          <option value="">No access to this workspace</option>
                          {ASSIGNABLE_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABEL[r]}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-[12.5px] text-s-ink-2">{grant ? ROLE_LABEL[grant.role as WorkspaceRole] : "No access"}</span>
                      ))}
                  </li>
                );
              })}
            </ul>
            {team.grants === null && <p className="mt-2 text-[12.5px] text-s-ink-3">Workspace roles aren&apos;t set up on this server yet (a database update is pending).</p>}
            {perms.has("roles_manage") && !feat("roles") && <Locked f="roles" />}
            {perms.has("access_review") && (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[12px] text-s-ink-3">
                  Review note (optional)
                  <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={input} />
                </label>
                <button type="button" className={btn} onClick={() => void act({ kind: "access_review", ...(note ? { note } : {}) }, "Access review recorded.")}>
                  I&apos;ve reviewed this access
                </button>
              </div>
            )}
          </>
        ) : null}
      </Section>
      <div className="grid gap-4 md:grid-cols-2">
        <Section title={`Shared chats · ${s.sharing.length}`} note="Anyone with a share link can read the chat without signing in.">
          {s.sharing.length ? (
            <ul className="space-y-1 text-[13px]">
              {s.sharing.map((c) => (
                <li key={c.id}>
                  “{c.title}” — shared {c.sharedUntil.slice(0, 10)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13.5px] text-s-ink-2">No chats are shared.</p>
          )}
        </Section>
        <Section
          title="Secret handling"
          note="Orbis never shows secret files (.env, keys) to the AI and never pushes them to GitHub. Command output and connected-service results have credentials removed."
        >
          {s.applications.filter((a) => a.kind === "project").length ? (
            <p className="text-[13.5px] text-s-ink-2">Projects storing secret files show up as findings. Keep real credentials in your hosting provider&apos;s environment settings.</p>
          ) : (
            <p className="text-[13.5px] text-s-ink-2">No projects.</p>
          )}
        </Section>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- policies */

function Policies({ s, act, perms, feat }: P) {
  const current = s.policy?.current;
  const [p, setP] = useState<CustomerPolicy | null>(current?.policy ?? null);
  const [note, setNote] = useState("");
  const { preview, panel } = useConfirm(act);
  const restore = useConfirm(act);
  if (!current || !p) return <p className="text-[14px] text-s-danger">The workspace&apos;s policy couldn&apos;t be read, so protected actions are paused (fail closed). Try again in a moment.</p>;
  const editable = perms.has("policies_manage") && feat("policies");
  const toggle = <T extends string>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  const projects = s.applications.filter((a) => a.kind === "project");
  const set = (patch: Partial<CustomerPolicy>) => setP({ ...p, ...patch });
  return (
    <div className="space-y-4">
      <p className="text-[13px] text-s-ink-2">
        Your rules add to Bastion Core&apos;s; they can&apos;t loosen them. Version {current.version}
        {current.at ? `, changed ${fmtTime(current.at)}` : " (defaults)"}. {current.summary && current.version ? `Last change: ${current.summary}.` : ""}
      </p>
      {!feat("policies") && <Locked f="policies">Pausing agents works on every plan (Agents tab).</Locked>}
      {!perms.has("policies_manage") && <p className="text-[13px] text-s-ink-3">Your role can see the policy but not change it.</p>}
      <fieldset disabled={!editable} className="space-y-4">
        <Section title="Extra approvals">
          {APPROVABLE_OPS.map((op) => (
            <label key={op} className="flex items-start gap-2 py-0.5 text-[13.5px]">
              <input type="checkbox" className="mt-1" checked={p.requireApproval.includes(op)} onChange={(e) => set({ requireApproval: toggle(p.requireApproval, op, e.target.checked) })} />
              {APPROVABLE_LABEL[op]}
            </label>
          ))}
        </Section>
        <Section title="Switch off in this workspace">
          {CUSTOMER_CAPABILITIES.map((c) => (
            <label key={c} className="flex items-start gap-2 py-0.5 text-[13.5px]">
              <input type="checkbox" className="mt-1" checked={p.blockedCapabilities.includes(c)} onChange={(e) => set({ blockedCapabilities: toggle(p.blockedCapabilities, c, e.target.checked) })} />
              {CAPABILITIES[c]}
            </label>
          ))}
        </Section>
        <Section title="Coding agents' projects" note="Leave unticked to let the agent work in any of your projects.">
          {projects.length ? (
            CODE_AGENT_REFS.map((ref) => {
              const ids = p.agentProjects[ref];
              return (
                <div key={ref} className="py-1 text-[13.5px]">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!!ids}
                      onChange={(e) =>
                        set({
                          agentProjects: e.target.checked
                            ? { ...p.agentProjects, [ref]: projects.slice(0, 1).map((x) => x.id) }
                            : Object.fromEntries(Object.entries(p.agentProjects).filter(([k]) => k !== ref)),
                        })
                      }
                    />
                    Keep {ref.slice(5).replace("_", " ")} to chosen projects
                  </label>
                  {ids && (
                    <div className="ml-6 mt-1 flex flex-wrap gap-x-4">
                      {projects.map((x) => (
                        <label key={x.id} className="inline-flex items-center gap-1.5 text-[13px]">
                          <input type="checkbox" checked={ids.includes(x.id)} onChange={(e) => set({ agentProjects: { ...p.agentProjects, [ref]: toggle(ids, x.id, e.target.checked) } })} /> {x.name}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            <p className="text-[13.5px] text-s-ink-2">No Orbis Code projects.</p>
          )}
        </Section>
        <Section title="Connected services agents may read">
          <label className="flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" checked={p.allowedIntegrations !== null} onChange={(e) => set({ allowedIntegrations: e.target.checked ? [] : null })} /> Only the services I choose
          </label>
          {p.allowedIntegrations !== null && (
            <div className="ml-6 mt-1 flex flex-wrap gap-x-4">
              {s.integrations.length ? (
                s.integrations.map((c) => (
                  <label key={c.connectorId} className="inline-flex items-center gap-1.5 text-[13px]">
                    <input
                      type="checkbox"
                      checked={p.allowedIntegrations!.includes(c.connectorId)}
                      onChange={(e) => set({ allowedIntegrations: toggle(p.allowedIntegrations!, c.connectorId, e.target.checked) })}
                    />{" "}
                    {c.name}
                  </label>
                ))
              ) : (
                <span className="text-[13px] text-s-ink-3">No connected services.</span>
              )}
            </div>
          )}
        </Section>
        <Section title="Notifications" note="Kept on this page always; emailed when email is on. Each is a detection to review, never a confirmed incident.">
          <label className="flex items-center gap-2 text-[13.5px]">
            <input type="checkbox" checked={p.notifications.email} onChange={(e) => set({ notifications: { ...p.notifications, email: e.target.checked } })} /> Email me
          </label>
          {(
            [
              ["critical", "Critical findings"],
              ["credentialExposure", "Possible credential exposure"],
              ["repeatedBlocks", "An agent stopped after repeated refusals"],
              ["riskyIntegrations", "A service connected with write access"],
              ["enforcementFailures", "Bastion failing closed"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="ml-6 flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={p.notifications[k]} onChange={(e) => set({ notifications: { ...p.notifications, [k]: e.target.checked } })} /> {label}
            </label>
          ))}
          <label className="mt-2 flex items-center gap-2 text-[13px]">
            Flag an agent after
            <input
              type="number"
              min={3}
              max={50}
              value={p.notifications.blockThreshold}
              onChange={(e) => set({ notifications: { ...p.notifications, blockThreshold: Math.max(3, Math.min(50, Number(e.target.value) || 5)) } })}
              className={`${input} w-20`}
            />
            refusals in a week
          </label>
        </Section>
        <Section title="History shown" note="Records aren't deleted; this only sets how far back pages show.">
          {feat("retention") ? (
            <label className="flex items-center gap-2 text-[13px]">
              Days
              <input
                type="number"
                min={7}
                max={3650}
                value={p.retentionDays ?? ""}
                placeholder="Plan default"
                onChange={(e) => set({ retentionDays: e.target.value ? Math.max(7, Math.min(3650, Number(e.target.value))) : null })}
                className={`${input} w-28`}
              />
            </label>
          ) : (
            <Locked f="retention" />
          )}
        </Section>
      </fieldset>
      {editable && (
        <Section title={`Activate version ${current.version + 1}`}>
          <label className="flex flex-col gap-1 text-[12px] text-s-ink-3">
            Why (kept in the history)
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className={input} />
          </label>
          <button type="button" className={`${btn} mt-3`} onClick={() => void preview({ kind: "policy", policy: p, expectedVersion: current.version, ...(note ? { note } : {}) })}>
            Preview change
          </button>
          {panel}
        </Section>
      )}
      {s.policy && s.policy.history.length > 0 && (
        <Section title="Versions">
          <ul className="space-y-1 text-[13px]">
            {s.policy.history.map((h) => (
              <li key={h.version}>
                v{h.version} · {fmtTime(h.at)} · by {h.by === s.workspace.id ? "the owner" : h.by.slice(0, 8)} — {h.summary}
                {h.note ? ` (${h.note})` : ""}
                {editable && h.version !== current.version && (
                  <button
                    type="button"
                    className={`${btn} ml-2`}
                    onClick={() => void restore.preview({ kind: "policy", policy: h.policy, expectedVersion: current.version, note: `Restore version ${h.version}` })}
                  >
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
          {restore.panel}
        </Section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- audit */

interface AuditRow {
  id: number;
  at: string;
  action: string;
  actor: string | null;
  cid: string | null;
  integrity: "signed" | "unsigned" | "invalid";
  detail: Record<string, unknown>;
}

function Audit({ ws, canExport }: { ws: string | null; canExport: boolean }) {
  const [area, setArea] = useState("");
  const [q, setQ] = useState("");
  const [data, setData] = useState<{ days: number; total: number; rows: AuditRow[]; tamperedOrUnsigned: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qs = `?${new URLSearchParams({ ...(ws ? { workspace: ws } : {}), ...(area ? { area } : {}), ...(q ? { q } : {}) }).toString()}`;
  useEffect(() => {
    const t = setTimeout(() => {
      jsonFetch<NonNullable<typeof data>>(`/api/bastion/workspace/audit${qs}`)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e: Error) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [qs]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select value={area} onChange={(e) => setArea(e.target.value)} className={input} aria-label="What">
          <option value="">Everything</option>
          <option value="decisions">Bastion decisions</option>
          <option value="policy">Policy and roles</option>
          <option value="findings">Findings and checks</option>
          <option value="integrations">Connected services</option>
          <option value="access">Access reviews</option>
          <option value="notices">Notifications</option>
          <option value="security">Security agents</option>
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search the audit log" className={`${input} min-w-[160px] flex-1`} />
        {canExport && (
          <a href={`/api/bastion/workspace/audit${qs}${qs.length > 1 ? "&" : ""}format=json`} className={btn} download>
            <Download className="h-3.5 w-3.5" aria-hidden /> Export
          </a>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-[14px] text-s-danger">
          {error}
        </p>
      ) : !data ? (
        <div className="s-skeleton h-32 rounded-2xl" aria-label="Loading" />
      ) : (
        <Section
          title={`${data.total} record${data.total === 1 ? "" : "s"} · last ${data.days} days`}
          note="Append-only: Orbis can't change or delete these records. Signed records were written by Orbis; unsigned ones were added some other way and aren't trusted."
        >
          {data.tamperedOrUnsigned > 0 && (
            <p className="mb-2 text-[13px] text-amber-700 dark:text-amber-300">
              {data.tamperedOrUnsigned} Bastion record(s) aren&apos;t signed by Orbis or don&apos;t match their signature; they&apos;re ignored.
            </p>
          )}
          {data.rows.length ? (
            <ul className="divide-y divide-s-line text-[12.5px]">
              {data.rows.map((r) => (
                <li key={r.id} className="py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-28 shrink-0 text-s-ink-3">{fmtTime(r.at)}</span>
                    <span className="font-mono">{r.action}</span>
                    <span className={r.integrity === "signed" ? "text-emerald-700 dark:text-emerald-300" : r.action.startsWith("bastion.") ? "text-amber-700 dark:text-amber-300" : "text-s-ink-3"}>
                      {r.integrity === "signed" ? "signed" : r.action.startsWith("bastion.") ? (r.integrity === "invalid" ? "signature mismatch" : "unsigned") : "agent record"}
                    </span>
                    {r.cid && <span className="font-mono text-s-ink-3">#{r.cid.slice(0, 8)}</span>}
                  </div>
                  <p className="break-words text-s-ink-2">{describe(r)}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13.5px] text-s-ink-2">No records in this window.</p>
          )}
        </Section>
      )}
    </div>
  );
}

function describe(r: AuditRow): string {
  const d = r.detail;
  const who = r.actor ? `by ${r.actor.slice(0, 8)}` : "";
  switch (r.action) {
    case "bastion.deny":
    case "bastion.needs_approval":
    case "bastion.allow":
      return `${String(d.agent ?? "")} · ${String(d.op ?? "")} · ${String(d.resource ?? "")} — ${String(d.reason ?? "")}`;
    case "bastion.policy":
      return `Policy v${String(d.version)} ${who}: ${String(d.summary ?? "")}`;
    case "bastion.finding":
      return `Finding ${String(d.findingId ?? "")}: ${String(d.action ?? "")} ${who}${d.note ? ` — ${String(d.note)}` : ""}`;
    case "bastion.assessment":
      return d.mode === "workspace"
        ? `Workspace checks ${who}: ${Array.isArray(d.present) ? d.present.length : 0} finding(s)`
        : `${String(d.app ?? "")} assessment of ${String(d.label ?? d.target ?? "")} ${who}`;
    case "bastion.integration":
      return `${String(d.connectorId ?? "")}: ${String(d.action ?? "")} (${String(d.outcome ?? "")}) ${who}`;
    case "bastion.role":
      return `Role for ${String(d.userId ?? "").slice(0, 8)}: ${String(d.role ?? "removed")} ${who}`;
    case "bastion.access_review":
      return `Access reviewed ${who} (${String(d.members ?? 0)} members)`;
    case "bastion.notice":
      return `Notice: ${String(d.subject ?? "")}${d.emailed ? " (emailed)" : ""}`;
    default:
      return Object.entries(d)
        .filter(([k]) => !["sig", "workspace"].includes(k))
        .slice(0, 4)
        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60)}`)
        .join(" · ");
  }
}
