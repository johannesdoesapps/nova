"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, Check, CircleAlert, Loader2, Play } from "lucide-react";
import { NEEDS_PROJECT, PROPOSAL_FIELDS, type TaskProposal } from "@/lib/agent-platform/delegation";
import { agentDef } from "@/lib/agent-platform/registry";
import { cn } from "@/lib/utils";
import { AgentIconTile } from "./marketplace";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fieldClass = "w-full rounded-xl border border-s-line bg-s-bg/60 px-3 py-2 text-[13.5px] outline-none focus:border-s-line-strong focus-visible:outline-2 focus-visible:outline-[var(--s-ring)]";

/** The card's editable values as text (selects hold their option value). */
function toValues(p: TaskProposal): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of PROPOSAL_FIELDS[p.agent]) {
    const v = p.input[f.key];
    out[f.key] = Array.isArray(v) ? v.join(",") : v === undefined || v === null ? "" : String(v);
  }
  return out;
}

function toInput(p: TaskProposal, values: Record<string, string>): Record<string, unknown> {
  const input: Record<string, unknown> = { ...p.input };
  for (const f of PROPOSAL_FIELDS[p.agent]) {
    const v = values[f.key] ?? "";
    if (f.key === "readOnly") input[f.key] = v === "true";
    else if (f.key === "kinds") input[f.key] = v.split(",").filter(Boolean);
    else input[f.key] = v;
  }
  return input;
}

/**
 * A task the Orbis Agent proposed for a specialist agent. Nothing has started: the user checks the
 * project and details, edits them if needed, and presses Start; the server checks access and input
 * again. Once started, the card links to the task's own page, where it runs and reports.
 */
export function TaskCard({ proposal, messageId }: { proposal: TaskProposal; messageId: string }) {
  const def = agentDef(proposal.agent)!;
  const [values, setValues] = useState(() => toValues(proposal));
  const [projectId, setProjectId] = useState<string>(proposal.projectId ?? "");
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [state, setState] = useState<TaskProposal["status"]>(proposal.status);
  const [result, setResult] = useState(proposal.result ?? null);
  const [busy, setBusy] = useState(false);
  const need = NEEDS_PROJECT[proposal.agent];
  const editable = state !== "started";

  useEffect(() => {
    if (!editable || need === "none") return;
    let alive = true;
    fetch("/api/code/projects")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { projects?: { id: string; name: string }[] } | null) => alive && setProjects(j?.projects ?? []))
      .catch(() => alive && setProjects([]));
    return () => {
      alive = false;
    };
  }, [editable, need]);

  const start = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/agent-platform/delegate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent: proposal.agent, projectId: projectId || null, input: toInput(proposal, values), ...(UUID.test(messageId) ? { messageId, proposalId: proposal.id } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; summary?: string; href?: string | null; error?: { message?: string } } | null;
      if (res.ok && body?.ok) {
        setState("started");
        setResult({ summary: body.summary ?? "Started.", href: body.href ?? null });
      } else {
        setState("failed");
        setResult({ summary: body?.error?.message ?? body?.summary ?? "The task couldn't be started.", href: null });
      }
    } catch {
      setState("failed");
      setResult({ summary: "Orbis couldn't be reached. Nothing was started.", href: null });
    } finally {
      setBusy(false);
    }
  };

  const missingProject = need === "required" && !projectId;
  return (
    <section className="s-in mt-4 rounded-2xl border border-s-line-strong p-4 text-[13.5px]" aria-label={`Proposed ${def.name} task`}>
      <div className="flex items-start gap-3">
        <AgentIconTile agent={def} />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-s-ink-3">{state === "started" ? "Started" : "Proposed by Orbis — nothing runs until you start it"}</p>
          <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{def.name} task</h3>
          <p className="text-[12.5px] text-s-ink-3">{def.tagline}</p>
        </div>
      </div>

      {editable ? (
        <div className="mt-3 space-y-3">
          {need !== "none" && (
            <label className="block">
              <span className="text-[12.5px] font-medium">Project{need === "optional" ? " (or a GitHub link below)" : ""}</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className={cn(fieldClass, "mt-1 h-9")}>
                <option value="">{projects === null ? "Loading your projects…" : need === "optional" ? "No project" : "Choose a project"}</option>
                {(projects ?? (proposal.projectId ? [{ id: proposal.projectId, name: proposal.projectName ?? "Project" }] : [])).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {PROPOSAL_FIELDS[proposal.agent].map((f) => (
            <label key={f.key} className="block">
              <span className="text-[12.5px] font-medium">{f.label}</span>
              {f.kind === "select" ? (
                <select value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} className={cn(fieldClass, "mt-1 h-9")}>
                  {f.options!.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.kind === "textarea" ? (
                <textarea
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  rows={f.key === "logs" ? 4 : 2}
                  className={cn(fieldClass, "mt-1", f.key === "logs" && "font-mono text-[12px]")}
                />
              ) : (
                <input value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} className={cn(fieldClass, "mt-1 h-9")} />
              )}
            </label>
          ))}
          {state === "failed" && result && (
            <p role="alert" className="flex items-start gap-1.5 text-s-danger">
              <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {result.summary}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12px] text-s-ink-3">{def.charging}</p>
            <button
              type="button"
              onClick={() => void start()}
              disabled={busy || missingProject}
              className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink hover:brightness-110 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />} Start task
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="flex items-start gap-1.5 text-s-ink-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden /> {result?.summary ?? "Started."}
          </p>
          {result?.href && (
            <Link href={result.href} className="inline-flex h-8 items-center gap-1 rounded-full border border-s-line px-3 text-[12.5px] hover:border-s-line-strong">
              Open the task <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          )}
          <span className="text-[12px] text-s-ink-3">It runs while its page is open; see all tasks in Activity.</span>
        </div>
      )}
    </section>
  );
}
