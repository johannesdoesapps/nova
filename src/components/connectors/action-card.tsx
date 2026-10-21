"use client";
import { useState } from "react";
import { ArrowUpRight, Check, CircleAlert, PenLine } from "lucide-react";
import type { ProposedAction } from "@/lib/connectors/catalog";
import { cn } from "@/lib/utils";
import { BrandIcon } from "./brand-icon";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A change in a connected app that a reply proposed (a draft, an event, a
 * message, an issue). Nothing happens until the user reviews it, optionally
 * edits it, and presses Confirm; the server checks permissions again then.
 */
export function ActionCard({ action, messageId }: { action: ProposedAction; messageId: string }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(action.fields.map((f) => [f.key, String(action.args[f.key] ?? "")])));
  const [state, setState] = useState<ProposedAction["status"]>(action.status);
  const [result, setResult] = useState(action.result ?? null);
  const [busy, setBusy] = useState(false);
  const editable = state === "proposed" || state === "failed";

  const confirm = async () => {
    setBusy(true);
    // Edited fields replace the proposal's; other arguments (like a thread id) are kept as proposed.
    const args: Record<string, unknown> = { ...action.args };
    for (const f of action.fields) {
      const v = values[f.key]?.trim() ?? "";
      if (v) args[f.key] = values[f.key];
      else delete args[f.key];
    }
    try {
      const res = await fetch("/api/connectors/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: action.action, args, confirm: true, ...(UUID.test(messageId) ? { messageId, proposalId: action.id } : {}) }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; summary?: string; url?: string | null; error?: { message?: string } } | null;
      if (body?.ok) {
        setState("done");
        setResult({ summary: body.summary ?? "Done.", url: body.url ?? null });
      } else {
        setState("failed");
        setResult({ summary: body?.summary ?? body?.error?.message ?? "That didn't work. Nothing was changed." });
      }
    } catch {
      setState("failed");
      setResult({ summary: "Orbis couldn't be reached. Nothing was changed." });
    } finally {
      setBusy(false);
    }
  };

  if (state === "dismissed") return null;
  return (
    <section className="s-in mt-4 rounded-2xl border border-s-line-strong p-4 text-[13.5px]" aria-label={`Proposed ${action.connectorName} action`}>
      <div className="flex items-center gap-2.5">
        <BrandIcon id={action.connectorId} size={28} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[12px] text-s-ink-3">
            <PenLine className="h-3 w-3" /> {state === "done" ? "Done" : "Prepared — needs your confirmation"} · {action.connectorName}
          </div>
          <p className="text-s-ink">{action.description}</p>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {action.fields.map((f) => (
          <label key={f.key} className="block">
            <span className="text-[11.5px] text-s-ink-3">{f.label}</span>
            {f.multiline ? (
              <textarea
                value={values[f.key] ?? ""}
                onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                readOnly={!editable}
                rows={Math.min(12, Math.max(3, (values[f.key] ?? "").split("\n").length + 1))}
                className="mt-0.5 block w-full resize-y rounded-lg border border-s-line bg-transparent px-2.5 py-1.5 text-[13px] leading-relaxed outline-none focus:border-s-line-strong read-only:opacity-80"
              />
            ) : (
              <input value={values[f.key] ?? ""} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} readOnly={!editable} className="mt-0.5 block h-9 w-full rounded-lg border border-s-line bg-transparent px-2.5 text-[13px] outline-none focus:border-s-line-strong read-only:opacity-80" />
            )}
          </label>
        ))}
      </div>
      {result && (
        <p className={cn("mt-3 flex items-start gap-1.5", state === "done" ? "text-s-ink" : "text-s-danger")} role="status">
          {state === "done" ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />}
          <span>
            {result.summary}{" "}
            {result.url && (
              <a href={result.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline">
                Open <ArrowUpRight className="h-3 w-3" />
              </a>
            )}
          </span>
        </p>
      )}
      {editable && (
        <p className="mt-3 text-[12px] text-s-ink-3">
          Nothing has been sent or changed in {action.connectorName} yet. Check and edit it above; Orbis does it only when you press Confirm.
        </p>
      )}
      {editable && (
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={() => void confirm()} disabled={busy} className="h-9 rounded-full bg-s-accent px-4 text-[13px] font-medium text-s-accent-ink disabled:opacity-50">
            {busy ? "Working…" : state === "failed" ? "Try again" : "Confirm"}
          </button>
          <button type="button" onClick={() => setState("dismissed")} disabled={busy} className="h-9 rounded-full px-3 text-[13px] text-s-ink-3 hover:bg-s-hover">
            Dismiss
          </button>
        </div>
      )}
    </section>
  );
}
