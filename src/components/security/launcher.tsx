"use client";
import { useRef, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { useCatalog } from "@/components/common/model-picker";
import { ModelSelector } from "@/components/studio/model-selector";
import { Dialog } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import { Segmented } from "@/components/studio/ui";
import { AUDIT_MODES, BUDGET_INFO, crawlBudget, MODE_INFO, TIME_BUDGETS, type AuditMode, type TimeBudget } from "@/lib/security/audit";
import { SEVERITIES, type Severity } from "@/lib/security/types";
import { cn } from "@/lib/utils";
import { AGENT_NAME, AgentBadge, EMPTY_RUN, ICON_OF, RunProgress, streamRun, type RunState } from "./bits";
import {
  GuardianForm,
  guardianBody,
  guardianReady,
  HunterForm,
  hunterBody,
  hunterReady,
  SentinelForm,
  sentinelReady,
  type GuardianValue,
  type HunterValue,
  type SentinelValue,
  type Target,
} from "./forms";

export type LaunchMode = "sentinel" | "threat_hunter" | "code_guardian" | "coordinated" | "audit";
type AgentKey = Exclude<LaunchMode, "coordinated" | "audit">;
const ORDER: AgentKey[] = ["sentinel", "threat_hunter", "code_guardian"];
const URL_OF: Record<AgentKey, string> = { sentinel: "/api/security/sentinel", threat_hunter: "/api/security/hunter", code_guardian: "/api/security/guardian" };
const TITLE: Record<LaunchMode, string> = {
  sentinel: "Scan website",
  threat_hunter: "Investigate threat",
  code_guardian: "Audit code",
  coordinated: "Coordinated investigation",
  audit: "Security audit",
};
const SCOPE_LABEL: Record<AgentKey, string> = { sentinel: "Website", code_guardian: "Code", threat_hunter: "Logs (optional)" };

export function Launcher({ mode, onClose, targets, onTargetsChanged, onFinished }: { mode: LaunchMode | null; onClose: () => void; targets: Target[]; onTargetsChanged: () => Promise<void>; onFinished: () => void }) {
  return (
    <Dialog open={!!mode} onClose={onClose} title={mode ? TITLE[mode] : ""} width={680}>
      {mode && <LauncherBody key={mode} mode={mode} onClose={onClose} targets={targets} onTargetsChanged={onTargetsChanged} onFinished={onFinished} />}
    </Dialog>
  );
}

function LauncherBody({ mode, onClose, targets, onTargetsChanged, onFinished }: { mode: LaunchMode; onClose: () => void; targets: Target[]; onTargetsChanged: () => Promise<void>; onFinished: () => void }) {
  const catalog = useCatalog();
  const [modelId, setModelId] = useState<string>("auto:deep");
  const [sentinel, setSentinel] = useState<SentinelValue>({ targetId: targets.find((t) => t.verified_at)?.id ?? targets[0]?.id ?? "", scope: "passive", authorized: false });
  const [hunter, setHunter] = useState<HunterValue>({ files: [], pasted: "", indicators: "", asset: "" });
  const [guardian, setGuardian] = useState<GuardianValue>({ mode: "upload", files: [], repo: "", prNumber: "", asset: "", aiReview: true, proposeFixes: false });
  const [include, setInclude] = useState<Record<AgentKey, boolean>>({ sentinel: true, threat_hunter: mode !== "audit", code_guardian: true });
  const [auditMode, setAuditMode] = useState<AuditMode>("deep");
  const [timeBudget, setTimeBudget] = useState<TimeBudget>("standard");
  const [blockSeverities, setBlockSeverities] = useState<Severity[]>(["critical", "high"]);
  const [blockUnverified, setBlockUnverified] = useState(false);
  const multi = mode === "coordinated" || mode === "audit";
  const [run, setRun] = useState<RunState>(EMPTY_RUN);
  const abort = useRef<AbortController | null>(null);
  const parent = useRef<string | null>(null);
  const update = (fn: (s: RunState) => RunState) => setRun(fn);

  const agents: AgentKey[] = multi ? ORDER.filter((a) => include[a]) : [mode as AgentKey];
  const ready: Record<AgentKey, boolean> = { sentinel: sentinelReady(sentinel), threat_hunter: hunterReady(hunter), code_guardian: guardianReady(guardian) };
  const canStart =
    agents.length > 0 && agents.every((a) => ready[a]) && (mode !== "coordinated" || agents.length >= 2) && (mode !== "audit" || auditMode !== "release_gate" || blockSeverities.length > 0);
  const budget = crawlBudget(auditMode, timeBudget, sentinel.scope === "active");
  const body = (a: AgentKey) =>
    a === "sentinel" ? { targetId: sentinel.targetId, scope: sentinel.scope, authorized: sentinel.authorized } : a === "threat_hunter" ? hunterBody(hunter) : guardianBody(guardian);
  const running = run.phase === "running";

  const start = async () => {
    const ctrl = new AbortController();
    abort.current = ctrl;
    setRun({ ...EMPTY_RUN, phase: "running" });
    try {
      if (!multi) {
        const r = await streamRun(URL_OF[mode as AgentKey], { ...body(mode as AgentKey), modelId }, ctrl.signal, update);
        update((s) => ({ ...s, phase: r.ok ? "done" : "error" }));
      } else {
        const audit = mode === "audit" ? { mode: auditMode, timeBudget, active: include.sentinel && sentinel.scope === "active", gate: { blockSeverities, blockUnverified } } : undefined;
        const { runId } = await jsonFetch<{ runId: string }>("/api/security/coordinate", { method: "POST", body: JSON.stringify({ plan: agents, ...(audit ? { audit } : {}) }) });
        parent.current = runId;
        // Each agent runs as its own request so it stays within time limits and can be cancelled.
        for (const a of agents) {
          await streamRun(URL_OF[a], { ...body(a), modelId, parentId: runId }, ctrl.signal, update);
          // A failed agent doesn't stop the others; its error is kept as a notice and in the report.
          update((s) => (s.error ? { ...s, notices: [...s.notices, `${AGENT_NAME[a]} did not finish: ${s.error}`], error: null } : s));
        }
        await streamRun(`/api/security/coordinate/${runId}/report`, { modelId }, ctrl.signal, update);
        update((s) => ({ ...s, phase: "done", runIds: { coordinated: runId, ...s.runIds } }));
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        update((s) => ({ ...s, phase: "cancelled", notices: [...s.notices, "Cancelled. Partial results that finished before cancelling are saved."], steps: s.steps.map((x) => (x.status === "running" ? { ...x, status: "skipped", detail: "Cancelled" } : x)) }));
        if (parent.current) void fetch(`/api/security/coordinate/${parent.current}/report`, { method: "DELETE" });
      } else update((s) => ({ ...s, phase: "error", error: (e as Error).message }));
    } finally {
      abort.current = null;
      onFinished();
    }
  };

  return (
    <div>
      {mode === "audit" && (
        <fieldset disabled={running} className="mb-5 space-y-4">
          <legend className="sr-only">Audit settings</legend>
          <div role="radiogroup" aria-label="Audit mode" className="grid gap-2 sm:grid-cols-2">
            {AUDIT_MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={auditMode === m}
                onClick={() => setAuditMode(m)}
                className={cn("rounded-2xl border p-3 text-left transition", auditMode === m ? "border-s-line-strong bg-s-glass-strong shadow-[var(--s-shadow-sm)]" : "border-s-line hover:bg-s-hover")}
              >
                <span className="block text-[14px] font-medium">{MODE_INFO[m].label}</span>
                <span className="mt-0.5 block text-[12.5px] text-s-ink-2">{MODE_INFO[m].summary}</span>
              </button>
            ))}
          </div>
          <div>
            <span className="mb-1.5 block text-[12.5px] font-medium text-s-ink-2">Time budget</span>
            <Segmented label="Time budget" value={timeBudget} onChange={setTimeBudget} options={TIME_BUDGETS.map((b) => ({ value: b, label: BUDGET_INFO[b].label }))} />
            <p className="mt-1.5 text-[12.5px] text-s-ink-3">
              Website: up to {budget.pages} page(s) and {budget.scripts} script(s){sentinel.scope === "active" ? `, ${budget.endpointChecks} endpoint check(s)` : ""}, and the crawl stops after {budget.seconds} seconds. What doesn&apos;t fit is listed
              as not assessed.
            </p>
          </div>
          {auditMode === "release_gate" && (
            <div className="rounded-2xl border border-s-line p-3">
              <span className="block text-[12.5px] font-medium text-s-ink-2">The gate fails on open findings of these severities</span>
              <div className="mt-2 flex flex-wrap gap-3">
                {SEVERITIES.map((sv) => (
                  <label key={sv} className="flex cursor-pointer items-center gap-1.5 text-[13px] capitalize">
                    <input
                      type="checkbox"
                      checked={blockSeverities.includes(sv)}
                      onChange={(e) => setBlockSeverities(e.target.checked ? [...blockSeverities, sv] : blockSeverities.filter((x) => x !== sv))}
                      className="h-4 w-4 accent-[var(--s-accent)]"
                    />
                    {sv}
                  </label>
                ))}
              </div>
              <label className="mt-2 flex cursor-pointer items-start gap-2 text-[13px]">
                <input type="checkbox" checked={blockUnverified} onChange={(e) => setBlockUnverified(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--s-accent)]" />
                <span>Also fail on findings that still need verification (stricter). Otherwise only confirmed and likely findings block.</span>
              </label>
              <p className="mt-2 text-[12px] text-s-ink-3">
                The gate also fails as “incomplete” if any part of the audit doesn&apos;t finish. Findings you mark as accepted risk or false positive don&apos;t block.
              </p>
            </div>
          )}
          <p className="text-[12.5px] text-s-ink-3">Choose what&apos;s in scope. The website must be one you&apos;ve proved you control; code is read, never run.</p>
        </fieldset>
      )}
      {multi ? (
        <div className="space-y-3">
          {mode === "coordinated" && (
            <p className="text-[13.5px] text-s-ink-2">
              Choose at least two agents. They run in order — Sentinel, then Threat Hunter, then Code Guardian — then Orbis links related findings and writes one report. Steps that are skipped or fail
              are reported as such.
            </p>
          )}
          {ORDER.map((a) => (
            <section key={a} className={cn("rounded-2xl border p-4 transition", include[a] ? "border-s-line-strong" : "border-s-line opacity-70")}>
              <label className="flex cursor-pointer items-center gap-3">
                <input type="checkbox" checked={include[a]} disabled={running} onChange={(e) => setInclude({ ...include, [a]: e.target.checked })} className="h-4 w-4 accent-[var(--s-accent)]" />
                <AgentBadge agent={a} icon={ICON_OF[a]!} size="sm" />
                <span className="text-[14px] font-medium">{mode === "audit" ? SCOPE_LABEL[a] : AGENT_NAME[a]}</span>
                {include[a] && !ready[a] && <span className="ml-auto text-[12px] text-s-ink-3">needs input</span>}
              </label>
              {include[a] && (
                <fieldset disabled={running} className="mt-4">
                  {a === "sentinel" && <SentinelForm value={sentinel} onChange={setSentinel} targets={targets} onTargetsChanged={onTargetsChanged} audit={mode === "audit" ? budget : undefined} />}
                  {a === "threat_hunter" && <HunterForm value={hunter} onChange={setHunter} />}
                  {a === "code_guardian" && <GuardianForm value={guardian} onChange={setGuardian} />}
                  {a === "code_guardian" && mode === "audit" && !MODE_INFO[auditMode].aiReview && (
                    <p className="mt-2 text-[12.5px] text-s-ink-3">{MODE_INFO[auditMode].label} doesn&apos;t use AI review: only rules, the application map and the dependency database decide.</p>
                  )}
                </fieldset>
              )}
            </section>
          ))}
        </div>
      ) : (
        <fieldset disabled={running}>
          {mode === "sentinel" && <SentinelForm value={sentinel} onChange={setSentinel} targets={targets} onTargetsChanged={onTargetsChanged} />}
          {mode === "threat_hunter" && <HunterForm value={hunter} onChange={setHunter} />}
          {mode === "code_guardian" && <GuardianForm value={guardian} onChange={setGuardian} />}
        </fieldset>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-s-line pt-4">
        <span className="text-[12.5px] text-s-ink-3">AI model for explanations</span>
        <ModelSelector models={catalog?.models ?? null} value={modelId} onChange={setModelId} auto={catalog?.auto ?? null} />
        <div className="ml-auto flex gap-2">
          {running ? (
            <button type="button" onClick={() => abort.current?.abort()} className="inline-flex h-10 items-center gap-2 rounded-xl border border-s-line-strong px-4 text-[14px] font-medium transition hover:bg-s-hover">
              <Square className="h-3.5 w-3.5" /> Cancel
            </button>
          ) : (
            <>
              {run.phase !== "idle" && (
                <button type="button" onClick={onClose} className="inline-flex h-10 items-center rounded-xl border border-s-line-strong px-4 text-[14px] font-medium transition hover:bg-s-hover">
                  Close
                </button>
              )}
              <button
                type="button"
                onClick={() => void start()}
                disabled={!canStart}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-s-accent px-4 text-[14px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-40"
              >
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                {run.phase === "idle" ? TITLE[mode] : "Run again"}
              </button>
            </>
          )}
        </div>
      </div>
      <RunProgress state={run} showAgent={multi} />
    </div>
  );
}
