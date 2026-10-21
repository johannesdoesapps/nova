"use client";
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Pencil, Play, Plus, Sparkles, Trash2, X } from "lucide-react";
import { MAX_CONTENT, MEMORY_KIND_LABELS, MEMORY_KINDS, workflowRequest, type MemoryEntry, type MemoryKind } from "@/lib/code/memory";
import { cn } from "@/lib/utils";
import { api, post } from "./api";

type Draft = { kind: MemoryKind; title: string; content: string; always: boolean };
const EMPTY: Draft = { kind: "instruction", title: "", content: "", always: false };

const GROUP_TITLES: Record<MemoryKind, string> = { instruction: "Instructions", architecture: "Architecture", decision: "Decisions", preference: "Preferences", workflow: "Workflows" };

/**
 * The project's memory: notes the agent reads before working here, and
 * workflows to start with one click. Suggestions from the agent wait here
 * for approval and aren't used until approved.
 */
export function MemoryPanel({ projectId, onRunWorkflow, version = 0 }: { projectId: string; onRunWorkflow: (request: string) => void; version?: number }) {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const base = `/api/code/projects/${projectId}/memory`;

  const load = useCallback(async () => {
    try {
      const r = await api<{ memory: MemoryEntry[] }>(base);
      setEntries(r.memory);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base]);
  useEffect(() => {
    let alive = true;
    api<{ memory: MemoryEntry[] }>(base)
      .then((r) => alive && (setEntries(r.memory), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [base, version]);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setNote(null);
    try {
      await fn();
      await load();
      setNote(done);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const save = () => {
    if (!editing) return;
    const d = editing.draft;
    const body = { kind: d.kind, title: d.title.trim(), content: d.content.trim(), always: d.always };
    void act(
      "save",
      async () => {
        if (editing.id) await api(`${base}/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
        else await post(base, body);
        setEditing(null);
      },
      editing.id ? "Saved." : "Added to project memory.",
    );
  };

  const proposed = (entries ?? []).filter((e) => e.status === "proposed");
  const active = (entries ?? []).filter((e) => e.status === "active");

  return (
    <div className="s-scroll flex h-full flex-col overflow-y-auto p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold">Project memory</h2>
          <p className="mt-0.5 text-[12.5px] leading-snug text-s-ink-3">
            What the agent should know here. Instructions and notes marked “every task” are always given to it; the rest when they match the request.
          </p>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing({ id: null, draft: EMPTY })}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-s-accent px-3 text-[12.5px] font-medium text-s-accent-ink hover:brightness-110"
          >
            <Plus className="h-3.5 w-3.5" /> Add note
          </button>
        )}
      </div>

      {note && (
        <p role="status" className="mt-3 rounded-lg bg-s-hover px-3 py-2 text-[12.5px] text-s-ink-2">
          {note}
        </p>
      )}

      {editing && <NoteForm draft={editing.draft} isNew={!editing.id} busy={busy === "save"} onChange={(draft) => setEditing({ ...editing, draft })} onSave={save} onCancel={() => setEditing(null)} />}

      {error ? (
        <p role="alert" className="mt-6 text-[13px] text-s-ink-3">
          Memory couldn’t load: {error}{" "}
          <button type="button" onClick={() => void load()} className="text-s-ink underline-offset-4 hover:underline">
            Try again
          </button>
        </p>
      ) : entries === null ? (
        <div className="mt-6 space-y-3" role="status" aria-label="Loading memory">
          {[70, 85, 55].map((w, i) => (
            <div key={i} className="s-skeleton h-4" style={{ width: `${w}%` }} />
          ))}
        </div>
      ) : (
        <>
          {proposed.length > 0 && (
            <section aria-labelledby="mem-proposed" className="mt-5">
              <h3 id="mem-proposed" className="flex items-center gap-1.5 text-[12px] font-medium uppercase tracking-[0.08em] text-s-ink-3">
                <Sparkles className="h-3.5 w-3.5" /> Suggested by the agent
              </h3>
              <p className="mt-1 text-[12px] text-s-ink-3">Not used until you approve.</p>
              <ul className="mt-2 flex flex-col gap-2">
                {proposed.map((e) => (
                  <li key={e.id} className="rounded-xl border border-dashed border-s-line-strong p-3">
                    <Entry e={e} />
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <SmallButton
                        onClick={() => void act(e.id, () => api(`${base}/${e.id}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }), `Approved “${e.title}”.`)}
                        busy={busy === e.id}
                        primary
                      >
                        <Check className="h-3.5 w-3.5" /> Approve
                      </SmallButton>
                      <SmallButton onClick={() => setEditing({ id: e.id, draft: { kind: e.kind, title: e.title, content: e.content, always: e.always } })}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </SmallButton>
                      <SmallButton
                        onClick={() => void act(e.id, () => api(`${base}/${e.id}`, { method: "DELETE" }), "Suggestion dismissed.")}
                        busy={busy === e.id}
                        label={`Dismiss suggestion: ${e.title}`}
                      >
                        <X className="h-3.5 w-3.5" /> Dismiss
                      </SmallButton>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {active.length === 0 && !editing ? (
            <div className="mt-6 rounded-xl border border-dashed border-s-line-strong p-4 text-[13px] leading-relaxed text-s-ink-3">
              <p>No notes yet. Good first notes:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                <li>How to run and test this project (“Tests: npm test. Lint: npm run lint.”)</li>
                <li>Style you want kept (“Use TypeScript, no default exports.”)</li>
                <li>A workflow you repeat (“Add a page: create it, link it in the nav, test on phone size.”)</li>
              </ul>
              <p className="mt-2">The agent may also suggest notes while it works.</p>
            </div>
          ) : (
            MEMORY_KINDS.map((k) => {
              const list = active.filter((e) => e.kind === k);
              if (!list.length) return null;
              return (
                <section key={k} aria-labelledby={`mem-${k}`} className="mt-5">
                  <h3 id={`mem-${k}`} className="text-[12px] font-medium uppercase tracking-[0.08em] text-s-ink-3">
                    {GROUP_TITLES[k]}
                  </h3>
                  <ul className="mt-2 flex flex-col gap-2">
                    {list.map((e) => (
                      <li key={e.id} className="group rounded-xl border border-s-line p-3">
                        <Entry e={e} />
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {k === "workflow" && (
                            <SmallButton onClick={() => onRunWorkflow(workflowRequest(e))} primary label={`Use workflow: ${e.title}`}>
                              <Play className="h-3.5 w-3.5" /> Use
                            </SmallButton>
                          )}
                          <SmallButton onClick={() => setEditing({ id: e.id, draft: { kind: e.kind, title: e.title, content: e.content, always: e.always } })} label={`Edit: ${e.title}`}>
                            <Pencil className="h-3.5 w-3.5" /> Edit
                          </SmallButton>
                          <SmallButton
                            onClick={() => {
                              if (confirm(`Delete “${e.title}” from project memory?`)) void act(e.id, () => api(`${base}/${e.id}`, { method: "DELETE" }), "Deleted.");
                            }}
                            busy={busy === e.id}
                            label={`Delete: ${e.title}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" /> Delete
                          </SmallButton>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })
          )}
        </>
      )}
    </div>
  );
}

function Entry({ e }: { e: MemoryEntry }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[13.5px] font-medium">{e.title}</span>
        {e.always && <span className="rounded-full bg-s-hover px-2 py-0.5 text-[11px] text-s-ink-2">Every task</span>}
        {e.source === "agent" && e.status === "active" && <span className="rounded-full bg-s-hover px-2 py-0.5 text-[11px] text-s-ink-3">From the agent</span>}
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed text-s-ink-2">{e.content}</p>
    </div>
  );
}

function SmallButton({ children, onClick, busy, primary, label }: { children: React.ReactNode; onClick: () => void; busy?: boolean; primary?: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-label={label}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] transition disabled:opacity-50",
        primary ? "bg-s-accent font-medium text-s-accent-ink hover:brightness-110" : "border border-s-line text-s-ink-2 hover:border-s-line-strong hover:text-s-ink",
      )}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : children}
    </button>
  );
}

function NoteForm({ draft, isNew, busy, onChange, onSave, onCancel }: { draft: Draft; isNew: boolean; busy: boolean; onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void }) {
  const valid = draft.title.trim() && draft.content.trim();
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault();
        if (valid) onSave();
      }}
      className="mt-4 rounded-xl border border-s-line-strong p-3"
      aria-label={isNew ? "New note" : "Edit note"}
    >
      <label className="block text-[12px] font-medium text-s-ink-3" htmlFor="mem-kind">
        Type
      </label>
      <select
        id="mem-kind"
        value={draft.kind}
        onChange={(e) => onChange({ ...draft, kind: e.target.value as MemoryKind })}
        className="mt-1 h-8 w-full rounded-lg border border-s-line bg-transparent px-2 text-[13px] outline-none focus:border-s-line-strong"
      >
        {MEMORY_KINDS.map((k) => (
          <option key={k} value={k}>
            {MEMORY_KIND_LABELS[k].label}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11.5px] text-s-ink-3">{MEMORY_KIND_LABELS[draft.kind].hint}</p>
      <label className="mt-3 block text-[12px] font-medium text-s-ink-3" htmlFor="mem-title">
        Title
      </label>
      <input
        id="mem-title"
        value={draft.title}
        maxLength={120}
        onChange={(e) => onChange({ ...draft, title: e.target.value })}
        className="mt-1 h-8 w-full rounded-lg border border-s-line bg-transparent px-2 text-[13px] outline-none focus:border-s-line-strong"
      />
      <label className="mt-3 block text-[12px] font-medium text-s-ink-3" htmlFor="mem-content">
        {draft.kind === "workflow" ? "Steps (this becomes the agent's request)" : "Note"}
      </label>
      <textarea
        id="mem-content"
        value={draft.content}
        maxLength={MAX_CONTENT}
        rows={5}
        onChange={(e) => onChange({ ...draft, content: e.target.value })}
        className="s-scroll mt-1 w-full resize-y rounded-lg border border-s-line bg-transparent px-2 py-1.5 text-[13px] leading-relaxed outline-none focus:border-s-line-strong"
      />
      {draft.kind !== "instruction" && draft.kind !== "workflow" && (
        <label className="mt-2 flex items-center gap-2 text-[12.5px] text-s-ink-2">
          <input type="checkbox" checked={draft.always} onChange={(e) => onChange({ ...draft, always: e.target.checked })} />
          Give to the agent on every task
        </label>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          disabled={!valid || busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-full bg-s-accent px-3.5 text-[12.5px] font-medium text-s-accent-ink disabled:opacity-50"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {isNew ? "Add" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="h-8 rounded-full px-3 text-[12.5px] text-s-ink-2 hover:bg-s-hover">
          Cancel
        </button>
      </div>
    </form>
  );
}
