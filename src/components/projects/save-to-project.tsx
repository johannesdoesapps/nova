"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Bookmark, Check, FolderKanban, Plus } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import { useApp } from "@/components/layout/app-context";
import { Button, Input, Spinner } from "@/components/ui/primitives";

interface P {
  id: string;
  name: string;
}

/**
 * "Save to project" popover. `onSave` performs the actual save for the given
 * project id (attach search, add note, save comparison…).
 */
export function SaveToProject({ onSave, label = "Save", disabled }: { onSave: (projectId: string) => Promise<void>; label?: string; disabled?: boolean }) {
  const { user, integrations, refreshRecents } = useApp();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<P[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !user) return;
    jsonFetch<{ projects: P[] }>("/api/projects")
      .then((r) => setProjects(r.projects))
      .catch((e: Error) => setError(e.message));
  }, [open, user]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const save = async (id: string, name: string) => {
    setBusy(id);
    setError(null);
    try {
      await onSave(id);
      setSaved(name);
      setOpen(false);
      void refreshRecents();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy("new");
    try {
      const r = await jsonFetch<{ project: P }>("/api/projects", { method: "POST", body: JSON.stringify({ name }) });
      setNewName("");
      setProjects((p) => [r.project, ...(p ?? [])]);
      await save(r.project.id, r.project.name);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="relative" ref={ref}>
      <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} disabled={disabled} aria-expanded={open}>
        {saved ? <Check className="h-3.5 w-3.5 text-success" /> : <Bookmark className="h-3.5 w-3.5" />}
        {saved ? `Saved to ${saved}` : label}
      </Button>
      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-xl border border-border-strong bg-panel p-2 shadow-2xl sm:bottom-auto sm:top-full sm:mb-0 sm:mt-2">
          {!integrations.supabase ? (
            <p className="p-2 text-sm text-muted">
              Saving needs Supabase. Add <code className="font-mono text-fg">NEXT_PUBLIC_SUPABASE_URL</code> and the publishable key.
            </p>
          ) : !user ? (
            <p className="p-2 text-sm text-muted">
              <Link href="/login" className="text-accent hover:underline">Sign in</Link> to save to a project.
            </p>
          ) : (
            <>
              <div className="px-2 pb-1 pt-1 text-xs font-medium text-faint">Save to project</div>
              <div className="max-h-56 overflow-y-auto">
                {projects === null ? (
                  <div className="p-3"><Spinner /></div>
                ) : projects.length === 0 ? (
                  <p className="px-2 py-2 text-sm text-faint">No projects yet. Create one below.</p>
                ) : (
                  projects.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => save(p.id, p.name)}
                      disabled={busy !== null}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-50"
                    >
                      {busy === p.id ? <Spinner className="h-3.5 w-3.5" /> : <FolderKanban className="h-3.5 w-3.5 text-faint" />}
                      <span className="truncate">{p.name}</span>
                    </button>
                  ))
                )}
              </div>
              <form
                className="mt-1 flex gap-1.5 border-t border-border pt-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void create();
                }}
              >
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New project name" aria-label="New project name" maxLength={120} className="h-8 text-xs" />
                <Button size="sm" type="submit" loading={busy === "new"} disabled={!newName.trim()} aria-label="Create project">
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </form>
            </>
          )}
          {error && <p role="alert" className="px-2 pt-2 text-xs text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}

export async function saveNote(projectId: string, note: { title: string; content: string; sourceType: "chat" | "search" | "comparison" | "note"; sourceRef?: string | null }) {
  await jsonFetch(`/api/projects/${projectId}/notes`, { method: "POST", body: JSON.stringify(note) });
}
