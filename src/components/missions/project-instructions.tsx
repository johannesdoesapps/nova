"use client";
import { useState } from "react";
import { useProjectContext } from "@/components/studio/project-chip";
import { Switch } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";

const MAX = 2000;

/**
 * A project's saved instructions for the AI, and what its chats may use.
 * Visible and editable here; shared only with this project's own chats.
 */
export function ProjectInstructions({ projectId, initial, noteCount, onSaved }: { projectId: string; initial: string; noteCount: number; onSaved: (text: string | null) => void }) {
  const [text, setText] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ctx = useProjectContext(projectId);
  const settings = ctx.view?.settings ?? null;

  const save = async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const v = value.trim();
      await jsonFetch(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify({ description: v || null }) });
      setSaved(v);
      setText(v);
      setEditing(false);
      onSaved(v || null);
      ctx.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (patch: { instructions?: boolean; notes?: boolean }) => {
    setError(null);
    try {
      await ctx.update(patch);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section id="instructions" className="scroll-mt-4">
      <h2 className="mb-2 text-[12.5px] font-medium uppercase tracking-[0.1em] text-s-ink-3">Instructions for the AI</h2>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save(text);
          }}
        >
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, MAX))}
            rows={6}
            autoFocus
            aria-label="Instructions for the AI"
            placeholder="e.g. Write for a non-technical audience. Our product is called Acme. Prices are in euros."
            className="glass w-full rounded-2xl px-3 py-2 text-[13.5px] outline-none placeholder:text-s-ink-3"
          />
          <div className="mt-1.5 flex items-center gap-2">
            <button type="submit" disabled={busy || text.trim() === saved} className="h-8 rounded-lg bg-s-accent px-3 text-[12.5px] font-medium text-s-accent-ink disabled:opacity-40">
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setText(saved);
                setEditing(false);
              }}
              className="h-8 rounded-lg px-3 text-[12.5px] text-s-ink-2 hover:bg-s-hover"
            >
              Cancel
            </button>
            <span className="ml-auto text-[11.5px] text-s-ink-3">
              {text.length}/{MAX}
            </span>
          </div>
        </form>
      ) : saved ? (
        <div className="rounded-xl border border-s-line px-3 py-2">
          <p className="line-clamp-6 whitespace-pre-wrap text-[13px] text-s-ink-2">{saved}</p>
          <div className="mt-1.5 flex gap-3 text-[12px]">
            <button type="button" onClick={() => setEditing(true)} className="text-s-ink-2 underline-offset-4 hover:text-s-ink hover:underline">
              Edit
            </button>
            <button type="button" disabled={busy} onClick={() => void save("")} className="text-s-ink-3 underline-offset-4 hover:text-s-danger hover:underline disabled:opacity-50">
              Remove
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="w-full rounded-xl border border-dashed border-s-line-strong px-3 py-2.5 text-left text-[13px] text-s-ink-3 transition hover:bg-s-hover hover:text-s-ink"
        >
          Add instructions every chat in this project should follow…
        </button>
      )}

      <div className="mt-3 space-y-2 rounded-xl border border-s-line px-3 py-2.5 text-[12.5px]">
        <p className="text-s-ink-3">This project’s chats can use:</p>
        {ctx.error ? (
          <p className="text-s-danger">{ctx.error}</p>
        ) : !settings ? (
          <div className="s-skeleton h-8" />
        ) : (
          <>
            <label className="flex items-center justify-between gap-3">
              <span className="text-s-ink-2">The instructions above</span>
              <Switch checked={settings.instructions} onChange={(v) => void toggle({ instructions: v })} label="Share the instructions with this project's chats" />
            </label>
            <label className="flex items-center justify-between gap-3">
              <span className="text-s-ink-2">
                Notes <span className="text-s-ink-3">({noteCount ? `newest ${Math.min(noteCount, 10)} of ${noteCount}` : "none yet"})</span>
              </span>
              <Switch checked={settings.notes} onChange={(v) => void toggle({ notes: v })} label="Share the project's notes with this project's chats" />
            </label>
          </>
        )}
        <p className="text-[11.5px] leading-snug text-s-ink-3">Shared only with chats in this project, never with other projects or chats outside it. Tasks and their AI drafts are not shared.</p>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[12.5px] text-s-danger">
          {error}
        </p>
      )}
    </section>
  );
}
