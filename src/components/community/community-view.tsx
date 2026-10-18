"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Flag, GitFork, Search, Share2, X } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { Badge, Button, Card, EmptyState, Input, Notice, PageHeader, Select, Textarea } from "@/components/ui/primitives";
import { engine, useEngine } from "@/components/engine/api";
import { EngineError } from "@/components/engine/engine-error";
import { relativeTime } from "@/lib/utils";

interface Post { id: string; kind: string; title: string; description: string; author_name: string; license: string; forks: number; created_at: string; example?: boolean }
interface FullPost extends Post { content: Record<string, unknown>; injection_warnings?: string[] }
const KIND_LABEL: Record<string, string> = { workflow_template: "Workflow template", watch_template: "Radar watch", collection: "Knowledge collection" };

export function CommunityView() {
  const router = useRouter();
  const { user } = useApp();
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const list = useEngine<{ posts: Post[] }>(`community?${new URLSearchParams({ ...(kind && { kind }), ...(query && { q: query }) })}`);
  const [open, setOpen] = useState<FullPost | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [msg, setMsg] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const fork = async (p: FullPost, workspaceId?: string) => {
    try {
      const r = await engine.post<{ workflow_id?: string; watch_id?: string; workspace_id?: string }>(`community/${p.id}/fork`, { workspace_id: workspaceId });
      if (r.workflow_id) router.push(`/lab/workflows/${r.workflow_id}`);
      else if (r.watch_id) router.push("/radar");
      else if (r.workspace_id) router.push(`/workspaces/${r.workspace_id}`);
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    }
  };
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Community" description="Reusable workflow templates, Radar watches and knowledge collections shared by NOVA AI users. Forking makes your own copy; nothing runs or connects automatically." actions={<Button onClick={() => setPublishing(true)}><Share2 className="h-4 w-4" /> Publish</Button>} />
      {list.error && <div className="mb-4"><EngineError message={list.error} /></div>}
      {msg && <Notice tone={msg.tone} className="mb-4">{msg.text}</Notice>}
      {publishing && <Publish signedIn={Boolean(user)} onClose={() => setPublishing(false)} onDone={(t) => { setPublishing(false); setMsg({ tone: "success", text: t }); void list.reload(); }} />}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind"><option value="">Everything</option>{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <form onSubmit={(e) => { e.preventDefault(); setQuery(q); }} className="flex gap-2"><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="h-9" aria-label="Search" /><Button variant="secondary" type="submit"><Search className="h-4 w-4" /></Button></form>
      </div>
      {list.data?.posts.length === 0 && <EmptyState title="Nothing found" />}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {list.data?.posts.map((p) => (
          <button key={p.id} type="button" onClick={async () => setOpen(await engine.get(`community/${p.id}`))} className="flex flex-col rounded-2xl border border-border bg-panel p-4 text-left hover:border-border-strong">
            <div className="flex flex-wrap items-center gap-1.5"><Badge tone="accent">{KIND_LABEL[p.kind]}</Badge>{p.example && <Badge>built-in example</Badge>}<Badge>{p.license}</Badge></div>
            <div className="mt-2 font-medium">{p.title}</div>
            <p className="mt-1 line-clamp-3 flex-1 text-sm text-muted">{p.description}</p>
            <div className="mt-2 text-xs text-faint">{p.author_name} · {relativeTime(p.created_at)} · {p.forks} fork(s)</div>
          </button>
        ))}
      </div>
      {open && <PostDialog p={open} onClose={() => setOpen(null)} onFork={fork} onReport={async (reason) => { try { await engine.post(`community/${open.id}/report`, { reason }); setMsg({ tone: "success", text: "Thanks — reported for review. Posts with several reports are hidden until reviewed." }); setOpen(null); } catch (e) { setMsg({ tone: "danger", text: (e as Error).message }); } }} />}
    </div>
  );
}

function PostDialog({ p, onClose, onFork, onReport }: { p: FullPost; onClose: () => void; onFork: (p: FullPost, ws?: string) => void; onReport: (reason: string) => void }) {
  const ws = useEngine<{ workspaces: { id: string; name: string; role: string }[] }>(p.kind === "collection" ? "workspaces" : null);
  const [target, setTarget] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={p.title} onClick={onClose}>
      <Card className="max-h-[85vh] w-full max-w-2xl space-y-3 overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2"><div><Badge tone="accent">{KIND_LABEL[p.kind]}</Badge><div className="mt-1 text-lg font-semibold">{p.title}</div><div className="text-xs text-faint">by {p.author_name} · {p.license}</div></div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button></div>
        <p className="text-sm text-muted">{p.description}</p>
        {p.injection_warnings && p.injection_warnings.length > 0 && <Notice tone="warning">This content contains instruction-like text ({p.injection_warnings.join(", ")}). If you fork it, it is treated as untrusted data.</Notice>}
        <pre className="max-h-72 overflow-auto rounded-lg bg-bg-elev p-3 text-[11px] text-muted">{JSON.stringify(p.content, null, 2)}</pre>
        <div className="flex flex-wrap items-center gap-2">
          {p.kind === "collection" && <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Workspace"><option value="">Choose a workspace…</option>{ws.data?.workspaces.filter((w) => ["owner", "admin", "editor"].includes(w.role)).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}
          <Button onClick={() => onFork(p, target || undefined)} disabled={p.kind === "collection" && !target}><GitFork className="h-4 w-4" /> Fork into my account</Button>
          {!p.example && <Button variant="ghost" onClick={() => { const r = window.prompt("Why are you reporting this?"); if (r) onReport(r); }}><Flag className="h-4 w-4" /> Report</Button>}
        </div>
        <p className="text-[11px] text-faint">Forked workflows land as drafts: review steps and permissions, then publish. Approvals for consequential actions always apply.</p>
      </Card>
    </div>
  );
}

function Publish({ signedIn, onClose, onDone }: { signedIn: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const wfs = useEngine<{ workflows: { id: string; name: string }[] }>("lab/workflows");
  const watches = useEngine<{ watches: { id: string; name: string }[] }>("radar/watches");
  const spaces = useEngine<{ workspaces: { id: string; name: string; role: string }[] }>("workspaces");
  const [kind, setKind] = useState("workflow_template");
  const [source, setSource] = useState("");
  const [wsId, setWsId] = useState("");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [license, setLicense] = useState("CC-BY-4.0");
  const [err, setErr] = useState<string | null>(null);
  const [needsAck, setNeedsAck] = useState(false);
  const collections = useEngine<{ collections: { id: string; name: string }[] }>(kind === "collection" && wsId ? `workspaces/${wsId}` : null);
  const go = async (ack = false) => {
    setErr(null);
    try {
      await engine.post("community", { kind, source_id: source, title, description: desc, license, workspace_id: wsId || undefined, acknowledge_sensitive: ack });
      onDone(`Published “${title}”. You can unpublish it at any time.`);
    } catch (e) {
      const m = (e as Error).message;
      setErr(m);
      setNeedsAck(/appears to contain/.test(m));
    }
  };
  if (!signedIn) return <Notice tone="warning" className="mb-4" title="Sign in to publish">Publishing requires an account so contributions have an accountable author. <button className="text-accent" onClick={onClose}>Close</button></Notice>;
  return (
    <Card className="mb-5 space-y-3 border-accent/40 p-4">
      <div className="flex items-center justify-between"><div className="font-medium">Publish to the community</div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button></div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Select value={kind} onChange={(e) => { setKind(e.target.value); setSource(""); }} aria-label="Kind">{Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        {kind === "workflow_template" && <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Workflow"><option value="">Choose a workflow…</option>{wfs.data?.workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}
        {kind === "watch_template" && <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Watch"><option value="">Choose a watch…</option>{watches.data?.watches.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}
        {kind === "collection" && <Select value={wsId} onChange={(e) => setWsId(e.target.value)} aria-label="Workspace"><option value="">Workspace…</option>{spaces.data?.workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select>}
        {kind === "collection" && wsId && <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Collection"><option value="">Collection…</option>{collections.data?.collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>}
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="h-9" aria-label="Title" />
        <Select value={license} onChange={(e) => setLicense(e.target.value)} aria-label="License">{["CC-BY-4.0", "CC0-1.0", "MIT", "All rights reserved"].map((l) => <option key={l}>{l}</option>)}</Select>
      </div>
      <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} placeholder="What it does and when to use it" aria-label="Description" />
      <p className="text-[11px] text-faint">A snapshot is published (later edits don&apos;t leak). Personal defaults like recipient addresses are stripped from workflow templates, and content is scanned for emails, phone numbers, card numbers and API keys before it goes public.</p>
      {err && <Notice tone="warning">{err}</Notice>}
      <div className="flex gap-2"><Button onClick={() => go(false)} disabled={!source || title.length < 3}>Publish</Button>{needsAck && <Button variant="danger" onClick={() => go(true)}>I&apos;ve checked — publish anyway</Button>}</div>
    </Card>
  );
}
