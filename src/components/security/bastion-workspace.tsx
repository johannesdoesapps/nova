"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CircleAlert, Lock, ShieldCheck, ShieldOff } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader, useStudio } from "@/components/studio/frame";
import { Segmented, Switch } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { EnforcementPoint } from "@/lib/bastion/coverage";
import { CAPABILITIES, OPERATIONS, RISKS, type BastionControls, type Capability, type OperationId, type Risk } from "@/lib/bastion/policy";
import { SUSPENDABLE, type BastionSummary, type policyTable } from "@/lib/bastion/view";
import { Section } from "./audit-views";
import { fmtTime } from "./bits";

/**
 * Orbis Bastion: the protections enforced on every agent's actions, where they're enforced (and where they
 * aren't), and the decisions Bastion made. Administrators also get the emergency controls: lockdown, suspending
 * agents, switching capabilities off and raising risk levels — each change is a new version with history.
 */

interface UserView {
  available: boolean;
  controls: { version: number; updatedAt: string; lockdown: boolean; suspendedAgents: string[]; blockedCapabilities: string[] } | null;
  policy: ReturnType<typeof policyTable>;
  enforcement: EnforcementPoint[];
  summary: BastionSummary;
  admin: boolean;
}
interface AdminView {
  controls: BastionControls | null;
  valid: boolean;
  version: number;
  summary: BastionSummary;
  scope: "all_users" | "own";
}

type Tab = "overview" | "policy" | "decisions" | "controls";
const RISK_STYLE: Record<string, string> = { low: "text-s-ink-2", moderate: "text-sky-700 dark:text-sky-300", high: "text-amber-700 dark:text-amber-300", critical: "text-s-danger" };
const OUTCOME_LABEL: Record<string, string> = { allow: "Allowed", deny: "Refused", needs_approval: "Needed approval" };
const STATE_LABEL: Record<string, string> = { enforced: "Enforced", partial: "Partly enforced", not_covered: "Not covered" };
const btn = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-s-line-strong px-2.5 text-[12.5px] transition hover:bg-s-hover disabled:opacity-50";

export function BastionWorkspace() {
  const { user, integrations } = useApp();
  const [tab, setTab] = useState<Tab>("overview");
  const [data, setData] = useState<UserView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signedOut = integrations.supabase ? !user : true;
  const load = useCallback(() => jsonFetch<UserView>("/api/bastion").then(setData), []);

  useEffect(() => {
    if (signedOut) return;
    let alive = true;
    void load().catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [signedOut, load]);

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
              The protection layer every agent goes through. Commands, file changes, connected services, GitHub pushes and the rest are checked on Orbis&apos;s servers right before they run — not just
              requested of the AI — and refused when policy says no.
            </p>
          </div>
          <Segmented
            label="Bastion sections"
            value={tab}
            onChange={setTab}
            options={[
              { value: "overview", label: "Overview" },
              { value: "policy", label: "Policy" },
              { value: "decisions", label: "Decisions" },
              ...(data?.admin ? [{ value: "controls" as const, label: "Controls (admin)" }] : []),
            ]}
          />
          {signedOut ? (
            <p className="rounded-[20px] border border-dashed border-s-line-strong px-6 py-8 text-center text-[14px] text-s-ink-2">Sign in to see Bastion.</p>
          ) : error ? (
            <p role="alert" className="flex items-center gap-2 text-[14px] text-s-danger">
              <CircleAlert className="h-4 w-4" /> {error}
            </p>
          ) : !data ? (
            <div className="s-skeleton h-48 rounded-2xl" />
          ) : tab === "overview" ? (
            <Overview d={data} />
          ) : tab === "policy" ? (
            <Policy d={data} />
          ) : tab === "decisions" ? (
            <Decisions summary={data.summary} empty="Bastion hasn't refused or asked approval for anything you or your agents did." />
          ) : (
            <Controls onSaved={() => void load()} />
          )}
        </div>
      </div>
    </>
  );
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

function Status({ d }: { d: UserView }) {
  const c = d.controls;
  const [Icon, text, tone] = !d.available
    ? [ShieldOff, "Bastion can't confirm its controls right now, so protected actions are paused (fail closed). Reading and analysis still work.", "text-s-danger"]
    : c?.lockdown
      ? [Lock, "Lockdown: an administrator has paused every action except reading and analysis.", "text-s-danger"]
      : [ShieldCheck, `Enforcing policy version ${c?.version ?? 1}${c && c.updatedAt > "1971" ? ` (changed ${fmtTime(c.updatedAt)})` : ""}.`, "text-emerald-700 dark:text-emerald-300"];
  return (
    <p className={`flex items-start gap-2 rounded-[16px] border border-s-line px-4 py-3 text-[14px] ${tone}`} role="status">
      <Icon className="mt-0.5 h-4 w-4 shrink-0" /> {text}
    </p>
  );
}

function Overview({ d }: { d: UserView }) {
  const suspended = SUSPENDABLE.filter((a) => d.controls?.suspendedAgents.includes(a.id));
  const blocked = (d.controls?.blockedCapabilities ?? []) as Capability[];
  return (
    <div className="space-y-4">
      <Status d={d} />
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Refused" value={d.summary.denied} hint="your agents' actions" />
        <Stat label="Needed approval" value={d.summary.needsApproval} />
        <Stat label="High-risk allowed" value={d.summary.approvedHighRisk} hint="each one approved" />
        <Stat label="Runs stopped" value={d.summary.contained.length} hint="after repeated refusals" />
      </dl>
      {(suspended.length > 0 || blocked.length > 0) && (
        <Section title="Switched off by an administrator">
          <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-s-ink-2">
            {suspended.map((a) => (
              <li key={a.id}>
                {a.label} is suspended — {a.scope}
              </li>
            ))}
            {blocked.map((c) => (
              <li key={c}>{CAPABILITIES[c]}: off</li>
            ))}
          </ul>
        </Section>
      )}
      <Section title="How Bastion decides" note="Risk levels can be raised by an administrator but never set below these floors.">
        <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-s-ink-2">
          <li>Low — reading and analysis. Allowed, even in lockdown.</li>
          <li>Moderate — reversible changes in your own workspace (edits, safe commands, previews). Allowed unless switched off.</li>
          <li>High — anything with effects outside the workspace or on sensitive files. Needs your approval of that exact action; an approval doesn&apos;t carry over to anything else.</li>
          <li>Critical — destructive, publishing or policy-changing actions. Agents can&apos;t do these at all.</li>
          <li>Agents can never change Bastion&apos;s policy, grant permissions or approve their own actions. When Bastion can&apos;t read its controls, only low-risk actions go ahead.</li>
        </ul>
      </Section>
      <Section title="Where it's enforced" note="Listed honestly: places marked partly enforced or not covered don't have every protection yet.">
        <ul className="divide-y divide-s-line">
          {d.enforcement.map((e) => (
            <li key={e.surface} className="py-2.5 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 basis-[240px] font-medium">{e.surface}</span>
                <span className={`text-[12.5px] ${e.state === "enforced" ? "text-emerald-700 dark:text-emerald-300" : e.state === "partial" ? "text-amber-700 dark:text-amber-300" : "text-s-ink-3"}`}>
                  {STATE_LABEL[e.state]}
                </span>
              </div>
              <p className="text-s-ink-2">{e.note}</p>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Policy({ d }: { d: UserView }) {
  return (
    <Section title="Operations" note="Every protected action Bastion knows about, with the risk level it's treated at now.">
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Operations table">
        <table className="w-full min-w-[560px] text-left text-[13px]">
          <thead className="text-[12px] text-s-ink-3">
            <tr>
              <th className="py-1 pr-3 font-medium">Action</th>
              <th className="py-1 pr-3 font-medium">Risk now</th>
              <th className="py-1 pr-3 font-medium">Default</th>
              <th className="py-1 font-medium">Switch</th>
            </tr>
          </thead>
          <tbody>
            {d.policy.map((p) => (
              <tr key={p.id} className="border-t border-s-line align-top">
                <td className="py-1.5 pr-3">
                  {p.label}
                  <span className="block font-mono text-[11px] text-s-ink-3">{p.id}</span>
                </td>
                <td className={`py-1.5 pr-3 ${RISK_STYLE[p.risk]}`}>{p.risk}</td>
                <td className="py-1.5 pr-3 text-s-ink-2">{p.base}</td>
                <td className="py-1.5 text-s-ink-2">{p.capabilityLabel ? `${p.blocked ? "Off — " : ""}${p.capabilityLabel}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function Decisions({ summary, empty, showUser }: { summary: BastionSummary; empty: string; showUser?: boolean }) {
  if (!summary.total) return <p className="text-[13.5px] text-s-ink-2">{empty}</p>;
  return (
    <div className="space-y-4">
      {summary.contained.length > 0 && (
        <Section title="Runs stopped after repeated refusals">
          <ul className="list-disc space-y-1 pl-5 text-[13.5px] text-s-ink-2">
            {summary.contained.map((r) => (
              <li key={r.runId}>
                {r.agent.replace("_", " ")} run {r.runId.slice(0, 8)} — {r.denied} refused actions
              </li>
            ))}
          </ul>
        </Section>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Section title="By action">
          <ul className="space-y-1 text-[13px]">
            {summary.byOp.slice(0, 12).map((o) => (
              <li key={o.op} className="flex gap-2">
                <span className="min-w-0 flex-1">{o.label}</span>
                <span className="text-s-ink-3 tabular-nums">
                  {o.denied} refused · {o.needsApproval} approval · {o.allowed} allowed
                </span>
              </li>
            ))}
          </ul>
        </Section>
        <Section title="By agent">
          <ul className="space-y-1 text-[13px]">
            {summary.byAgent.slice(0, 12).map((a) => (
              <li key={a.agent} className="flex gap-2">
                <span className="min-w-0 flex-1">{a.agent.replace("_", " ") || "—"}</span>
                <span className="text-s-ink-3 tabular-nums">
                  {a.denied} refused · {a.needsApproval} approval · {a.allowed} allowed
                </span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
      <Section title="Recent decisions" note="Resources are recorded with credentials removed; command output and file contents are never recorded.">
        <ul className="divide-y divide-s-line">
          {summary.recent.map((r, i) => (
            <li key={i} className="py-2 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`font-medium ${r.outcome === "deny" ? "text-s-danger" : ""}`}>{OUTCOME_LABEL[r.outcome]}</span>
                <span className="min-w-0 flex-1">{r.label}</span>
                <span className={`text-[12px] ${RISK_STYLE[r.risk] ?? ""}`}>{r.risk}</span>
                <span className="text-[12px] text-s-ink-3">{fmtTime(r.at)}</span>
              </div>
              <p className="break-all font-mono text-[11.5px] text-s-ink-3">{r.resource}</p>
              <p className="text-s-ink-2">
                {r.agent.replace("_", " ")}
                {showUser && r.user ? ` · user ${r.user}` : ""} — {r.reason}
              </p>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/* --------------------------------------------------------------- controls */

function Controls({ onSaved }: { onSaved: () => void }) {
  const { notify } = useStudio();
  const [view, setView] = useState<AdminView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lockdown, setLockdown] = useState(false);
  const [suspended, setSuspended] = useState<string[]>([]);
  const [blocked, setBlocked] = useState<Capability[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Risk>>({});
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);

  const apply = (c: Pick<BastionControls, "lockdown" | "suspendedAgents" | "blockedCapabilities" | "riskOverrides">) => {
    setLockdown(c.lockdown);
    setSuspended(c.suspendedAgents);
    setBlocked(c.blockedCapabilities);
    setOverrides(c.riskOverrides);
  };
  const load = useCallback(
    () =>
      jsonFetch<AdminView>("/api/admin/bastion").then((v) => {
        setView(v);
        if (v.controls) apply(v.controls);
      }),
    [],
  );
  useEffect(() => {
    void load().catch((e: Error) => setError(e.message));
  }, [load]);

  const save = async () => {
    if (!view) return;
    setBusy(true);
    try {
      await jsonFetch("/api/admin/bastion", {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: view.version,
          lockdown,
          suspendedAgents: suspended,
          blockedCapabilities: blocked,
          riskOverrides: overrides,
          ...(note.trim() ? { note } : {}),
          confirm: true,
        }),
      });
      setNote("");
      setConfirmed(false);
      await load();
      onSaved();
      notify("Saved. Every Orbis server applies it within about 10 seconds.");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error)
    return (
      <p role="alert" className="flex items-center gap-2 text-[14px] text-s-danger">
        <CircleAlert className="h-4 w-4" /> {error}
      </p>
    );
  if (!view) return <div className="s-skeleton h-48 rounded-2xl" />;
  const toggle = <T extends string>(list: T[], v: T, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  const rank = (r: Risk) => RISKS.indexOf(r);
  return (
    <div className="space-y-4">
      {!view.valid && (
        <p role="alert" className="rounded-[16px] border border-s-line px-4 py-3 text-[14px] text-s-danger">
          The stored controls don&apos;t validate, so Bastion is failing closed. Saving below replaces them with a valid version.
        </p>
      )}
      <Section title="Emergency">
        <div className="flex flex-wrap items-center gap-3">
          <Switch checked={lockdown} onChange={setLockdown} label="Lockdown" />
          <span className="text-[13.5px]">Lockdown — refuse everything except reading and analysis, for every user and agent.</span>
        </div>
      </Section>
      <Section title="Suspend agents">
        <ul className="space-y-2">
          {SUSPENDABLE.map((a) => (
            <li key={a.id} className="flex items-start gap-2 text-[13.5px]">
              <input id={`susp-${a.id}`} type="checkbox" className="mt-1" checked={suspended.includes(a.id)} onChange={(e) => setSuspended(toggle(suspended, a.id, e.target.checked))} />
              <label htmlFor={`susp-${a.id}`}>
                <span className="font-medium">{a.label}</span> <span className="text-s-ink-2">— {a.scope}</span>
              </label>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Switch capabilities off">
        <ul className="space-y-2">
          {(Object.keys(CAPABILITIES) as Capability[]).map((c) => (
            <li key={c} className="flex items-start gap-2 text-[13.5px]">
              <input id={`cap-${c}`} type="checkbox" className="mt-1" checked={blocked.includes(c)} onChange={(e) => setBlocked(toggle(blocked, c, e.target.checked))} />
              <label htmlFor={`cap-${c}`}>{CAPABILITIES[c]}</label>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Raise risk levels" note="A higher level means more approvals (high) or no agent access at all (critical). Levels can't go below their defaults.">
        <ul className="space-y-1.5">
          {(Object.keys(OPERATIONS) as OperationId[])
            .filter((op) => op !== "policy.modify" && op !== "permission.grant" && OPERATIONS[op].risk !== "critical")
            .map((op) => (
              <li key={op} className="flex flex-wrap items-center gap-2 text-[13px]">
                <label htmlFor={`risk-${op}`} className="min-w-0 flex-1 basis-[240px]">
                  {OPERATIONS[op].label}
                </label>
                <select
                  id={`risk-${op}`}
                  value={overrides[op] ?? OPERATIONS[op].risk}
                  onChange={(e) => {
                    const v = e.target.value as Risk;
                    const next = { ...overrides };
                    if (v === OPERATIONS[op].risk) delete next[op];
                    else next[op] = v;
                    setOverrides(next);
                  }}
                  className="h-8 rounded-lg border border-s-line bg-transparent px-2 text-[13px]"
                >
                  {RISKS.filter((r) => rank(r) >= rank(OPERATIONS[op].risk as Risk)).map((r) => (
                    <option key={r} value={r}>
                      {r}
                      {r === OPERATIONS[op].risk ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </li>
            ))}
        </ul>
      </Section>
      <Section title={`Activate version ${view.version + 1}`}>
        <label className="flex flex-col gap-1 text-[12px] text-s-ink-3">
          Why (kept in the history)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} className="h-9 rounded-xl border border-s-line bg-transparent px-2.5 text-[13.5px] text-s-ink" />
        </label>
        <label className="mt-3 flex items-start gap-2 text-[13.5px]">
          <input type="checkbox" className="mt-1" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>I understand this changes what every user&apos;s agents may do, straight away.</span>
        </label>
        <button type="button" className={`${btn} mt-3`} disabled={!confirmed || busy} onClick={() => void save()}>
          {busy ? "Saving…" : "Activate"}
        </button>
      </Section>
      {view.controls && view.controls.history.length > 0 && (
        <Section title="History" note="Restoring fills the form with that version; nothing changes until you activate it.">
          <ul className="divide-y divide-s-line">
            {view.controls.history.map((h) => (
              <li key={`${h.version}-${h.at}`} className="flex flex-wrap items-center gap-2 py-2 text-[13px]">
                <span className="min-w-0 flex-1 basis-[260px]">
                  v{h.version} · {h.at > "1971" ? fmtTime(h.at) : "default"} — {h.summary}
                </span>
                {h.snapshot && (
                  <button type="button" className={btn} onClick={() => apply(h.snapshot!)}>
                    Restore v{h.version}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section title={view.scope === "all_users" ? "Decisions across all users" : "Decisions (yours only — the service key isn't configured)"}>
        <Decisions summary={view.summary} empty="No decisions recorded yet." showUser />
      </Section>
    </div>
  );
}
