"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { FolderKanban, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { Button, Card, EmptyState, Input, Notice, PageHeader, Textarea } from "@/components/ui/primitives";
import { jsonFetch } from "@/hooks/use-ndjson";
import { relativeTime } from "@/lib/utils";

export interface ProjectItem {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

const EXAMPLES = ["Startup Research", "AI Model Evaluation", "University Research", "Competitor Analysis", "Product Development"];

export function ProjectsView({ initial }: { initial: ProjectItem[] }) {
  const router = useRouter();
  const { refreshRecents } = useApp();
  const [projects, setProjects] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const create = async (n = name) => {
    if (!n.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await jsonFetch<{ project: ProjectItem }>("/api/projects", { method: "POST", body: JSON.stringify({ name: n.trim(), description: desc.trim() || null }) });
      setProjects((p) => [r.project, ...p]);
      setName("");
      setDesc("");
      setCreating(false);
      void refreshRecents();
      router.push(`/projects/${r.project.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this project? Its notes are deleted; linked chats and searches are kept but unlinked.")) return;
    try {
      await jsonFetch(`/api/projects/${id}`, { method: "DELETE" });
      setProjects((p) => p.filter((x) => x.id !== id));
      void refreshRecents();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const rename = async (id: string, newName: string) => {
    setEditing(null);
    const n = newName.trim();
    if (!n) return;
    try {
      const r = await jsonFetch<{ project: ProjectItem }>(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ name: n }) });
      setProjects((p) => p.map((x) => (x.id === id ? r.project : x)));
      void refreshRecents();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const shown = projects.filter((p) => !filter || `${p.name} ${p.description ?? ""}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader
        title="Research Projects"
        description="Containers for the conversations, searches, comparisons and notes that belong together."
        actions={<Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New project</Button>}
      />
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}

      {creating && (
        <Card className="mb-4 p-4">
          <form onSubmit={(e) => { e.preventDefault(); void create(); }} className="space-y-3">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Project name" aria-label="Project name" />
            <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} rows={2} placeholder="What is this project about? (optional)" aria-label="Description" />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
              <Button type="submit" loading={busy} disabled={!name.trim()}>Create</Button>
            </div>
          </form>
        </Card>
      )}

      {projects.length > 0 && (
        <div className="relative mb-4 max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter projects" className="pl-9" aria-label="Filter projects" />
        </div>
      )}

      {projects.length === 0 ? (
        <EmptyState
          icon={<FolderKanban className="h-8 w-8" />}
          title="No projects yet"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((e) => (
                <Button key={e} variant="secondary" size="sm" disabled={busy} onClick={() => void create(e)}>
                  <Plus className="h-3.5 w-3.5" /> {e}
                </Button>
              ))}
            </div>
          }
        >
          Start one from a template, or save a search, chat answer or comparison straight into a new project.
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((p) => (
            <Card key={p.id} className="group flex flex-col p-4 transition hover:border-accent/40">
              {editing === p.id ? (
                <form onSubmit={(e) => { e.preventDefault(); void rename(p.id, (e.currentTarget.elements.namedItem("n") as HTMLInputElement).value); }}>
                  <Input name="n" autoFocus defaultValue={p.name} maxLength={120} onBlur={(e) => void rename(p.id, e.target.value)} aria-label="Project name" />
                </form>
              ) : (
                <Link href={`/projects/${p.id}`} className="font-medium hover:text-accent">{p.name}</Link>
              )}
              <p className="mt-1 line-clamp-2 flex-1 text-sm text-muted">{p.description || "No description"}</p>
              <div className="mt-3 flex items-center text-xs text-faint">
                Updated {relativeTime(p.updated_at)} · created {new Date(p.created_at).toLocaleDateString()}
                <span className="ml-auto flex opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                  <button className="grid h-7 w-7 place-items-center rounded hover:text-fg" onClick={() => setEditing(p.id)} aria-label="Rename"><Pencil className="h-3.5 w-3.5" /></button>
                  <button className="grid h-7 w-7 place-items-center rounded hover:text-danger" onClick={() => void remove(p.id)} aria-label="Delete"><Trash2 className="h-3.5 w-3.5" /></button>
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
