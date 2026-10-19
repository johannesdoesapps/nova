"use client";
import { useEffect, useState } from "react";
import { Loader2, Play, Plus, Trash2 } from "lucide-react";
import { Switch } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { WorkforceSettings } from "@/lib/workforce/settings";
import type { CheckDef } from "@/lib/workforce/types";
import { cn } from "@/lib/utils";
import { btn, btnPrimary, dur, field, label, pct, usd, when } from "./bits";

/* ------------------------------------------------------------- Agents */

export interface AgentRow {
  id: string;
  name: string;
  role: string;
  version: string;
  kind: string;
  status: "active" | "planned";
  plannedReason?: string;
  responsibilities: string[];
  output: string;
  tools: string[];
  permissions: string[];
  limits: { timeoutMs: number; maxAttempts: number; maxOutputTokens: number };
  enabled: boolean;
  busy: boolean;
  model: string | null;
}
export interface AgentPerf {
  id: string;
  runs: number;
  succeeded: number;
  failed: number;
  avgMs: number | null;
  tokens: number;
}

export function AgentsPanel({ agents, perf, settings, onSettings }: { agents: AgentRow[]; perf: AgentPerf[]; settings: WorkforceSettings; onSettings: (s: WorkforceSettings) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = async (id: string, enabled: boolean) => {
    setBusy(id);
    try {
      await onSettings({ ...settings, disabledAgents: enabled ? settings.disabledAgents.filter((x) => x !== id) : [...settings.disabledAgents, id] });
    } finally {
      setBusy(null);
    }
  };
  const setModel = async (id: string, model: string) => {
    const models = { ...settings.models };
    if (model) models[id] = model;
    else delete models[id];
    await onSettings({ ...settings, models });
  };
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {agents.map((a) => {
        const p = perf.find((x) => x.id === a.id);
        return (
          <article key={a.id} className={cn("glass rounded-[20px] p-5", a.status === "planned" && "opacity-75")}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
                  {a.name}
                  <span className="rounded-full border border-s-line px-2 py-0.5 text-[11px] font-normal text-s-ink-3">v{a.version}</span>
                  <span className="rounded-full border border-s-line px-2 py-0.5 text-[11px] font-normal text-s-ink-3">{a.kind}</span>
                  {a.status === "planned" ? <span className="rounded-full border border-dashed border-s-line-strong px-2 py-0.5 text-[11px] font-normal text-s-ink-3">Not available yet</span> : a.busy ? <span className="text-[11.5px] font-normal text-sky-600 dark:text-sky-300">working</span> : null}
                </h3>
                <p className="text-[12.5px] text-s-ink-3">{a.role}</p>
              </div>
              {a.status === "active" && a.id !== "commander" && (
                <div className="flex items-center gap-2 text-[12px] text-s-ink-2">
                  {busy === a.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <Switch checked={a.enabled} onChange={(v) => void toggle(a.id, v)} label={`${a.enabled ? "Disable" : "Enable"} ${a.name}`} />
                </div>
              )}
            </div>
            {a.status === "planned" && a.plannedReason && <p className="mt-2 rounded-xl border border-s-line bg-s-hover px-3 py-2 text-[12.5px] text-s-ink-2">{a.plannedReason}</p>}
            <ul className="mt-3 list-disc space-y-0.5 pl-5 text-[12.5px] text-s-ink-2">{a.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul>
            <dl className="mt-3 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1 text-[12px]">
              <dt className="text-s-ink-3">Output</dt>
              <dd>{a.output}</dd>
              <dt className="text-s-ink-3">Tools</dt>
              <dd>{a.tools.join(", ") || "—"}</dd>
              <dt className="text-s-ink-3">Permissions</dt>
              <dd>{a.permissions.join(", ") || "none"}</dd>
              {a.status === "active" && a.id !== "commander" && (
                <>
                  <dt className="text-s-ink-3">Limits</dt>
                  <dd>
                    {dur(a.limits.timeoutMs)} · {a.limits.maxAttempts} attempt(s){a.limits.maxOutputTokens ? ` · ${a.limits.maxOutputTokens.toLocaleString("en-US")} output tokens` : ""}
                  </dd>
                </>
              )}
              {a.model !== null && a.status === "active" && (
                <>
                  <dt className="text-s-ink-3">Model</dt>
                  <dd>
                    <select aria-label={`Model for ${a.name}`} defaultValue={settings.models[a.id] ?? ""} onChange={(e) => void setModel(a.id, e.target.value)} className="rounded-lg border border-s-line bg-transparent px-2 py-1 text-[12px]">
                      <option value="">Default ({a.model})</option>
                      {["auto", "auto:quick", "auto:deep", "auto:coding", "auto:research"].map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  </dd>
                </>
              )}
              {p && (
                <>
                  <dt className="text-s-ink-3">Record</dt>
                  <dd>
                    {p.runs} run(s) · {p.succeeded} ok · {p.failed} failed · avg {dur(p.avgMs)} · {p.tokens.toLocaleString("en-US")} tokens
                  </dd>
                </>
              )}
            </dl>
          </article>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ Projects */

export interface ProjectRow {
  id: string;
  name: string;
  repo: string;
  branch: string;
  checks: CheckDef[];
  notes: string | null;
  created_at: string;
}

export function ProjectsPanel({ projects, onChanged }: { projects: ProjectRow[]; onChanged: () => void }) {
  const [form, setForm] = useState({ name: "Nova", repo: "", branch: "main" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await jsonFetch("/api/workforce/projects", { method: "POST", body: JSON.stringify(form) });
      setForm({ name: "", repo: "", branch: "main" });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <form
        className="glass rounded-[20px] p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <h3 className="text-[14.5px] font-semibold">Register a repository</h3>
        <p className="mt-1 text-[12.5px] text-s-ink-3">GitHub repositories with a package.json. Public repositories work out of the box; private ones need GITHUB_TOKEN. Checks are detected from package.json scripts — no arbitrary commands.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1.4fr_0.8fr_auto]">
          <input aria-label="Project name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Name" required className={field} />
          <input aria-label="Repository (owner/name)" value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} placeholder="owner/repository" required className={field} />
          <input aria-label="Branch" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} placeholder="main" className={field} />
          <button type="submit" disabled={busy} className={btnPrimary}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />} Register
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-[13px] text-s-danger">
            {error}
          </p>
        )}
      </form>
      {projects.map((p) => (
        <ProjectCard key={p.id} p={p} onChanged={onChanged} />
      ))}
    </div>
  );
}

interface Memory {
  id: string;
  kind: string;
  content: string;
  source: string;
  verified: boolean;
  created_at: string;
}

function ProjectCard({ p, onChanged }: { p: ProjectRow; onChanged: () => void }) {
  const [checks, setChecks] = useState(p.checks);
  const [memory, setMemory] = useState<Memory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    jsonFetch<{ memory: Memory[] }>(`/api/workforce/projects/${p.id}/memory`)
      .then((r) => alive && setMemory(r.memory))
      .catch(() => alive && setMemory([]));
    return () => {
      alive = false;
    };
  }, [p.id, version]);
  const saveChecks = async (next: CheckDef[]) => {
    setSaving(true);
    setError(null);
    try {
      await jsonFetch(`/api/workforce/projects/${p.id}`, { method: "PATCH", body: JSON.stringify({ checks: next }) });
      setChecks(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <article className="glass rounded-[20px] p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[15px] font-semibold">{p.name}</h3>
        <a href={`https://github.com/${p.repo}/tree/${p.branch}`} target="_blank" rel="noopener noreferrer" className="text-[13px] text-s-ink-2 underline underline-offset-2">
          {p.repo}@{p.branch}
        </a>
        <button
          type="button"
          onClick={async () => {
            if (!confirm(`Delete ${p.name}, its tasks and memory?`)) return;
            try {
              await jsonFetch(`/api/workforce/projects/${p.id}`, { method: "DELETE" });
              onChanged();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
          className="ml-auto rounded-lg p-1.5 text-s-ink-3 hover:bg-s-hover hover:text-s-ink"
          aria-label={`Delete ${p.name}`}
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-3 text-[12.5px] font-medium text-s-ink-2">Checks {saving && <Loader2 className="inline h-3 w-3 animate-spin" />}</p>
      <ul className="mt-1.5 space-y-1.5">
        {checks.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-s-line px-3 py-2 text-[12.5px]">
            <span className="font-medium">{c.label}</span>
            <code className="text-[11.5px] text-s-ink-3">{c.commands.map((x) => x.join(" ")).join(" && ")}</code>
            {c.network?.length ? <span className="text-[11.5px] text-s-ink-3">network: {c.network.join(", ")}</span> : null}
            <label className="ml-auto flex items-center gap-2 text-[12px] text-s-ink-2">
              Required
              <Switch checked={c.required} onChange={(v) => void saveChecks(checks.map((x) => (x.id === c.id ? { ...x, required: v } : x)))} label={`Required: ${c.label}`} />
            </label>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 text-[11.5px] text-s-ink-3">Required checks must pass for a task to be verified. The build check runs separately when enabled in Settings.</p>
      <details className="mt-3">
        <summary className="cursor-pointer text-[12.5px] font-medium text-s-ink-2">Project memory ({memory?.length ?? "…"})</summary>
        <ul className="mt-2 space-y-1.5">
          {memory?.map((m) => (
            <li key={m.id} className="flex items-start gap-2 rounded-xl border border-s-line px-3 py-2 text-[12.5px]">
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap">{m.content}</p>
                <p className="mt-0.5 text-[11.5px] text-s-ink-3">
                  {m.verified ? "verified" : "unverified"} · {m.source} · {when(m.created_at)}
                </p>
              </div>
              <button
                type="button"
                aria-label="Forget this memory"
                onClick={async () => {
                  if (!confirm("Forget this memory? Future tasks in this project won't see it.")) return;
                  try {
                    await jsonFetch(`/api/workforce/memory/${m.id}`, { method: "DELETE" });
                    setError(null);
                    setVersion((v) => v + 1);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
                className="rounded-lg p-1 text-s-ink-3 hover:bg-s-hover hover:text-s-ink"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
          {memory?.length === 0 && <li className="text-[12.5px] text-s-ink-3">No memory yet. Finished tasks add a summary, marked verified only when verification passed.</li>}
        </ul>
      </details>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-s-danger">
          {error}
        </p>
      )}
    </article>
  );
}

/* ---------------------------------------------------------- Evaluation */

export interface MetricsData {
  totals: Record<string, number>;
  rates: Record<string, number | null>;
  durations: { avgTaskMs: number | null; samples: number };
  cost: { totalUsd: number; perCompletedUsd: number | null; unpricedCalls: number; tokens: number; sandboxMinutes: number; note: string };
  findings: { review: Record<string, number>; security: Record<string, number> };
  agents: AgentPerf[] & { name?: string }[];
  benchmarks: { suite: string; versions: string; runs: number; verified: number; avgMs: number | null; avgCostUsd: number | null }[];
  definitions: Record<string, string>;
}

export function EvaluationPanel({ m, projects, onRan }: { m: MetricsData; projects: ProjectRow[]; onRan: () => void }) {
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const rows: [string, string, string | undefined][] = [
    ["Completion rate", pct(m.rates.completion), m.definitions.completion],
    ["Verified rate", pct(m.rates.verified), m.definitions.verified],
    ["Check pass rate", pct(m.rates.checkPass), m.definitions.checkPass],
    ["Human intervention", pct(m.rates.humanIntervention), m.definitions.humanIntervention],
    ["Cancellation rate", pct(m.rates.cancellation), undefined],
    ["Retries per task", m.rates.retryPerTask === null ? "—" : m.rates.retryPerTask.toFixed(2), m.definitions.retryPerTask],
    ["Average task duration", dur(m.durations.avgTaskMs), `${m.durations.samples} finished task(s)`],
    ["Timeouts", String(m.totals.timeouts ?? 0), undefined],
    ["Estimated cost per completed task", usd(m.cost.perCompletedUsd), m.cost.note],
  ];
  return (
    <div className="space-y-5">
      <section className="glass rounded-[20px] p-5">
        <h3 className="text-[14.5px] font-semibold">Quality and efficiency</h3>
        <p className="mt-1 text-[12.5px] text-s-ink-3">Computed only from stored task records. “—” means there isn&apos;t enough data yet.</p>
        <dl className="mt-3 divide-y divide-s-line">
          {rows.map(([k, v, d]) => (
            <div key={k} className="grid grid-cols-[1fr_auto] gap-3 py-2 text-[13px]">
              <dt>
                {k}
                {d && <span className="block text-[11.5px] text-s-ink-3">{d}</span>}
              </dt>
              <dd className="font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="glass rounded-[20px] p-5">
        <h3 className="text-[14.5px] font-semibold">Findings</h3>
        <p className="mt-2 text-[13px] text-s-ink-2">
          Review: {Object.entries(m.findings.review).map(([k, v]) => `${v} ${k}`).join(", ") || "none"} · Security: {Object.entries(m.findings.security).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}
        </p>
      </section>
      <section className="glass rounded-[20px] p-5">
        <h3 className="text-[14.5px] font-semibold">Benchmarks</h3>
        <p className="mt-1 text-[12.5px] text-s-ink-3">Repeatable tasks with fixed acceptance criteria. Results are grouped by agent and prompt versions so changes can be compared against a baseline. “Completed”, “passed checks” and “verified” are tracked separately.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select aria-label="Benchmark project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className={cn(field, "w-auto")}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy || !projectId}
            onClick={async () => {
              setBusy(true);
              setMsg(null);
              try {
                const r = await jsonFetch<{ tasks: unknown[] }>("/api/workforce/benchmarks", { method: "POST", body: JSON.stringify({ projectId, suite: "starter-v1" }) });
                setMsg(`${r.tasks.length} benchmark task(s) created. Open each to run it.`);
                onRan();
              } catch (e) {
                setMsg((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
            className={btn}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Play />} Create “starter-v1” suite
          </button>
          {msg && <span className="text-[12.5px] text-s-ink-2">{msg}</span>}
        </div>
        {m.benchmarks.length > 0 && (
          <div className="s-scroll mt-3 overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="text-s-ink-3">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">Suite</th>
                  <th className="py-1.5 pr-3 font-medium">Runs</th>
                  <th className="py-1.5 pr-3 font-medium">Verified</th>
                  <th className="py-1.5 pr-3 font-medium">Avg time</th>
                  <th className="py-1.5 pr-3 font-medium">Avg cost (est.)</th>
                  <th className="py-1.5 font-medium">Versions</th>
                </tr>
              </thead>
              <tbody>
                {m.benchmarks.map((b) => (
                  <tr key={b.suite + b.versions} className="border-t border-s-line">
                    <td className="py-1.5 pr-3">{b.suite}</td>
                    <td className="py-1.5 pr-3">{b.runs}</td>
                    <td className="py-1.5 pr-3">{b.verified}</td>
                    <td className="py-1.5 pr-3">{dur(b.avgMs)}</td>
                    <td className="py-1.5 pr-3">{usd(b.avgCostUsd)}</td>
                    <td className="py-1.5 text-s-ink-3">{b.versions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------ Settings */

export function SettingsPanel({ settings, onSave }: { settings: WorkforceSettings; onSave: (s: WorkforceSettings) => Promise<void> }) {
  const [s, setS] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const num = (k: keyof WorkforceSettings, labelText: string, o: { min: number; max: number; step?: number; hint?: string; scale?: number }) => (
    <div>
      <label htmlFor={`ws-${k}`} className={label}>
        {labelText}
      </label>
      <input id={`ws-${k}`} type="number" min={o.min} max={o.max} step={o.step ?? 1} value={Number(s[k]) / (o.scale ?? 1)} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) * (o.scale ?? 1) })} className={field} />
      {o.hint && <p className="mt-1 text-[11.5px] text-s-ink-3">{o.hint}</p>}
    </div>
  );
  const flag = (k: keyof WorkforceSettings, labelText: string, hint: string) => (
    <label className="flex items-start justify-between gap-3 text-[13.5px]">
      <span>
        {labelText}
        <span className="block text-[12px] text-s-ink-3">{hint}</span>
      </span>
      <Switch checked={Boolean(s[k])} onChange={(v) => setS({ ...s, [k]: v })} label={labelText} />
    </label>
  );
  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setMsg(null);
        try {
          await onSave(s);
          setMsg({ ok: true, text: "Saved. New limits apply to the next step of every task." });
        } catch (err) {
          setMsg({ ok: false, text: (err as Error).message });
        } finally {
          setBusy(false);
        }
      }}
    >
      <section className="glass space-y-4 rounded-[20px] p-5">
        <h3 className="text-[14.5px] font-semibold">Autonomy and approvals</h3>
        <div>
          <label htmlFor="ws-maxAutonomy" className={label}>
            Maximum autonomy
          </label>
          <select id="ws-maxAutonomy" value={s.maxAutonomy} onChange={(e) => setS({ ...s, maxAutonomy: e.target.value as WorkforceSettings["maxAutonomy"] })} className={field}>
            <option value="assist">Assist — analyse and recommend only</option>
            <option value="collaborate">Collaborate — build after plan approval</option>
            <option value="execute">Execute — auto-approve low/medium-risk plans</option>
          </select>
          <p className="mt-1 text-[11.5px] text-s-ink-3">High-risk plans (auth, migrations, CI or deployment config…) always need a person. Continuous Operations (scheduled autonomous work) is not available yet.</p>
        </div>
        {flag("allowDependencyChanges", "Allow dependency changes", "Off: agents may not edit package.json or lockfiles.")}
        {flag("runBuildCheck", "Run the production build check", "Adds `npm run build` (network: Google Fonts only) before verification.")}
        {flag("aiSecurityReview", "AI security review of diffs", "Runs in addition to the deterministic secret and code rules.")}
        <div>
          <label htmlFor="ws-block" className={label}>
            Block delivery on security findings at or above
          </label>
          <select id="ws-block" value={s.blockOnSecurity} onChange={(e) => setS({ ...s, blockOnSecurity: e.target.value as WorkforceSettings["blockOnSecurity"] })} className={field}>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="never">Never block (not recommended)</option>
          </select>
        </div>
      </section>
      <section className="glass grid gap-4 rounded-[20px] p-5 sm:grid-cols-2">
        <h3 className="text-[14.5px] font-semibold sm:col-span-2">Budgets and limits</h3>
        {num("defaultBudgetUsd", "Default task budget (USD)", { min: 0, max: 100, step: 0.5 })}
        {num("maxBudgetUsd", "Maximum task budget (USD)", { min: 0, max: 1000, step: 1 })}
        {num("defaultTokenBudget", "Default token budget per task", { min: 10000, max: 5000000, step: 10000 })}
        {num("maxConcurrentTasks", "Maximum concurrent tasks", { min: 1, max: 10 })}
        {num("maxParallelSteps", "Parallel steps per task", { min: 1, max: 4, hint: "At most one model call runs at a time per task so budget checks stay exact." })}
        {num("stepTimeoutMs", "Step timeout (minutes)", { min: 1, max: 30, scale: 60000 })}
        {num("maxRepairAttempts", "Self-Heal attempts per task", { min: 0, max: 5 })}
        {num("retentionDays", "Keep execution logs (days)", { min: 1, max: 365, hint: "Audit entries are never deleted." })}
        <div className="sm:col-span-2">{flag("allowUnpricedModels", "Allow models without a known price", "Their cost can't be capped; only the token budget applies.")}</div>
      </section>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className={btnPrimary}>
          {busy && <Loader2 className="animate-spin" />} Save settings
        </button>
        {msg && <span className={cn("text-[13px]", msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-s-danger")}>{msg.text}</span>}
      </div>
    </form>
  );
}
