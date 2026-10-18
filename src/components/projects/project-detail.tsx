"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowLeft, FileText, MessageSquare, Pencil, Plus, Search, StickyNote, Swords, Trash2 } from "lucide-react";
import { Markdown } from "@/components/common/markdown";
import { useApp } from "@/components/layout/app-context";
import { Badge, Button, Card, EmptyState, Input, Notice, Textarea } from "@/components/ui/primitives";
import { jsonFetch } from "@/hooks/use-ndjson";
import { relativeTime } from "@/lib/utils";

interface Data {
  project: { id: string; name: string; description: string | null; created_at: string; updated_at: string };
  conversations: { id: string; title: string; mode: string; updated_at: string }[];
  searches: { id: string; query: string; answer: string | null; created_at: string }[];
  comparisons: { id: string; prompt: string; selected_models: string[]; comparison_metadata: { preferredModelId?: string | null }; created_at: string }[];
  notes: { id: string; title: string; content: string; source_type: string; created_at: string }[];
}

type Tab = "all" | "notes" | "searches" | "chats" | "comparisons";

export function ProjectDetail({ initial }: { initial: Data }) {
  const router = useRouter();
  const { refreshRecents } = useApp();
  const [data, setData] = useState(initial);
  const [tab, setTab] = useState<Tab>("all");
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(initial.project.name);
  const [desc, setDesc] = useState(initial.project.description ?? "");
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteTitle, setNoteTitle] = useState("");
  const [noteBody, setNoteBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openNote, setOpenNote] = useState<string | null>(null);

  const match = (s: string | null | undefined) => !q || (s ?? "").toLowerCase().includes(q.toLowerCase());
  const filtered = useMemo(
    () => ({
      notes: data.notes.filter((n) => match(n.title) || match(n.content)),
      searches: data.searches.filter((s) => match(s.query) || match(s.answer)),
      chats: data.conversations.filter((c) => match(c.title)),
      comparisons: data.comparisons.filter((c) => match(c.prompt)),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, q],
  );

  const saveMeta = async () => {
    setBusy(true);
    try {
      const r = await jsonFetch<{ project: Data["project"] }>(`/api/projects/${data.project.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), description: desc.trim() || null }),
      });
      setData((d) => ({ ...d, project: r.project }));
      setEditing(false);
      void refreshRecents();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addNote = async () => {
    setBusy(true);
    try {
      const r = await jsonFetch<{ note: Data["notes"][number] }>(`/api/projects/${data.project.id}/notes`, {
        method: "POST",
        body: JSON.stringify({ title: noteTitle.trim(), content: noteBody, sourceType: "note" }),
      });
      setData((d) => ({ ...d, notes: [r.note, ...d.notes] }));
      setNoteTitle("");
      setNoteBody("");
      setNoteOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const deleteNote = async (id: string) => {
    try {
      await jsonFetch(`/api/notes/${id}`, { method: "DELETE" });
      setData((d) => ({ ...d, notes: d.notes.filter((n) => n.id !== id) }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const deleteProject = async () => {
    if (!confirm("Delete this project? Notes are deleted; chats, searches and comparisons are kept but unlinked.")) return;
    await jsonFetch(`/api/projects/${data.project.id}`, { method: "DELETE" });
    void refreshRecents();
    router.push("/projects");
  };

  const counts = { notes: filtered.notes.length, searches: filtered.searches.length, chats: filtered.chats.length, comparisons: filtered.comparisons.length };
  const show = (t: Tab) => tab === "all" || tab === t;

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-8 sm:px-6">
      <Link href="/projects" className="mb-4 inline-flex items-center gap-1 text-sm text-faint hover:text-fg"><ArrowLeft className="h-4 w-4" /> Projects</Link>
      {error && <Notice tone="danger" className="mb-4">{error}</Notice>}

      {editing ? (
        <Card className="mb-6 space-y-3 p-4">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Project name" />
          <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} rows={2} placeholder="Description" aria-label="Description" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            <Button onClick={saveMeta} loading={busy} disabled={!name.trim()}>Save</Button>
          </div>
        </Card>
      ) : (
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{data.project.name}</h1>
            {data.project.description && <p className="mt-1 max-w-2xl text-sm text-muted">{data.project.description}</p>}
            <p className="mt-2 text-xs text-faint">Created {new Date(data.project.created_at).toLocaleDateString()} · updated {relativeTime(data.project.updated_at)}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
            <Button variant="danger" size="sm" onClick={() => void deleteProject()}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex flex-wrap gap-1 rounded-xl border border-border bg-panel p-1">
          {(["all", "notes", "searches", "chats", "comparisons"] as Tab[]).map((t) => (
            <button key={t} onClick={() => setTab(t)} aria-pressed={tab === t} className={`rounded-lg px-3 py-1 text-xs capitalize ${tab === t ? "bg-accent-soft text-fg" : "text-muted hover:text-fg"}`}>
              {t}
              {t !== "all" && <span className="ml-1 text-faint">{counts[t]}</span>}
            </button>
          ))}
        </div>
        <div className="relative sm:ml-auto sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved material" className="h-9 pl-9" aria-label="Search saved material" />
        </div>
        <Button size="sm" onClick={() => setNoteOpen(true)}><Plus className="h-3.5 w-3.5" /> Note</Button>
      </div>

      {noteOpen && (
        <Card className="mb-4 space-y-3 p-4">
          <Input autoFocus value={noteTitle} onChange={(e) => setNoteTitle(e.target.value)} placeholder="Note title" maxLength={200} aria-label="Note title" />
          <Textarea value={noteBody} onChange={(e) => setNoteBody(e.target.value)} rows={5} placeholder="Write in Markdown…" maxLength={100000} aria-label="Note content" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNoteOpen(false)}>Cancel</Button>
            <Button onClick={addNote} loading={busy} disabled={!noteTitle.trim() || !noteBody.trim()}>Add note</Button>
          </div>
        </Card>
      )}

      <div className="space-y-6">
        {show("notes") && (
          <Section title="Notes & saved answers" icon={<StickyNote className="h-4 w-4" />} empty={filtered.notes.length === 0} emptyText="Save chat answers or add notes here.">
            {filtered.notes.map((n) => (
              <Card key={n.id} className="p-4">
                <div className="flex items-start gap-2">
                  <button className="min-w-0 flex-1 text-left" onClick={() => setOpenNote(openNote === n.id ? null : n.id)} aria-expanded={openNote === n.id}>
                    <div className="flex items-center gap-2"><FileText className="h-4 w-4 shrink-0 text-faint" /><span className="truncate font-medium">{n.title}</span><Badge>{n.source_type}</Badge></div>
                    {openNote !== n.id && <p className="mt-1 line-clamp-2 text-sm text-muted">{n.content.replace(/[#*`>]/g, "")}</p>}
                  </button>
                  <span className="shrink-0 text-xs text-faint">{relativeTime(n.created_at)}</span>
                  <button className="text-faint hover:text-danger" onClick={() => void deleteNote(n.id)} aria-label="Delete note"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
                {openNote === n.id && <div className="mt-3 border-t border-border pt-3"><Markdown text={n.content} /></div>}
              </Card>
            ))}
          </Section>
        )}
        {show("searches") && (
          <Section title="Searches" icon={<Search className="h-4 w-4" />} empty={filtered.searches.length === 0} emptyText="Use “Save to project” on an AI Search answer.">
            {filtered.searches.map((s) => (
              <Link key={s.id} href={`/search?q=${encodeURIComponent(s.query)}`}>
                <Card className="p-4 hover:border-accent/40">
                  <div className="flex justify-between gap-3"><span className="font-medium">{s.query}</span><span className="shrink-0 text-xs text-faint">{relativeTime(s.created_at)}</span></div>
                  {s.answer && <p className="mt-1 line-clamp-2 text-sm text-muted">{s.answer.replace(/[#*`>]|\[\d+\]/g, "")}</p>}
                </Card>
              </Link>
            ))}
          </Section>
        )}
        {show("chats") && (
          <Section title="Conversations" icon={<MessageSquare className="h-4 w-4" />} empty={filtered.chats.length === 0} emptyText="Conversations moved into this project appear here.">
            {filtered.chats.map((c) => (
              <Link key={c.id} href={`/chat?c=${c.id}`}>
                <Card className="flex items-center justify-between gap-3 p-4 hover:border-accent/40"><span className="truncate">{c.title}</span><span className="flex shrink-0 items-center gap-2 text-xs text-faint"><Badge>{c.mode}</Badge>{relativeTime(c.updated_at)}</span></Card>
              </Link>
            ))}
          </Section>
        )}
        {show("comparisons") && (
          <Section title="Model comparisons" icon={<Swords className="h-4 w-4" />} empty={filtered.comparisons.length === 0} emptyText="Save a Model Battle result to this project.">
            {filtered.comparisons.map((c) => (
              <Card key={c.id} className="p-4">
                <div className="flex justify-between gap-3"><span className="line-clamp-1 font-medium">{c.prompt}</span><span className="shrink-0 text-xs text-faint">{relativeTime(c.created_at)}</span></div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {c.selected_models.map((m) => <Badge key={m} tone={c.comparison_metadata?.preferredModelId === m ? "accent" : "default"}>{m}{c.comparison_metadata?.preferredModelId === m ? " · preferred" : ""}</Badge>)}
                </div>
              </Card>
            ))}
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, icon, empty, emptyText, children }: { title: string; icon: React.ReactNode; empty: boolean; emptyText: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-muted"><span className="text-faint">{icon}</span>{title}</h2>
      {empty ? <EmptyState title="Nothing here yet">{emptyText}</EmptyState> : <div className="space-y-2">{children}</div>}
    </section>
  );
}
