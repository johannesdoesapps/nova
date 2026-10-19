"use client";
import Link from "next/link";
import { useState } from "react";
import { Check, Loader2, RotateCcw, X } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import { cn } from "@/lib/utils";
import { btn, btnPrimary, field, when } from "./bits";

export interface ApprovalLite {
  id: string;
  task_id: string;
  kind: "plan" | "budget" | "changes" | "push";
  status: string;
  title: string;
  reason: string;
  risk: "low" | "medium" | "high";
  payload: Record<string, unknown>;
  payload_hash: string;
  created_at: string;
}

interface PlanPayload {
  plan?: { summary: string; approach: string; changes: { path: string; action: string; intent: string }[]; tests: string[]; risks: string[]; acceptanceCriteria: string[]; outOfScope: string[] };
}

export function ApprovalCard({ a, onDone, showTaskLink }: { a: ApprovalLite; onDone: () => void; showTaskLink?: boolean }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const plan = a.kind === "plan" ? (a.payload as PlanPayload).plan : undefined;
  const decide = async (decision: "approved" | "rejected", withNote: boolean) => {
    setBusy(decision + withNote);
    setError(null);
    try {
      await jsonFetch(`/api/workforce/approvals/${a.id}`, { method: "POST", body: JSON.stringify({ decision, note: withNote && note.trim() ? note.trim() : null, payloadHash: a.payload_hash }) });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="glass-strong glass-edge rounded-[20px] p-5" aria-label={a.title}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium", a.risk === "high" ? "border-red-500/30 text-s-danger" : a.risk === "medium" ? "border-amber-500/30 text-amber-700 dark:text-amber-300" : "border-s-line text-s-ink-2")}>{a.risk} risk</span>
        <span className="text-[12px] uppercase tracking-[0.06em] text-s-ink-3">{a.kind === "plan" ? "Plan approval" : a.kind === "budget" ? "Budget increase" : a.kind}</span>
        <span className="ml-auto text-[12px] text-s-ink-3">{when(a.created_at)}</span>
      </div>
      <h3 className="mt-2 text-[15.5px] font-semibold">{a.title}</h3>
      <p className="mt-1 whitespace-pre-wrap text-[13.5px] text-s-ink-2">{a.reason}</p>
      {plan && (
        <div className="mt-3 space-y-3 text-[13px]">
          {plan.approach && <p className="text-s-ink-2">{plan.approach}</p>}
          <div>
            <p className="font-medium">Files that will change</p>
            <ul className="mt-1 space-y-1">
              {plan.changes.map((c) => (
                <li key={c.path} className="flex gap-2">
                  <code className="shrink-0 rounded bg-s-hover px-1.5 py-0.5 text-[12px]">{c.path}</code>
                  <span className="text-s-ink-3">{c.action}</span>
                  <span className="min-w-0 text-s-ink-2">— {c.intent}</span>
                </li>
              ))}
            </ul>
          </div>
          {plan.acceptanceCriteria.length > 0 && (
            <div>
              <p className="font-medium">Acceptance criteria</p>
              <ul className="mt-1 list-disc pl-5 text-s-ink-2">{plan.acceptanceCriteria.map((c) => <li key={c}>{c}</li>)}</ul>
            </div>
          )}
          {plan.risks.length > 0 && (
            <div>
              <p className="font-medium">Risks</p>
              <ul className="mt-1 list-disc pl-5 text-s-ink-2">{plan.risks.map((c) => <li key={c}>{c}</li>)}</ul>
            </div>
          )}
          <p className="text-[12px] text-s-ink-3">Expected consequence: files change only inside the task’s isolated workspace. Nothing is committed to your repository, pushed or deployed.</p>
        </div>
      )}
      {a.kind === "budget" && <p className="mt-2 text-[13px] text-s-ink-2">New limits: ${String((a.payload as { budgetUsd?: number }).budgetUsd)} and {Number((a.payload as { tokenBudget?: number }).tokenBudget).toLocaleString("en-US")} tokens.</p>}
      {a.status === "pending" ? (
        <>
          {a.kind === "plan" && <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Optional note. With a note, “Revise plan” sends it back to the architect." aria-label="Decision note" className={cn(field, "mt-3 text-[13px]")} />}
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void decide("approved", false)} disabled={!!busy} className={btnPrimary}>
              {busy === "approvedfalse" ? <Loader2 className="animate-spin" /> : <Check />} Approve
            </button>
            {a.kind === "plan" && (
              <button type="button" onClick={() => void decide("rejected", true)} disabled={!!busy || !note.trim()} className={btn} title={note.trim() ? undefined : "Write what to change first"}>
                <RotateCcw /> Revise plan
              </button>
            )}
            <button type="button" onClick={() => void decide("rejected", false)} disabled={!!busy} className={btn}>
              <X /> {a.kind === "plan" ? "Reject & cancel task" : "Reject"}
            </button>
            {showTaskLink && (
              <Link href={`/workforce/tasks/${a.task_id}`} className="ml-auto self-center text-[13px] text-s-ink-2 underline underline-offset-2">
                Open task
              </Link>
            )}
          </div>
        </>
      ) : (
        <p className="mt-3 text-[13px] text-s-ink-3">{a.status}</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-s-danger">
          {error}
        </p>
      )}
    </section>
  );
}
