"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Copy, Download, History, Link2, MessageSquare, Plus, RotateCcw, Trash2, UserPlus, X } from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, Notice, PageHeader, Select, Textarea } from "@/components/ui/primitives";
import { engine, useEngine } from "@/components/engine/api";
import { EngineError } from "@/components/engine/engine-error";
import { cn, isSafeHttpUrl, relativeTime } from "@/lib/utils";

const TYPES = ["note", "document", "research", "chat", "graph", "task", "workflow", "decision", "link", "dataset"] as const;
interface Item { id: string; type: string; title: string; current_version: number; updated_at: string; created_by: string; preview: string; comment_count: number; source: Record<string, unknown> | null }
interface Member { id: string; email: string; name: string | null; role: string; status: string; user_id: string | null }
interface Ws { id: string; name: string; description: string | null; visibility: string; role: string; permissions: Record<string, boolean>; members: Member[]; items: Item[]; collections: { id: string; name: string; description: string; item_ids: string[] }[]; shares: { id: string; item_id: string | null; role: string; created_at: string; expires_at: string | null }[] }
interface FullItem { id: string; type: string; title: string; data: Record<string, unknown>; current_version: number; role: string; source: Record<string, unknown> | null; versions: { version: number; title: string; author: string; change_note: string | null; created_at: string }[]; comments: { id: string; parent_id: string | null; author_name: string | null; body: string; resolved: boolean; created_at: string }[] }

export function WorkspaceDetail({ id }: { id: string }) {
  const router = useRouter();
  const ws = useEngine<Ws>(`workspaces/${id}`);
  const [tab, setTab] = useState<"items" | "members" | "collections" | "sharing" | "export">("items");
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (ws.error) return <div className="p-8"><EngineError message={ws.error} /></div>;
  const w = ws.data;
  if (!w) return <div className="p-8 text-sm text-muted">Loading…</div>;
  const can = (a: string) => Boolean(w.permissions[a]);
  const items = w.items.filter((i) => !filter || i.type === filter);
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await ws.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title={w.name} badge={<><Badge tone="accent">{w.role}</Badge><Badge>{w.visibility}</Badge></>} description={w.description || "Everything for this project in one place."} />
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-border">
        {(["items", "members", "collections", "sharing", "export"] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={cn("-mb-px shrink-0 border-b-2 px-3 py-2 text-sm capitalize", tab === t ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg")}>{t === "export" ? "Export & data" : t}</button>)}
      </div>
      {err && <Notice tone="danger" className="mb-4">{err}</Notice>}

      {tab === "items" && (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by type"><option value="">All types</option>{TYPES.map((t) => <option key={t}>{t}</option>)}</Select>
              {can("edit_items") && <NewItem onCreate={(payload) => run(async () => { const it = await engine.post<{ id: string }>(`workspaces/${id}/items`, payload); setOpen(it.id); })} />}
            </div>
            {items.length === 0 && <EmptyState title="Nothing here yet">Add notes, documents, tasks, decisions and links — or let AI Lab workflows and integrations save into this workspace.</EmptyState>}
            {items.map((i) => (
              <button key={i.id} type="button" onClick={() => setOpen(i.id)} className={cn("w-full rounded-xl border bg-panel p-3 text-left hover:border-border-strong", open === i.id ? "border-accent" : "border-border")}>
                <div className="flex flex-wrap items-center gap-1.5 text-xs"><Badge>{i.type}</Badge><span className="text-faint">v{i.current_version} · {relativeTime(i.updated_at)}</span>{i.comment_count > 0 && <span className="flex items-center gap-0.5 text-faint"><MessageSquare className="h-3 w-3" />{i.comment_count}</span>}{i.source?.connector ? <Badge tone="accent">synced from {String(i.source.connector)}</Badge> : null}{i.source?.untrusted ? <Badge tone="warning">external content</Badge> : null}</div>
                <div className="mt-1 font-medium">{i.title}</div>
                {i.preview && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{i.preview}</div>}
              </button>
            ))}
          </div>
          <div>{open ? <ItemPanel wid={id} itemId={open} canEdit={can("edit_items")} canComment={can("comment")} onChanged={() => ws.reload()} onDeleted={() => { setOpen(null); void ws.reload(); }} /> : <p className="text-sm text-faint">Select an item to read, edit, comment or see its history.</p>}</div>
        </div>
      )}

      {tab === "members" && <Members w={w} run={run} />}

      {tab === "collections" && (
        <div className="space-y-3">
          {can("manage_collections") && <NewCollection items={w.items} onCreate={(name, ids) => run(() => engine.post(`workspaces/${id}/collections`, { name, item_ids: ids }))} />}
          {w.collections.length === 0 && <p className="text-sm text-faint">Knowledge collections group items (e.g. “Key evidence”, “Decisions log”) so they can be shared, published or used as workflow context.</p>}
          {w.collections.map((c) => (
            <Card key={c.id} className="p-3">
              <div className="flex items-center gap-2"><span className="font-medium">{c.name}</span><Badge>{c.item_ids.length} items</Badge>{can("manage_collections") && <Button size="sm" variant="ghost" className="ml-auto" aria-label={`Delete collection ${c.name}`} onClick={() => window.confirm(`Delete the collection “${c.name}”? Its items are kept.`) && run(() => engine.del(`workspaces/${id}/collections/${c.id}`))}><Trash2 className="h-3.5 w-3.5" /></Button>}</div>
              <ul className="mt-1 text-xs text-muted">{c.item_ids.map((x) => <li key={x}>{w.items.find((i) => i.id === x)?.title ?? "(deleted item)"}</li>)}</ul>
            </Card>
          ))}
        </div>
      )}

      {tab === "sharing" && <Sharing w={w} run={run} />}

      {tab === "export" && (
        <Card className="max-w-2xl space-y-3 p-4 text-sm">
          <div className="font-medium">Take your data with you</div>
          <p className="text-muted">Exports are self-describing JSON bundles (format <code>orbis-workspace</code> v1) with a checksum. They never include OAuth tokens, share-link tokens or connector credentials; member emails are only included when an admin asks.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={!can("export")} onClick={() => run(async () => download(await engine.get(`workspaces/${id}/export`), `${w.name}.orbis.json`))}><Download className="h-4 w-4" /> Export items & comments</Button>
            <Button variant="secondary" disabled={!can("export")} onClick={() => run(async () => download(await engine.get(`workspaces/${id}/export?history=true`), `${w.name}.full-history.orbis.json`))}><History className="h-4 w-4" /> Export with full history</Button>
          </div>
          <div className="border-t border-border pt-3">
            <div className="font-medium">Delete workspace</div>
            <p className="text-muted">Deletes the workspace for every member and revokes all share links. Only the owner can do this.</p>
            <Button variant="danger" className="mt-2" disabled={!can("delete_workspace")} onClick={() => window.confirm(`Delete “${w.name}” for everyone?`) && run(async () => { await engine.del(`workspaces/${id}`); router.push("/workspaces"); })}><Trash2 className="h-4 w-4" /> Delete workspace</Button>
          </div>
          <Link href="/integrations" className="block text-accent hover:underline">Manage integrations that sync into workspaces →</Link>
        </Card>
      )}
    </div>
  );
}

function download(data: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/[^\w.-]+/g, "_");
  a.click();
  URL.revokeObjectURL(url);
}

function NewItem({ onCreate }: { onCreate: (p: { type: string; title: string; data: Record<string, unknown> }) => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<string>("note");
  const [title, setTitle] = useState("");
  if (!open) return <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-3.5 w-3.5" /> New item</Button>;
  return (
    <div className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-accent/40 p-2">
      <Select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">{TYPES.map((t) => <option key={t}>{t}</option>)}</Select>
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="h-9 flex-1" aria-label="Title" />
      <Button size="sm" disabled={!title.trim()} onClick={() => { onCreate({ type, title, data: type === "task" ? { status: "todo", body: "" } : type === "decision" ? { decision: "", rationale: "", status: "proposed" } : type === "link" ? { url: "" } : { body: "" } }); setTitle(""); setOpen(false); }}>Add</Button>
      <Button size="icon" variant="ghost" onClick={() => setOpen(false)} aria-label="Cancel"><X className="h-4 w-4" /></Button>
    </div>
  );
}

function ItemPanel({ wid, itemId, canEdit, canComment, onChanged, onDeleted }: { wid: string; itemId: string; canEdit: boolean; canComment: boolean; onChanged: () => void; onDeleted: () => void }) {
  const it = useEngine<FullItem>(`workspaces/${wid}/items/${itemId}`);
  const [draft, setDraft] = useState<{ title: string; data: Record<string, unknown> } | null>(null);
  const [note, setNote] = useState("");
  const [comment, setComment] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ version: number; title: string; data: Record<string, unknown> } | null>(null);
  if (it.error) return <EngineError message={it.error} />;
  const x = it.data;
  if (!x) return null;
  const cur = draft ?? { title: x.title, data: x.data };
  const setData = (k: string, v: unknown) => setDraft({ ...cur, data: { ...cur.data, [k]: v } });
  const save = async () => {
    setErr(null);
    try {
      await engine.put(`workspaces/${wid}/items/${itemId}`, { ...cur, expected_version: x.current_version, change_note: note });
      setDraft(null);
      setNote("");
      await it.reload();
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const fields = x.type === "task" ? ["status", "assignee", "due", "body"] : x.type === "decision" ? ["decision", "rationale", "status", "evidence"] : x.type === "link" ? ["url", "summary"] : ["body"];
  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2"><Badge>{x.type}</Badge><span className="text-xs text-faint">version {x.current_version}</span>{canEdit && <Button size="sm" variant="ghost" className="ml-auto" aria-label="Delete item" onClick={async () => { if (!window.confirm("Delete this item?")) return; setErr(null); try { await engine.del(`workspaces/${wid}/items/${itemId}`); onDeleted(); } catch (e) { setErr((e as Error).message); } }}><Trash2 className="h-3.5 w-3.5" /></Button>}</div>
      {x.source?.untrusted ? <Notice tone="warning">This content came from outside Orbis AI ({String(x.source.connector ?? (x.source.imported ? "import" : "community"))}). Workflows treat it as untrusted data.</Notice> : null}
      <Input value={cur.title} onChange={(e) => setDraft({ ...cur, title: e.target.value })} disabled={!canEdit} className="h-9 font-medium" aria-label="Title" />
      {fields.map((f) => (
        <label key={f} className="block space-y-1">
          <span className="text-xs capitalize text-muted">{f}</span>
          {f === "status" ? (
            <Select value={String(cur.data.status ?? "")} onChange={(e) => setData("status", e.target.value)} disabled={!canEdit} className="w-full">{(x.type === "task" ? ["todo", "doing", "done", "blocked"] : ["proposed", "accepted", "rejected", "superseded"]).map((s) => <option key={s}>{s}</option>)}</Select>
          ) : f === "url" && !canEdit && isSafeHttpUrl(cur.data.url) ? (
            <a href={String(cur.data.url)} target="_blank" rel="noopener noreferrer nofollow" className="block text-sm text-accent">{String(cur.data.url)}</a>
          ) : (
            <Textarea value={String(cur.data[f] ?? "")} onChange={(e) => setData(f, e.target.value)} disabled={!canEdit} rows={f === "body" ? 10 : f === "rationale" || f === "evidence" ? 4 : 1} />
          )}
        </label>
      ))}
      {canEdit && draft && (
        <div className="flex flex-wrap items-center gap-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed? (optional)" className="h-9 flex-1" aria-label="Change note" />
          <Button size="sm" onClick={save}>Save as v{x.current_version + 1}</Button>
          <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Discard</Button>
        </div>
      )}
      {err && <Notice tone="danger">{err}</Notice>}

      <details className="text-xs">
        <summary className="cursor-pointer text-accent">Version history ({x.versions.length})</summary>
        <ul className="mt-2 space-y-1">
          {x.versions.map((v) => (
            <li key={v.version} className="flex flex-wrap items-center gap-2">
              <Badge tone={v.version === x.current_version ? "success" : "default"}>v{v.version}</Badge>
              <span className="text-faint">{relativeTime(v.created_at)}</span>
              <span className="text-muted">{v.change_note ?? ""}</span>
              <button type="button" className="text-accent" onClick={async () => setPreview(await engine.get(`workspaces/${wid}/items/${itemId}/versions/${v.version}`))}>view</button>
              {canEdit && v.version !== x.current_version && <button type="button" className="flex items-center gap-0.5 text-accent" onClick={async () => { await engine.post(`workspaces/${wid}/items/${itemId}/restore`, { version: v.version }); await it.reload(); onChanged(); }}><RotateCcw className="h-3 w-3" /> restore</button>}
            </li>
          ))}
        </ul>
        {preview && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-elev p-2 text-[11px] text-muted">v{preview.version}: {preview.title}{"\n"}{JSON.stringify(preview.data, null, 2)}</pre>}
      </details>

      <div className="border-t border-border pt-3">
        <div className="mb-2 text-sm font-medium">Comments</div>
        {x.comments.length === 0 && <p className="text-xs text-faint">No comments.</p>}
        {x.comments.map((c) => (
          <div key={c.id} className={cn("mb-2 rounded-lg border p-2 text-sm", c.resolved ? "border-border opacity-60" : "border-border-strong", c.parent_id && "ml-6")}>
            <div className="flex items-center gap-2 text-xs text-faint"><span className="text-muted">{c.author_name ?? "Someone"}</span>{relativeTime(c.created_at)}{c.resolved && <Badge>resolved</Badge>}
              {canComment && !c.resolved && <button type="button" className="ml-auto text-accent" onClick={async () => { await engine.patch(`workspaces/${wid}/comments/${c.id}`, { resolved: true }); await it.reload(); }}>resolve</button>}
            </div>
            <div className="mt-0.5 whitespace-pre-wrap">{c.body}</div>
          </div>
        ))}
        {canComment && (
          <div className="flex gap-2">
            <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="Add a comment" maxLength={10000} aria-label="Comment" />
            <Button size="sm" disabled={!comment.trim()} onClick={async () => { await engine.post(`workspaces/${wid}/items/${itemId}/comments`, { body: comment }); setComment(""); await it.reload(); onChanged(); }}>Post</Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function Members({ w, run }: { w: Ws; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const canManage = w.permissions.manage_members;
  return (
    <div className="max-w-3xl space-y-3">
      {canManage && (
        <Card className="flex flex-wrap items-center gap-2 p-3">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" className="h-9 flex-1" aria-label="Email" />
          <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">{["admin", "editor", "commenter", "viewer"].map((r) => <option key={r}>{r}</option>)}</Select>
          <Button onClick={() => run(async () => { await engine.post(`workspaces/${w.id}/members`, { email, role }); setEmail(""); })} disabled={!email.includes("@")}><UserPlus className="h-4 w-4" /> Invite</Button>
          <p className="w-full text-[11px] text-faint">Invitations are accepted automatically when someone signs in with that verified email. No email is sent from this deployment — share the workspace link yourself.</p>
        </Card>
      )}
      {w.members.map((m) => (
        <Card key={m.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
          <span className="font-medium">{m.name ?? m.email}</span>
          {m.name && <span className="text-xs text-faint">{m.email}</span>}
          {m.status === "invited" && <Badge tone="warning">invited</Badge>}
          <div className="ml-auto flex items-center gap-2">
            {canManage && m.role !== "owner" ? (
              <Select value={m.role} onChange={(e) => run(() => engine.patch(`workspaces/${w.id}/members/${m.id}`, { role: e.target.value }))} aria-label="Role">{["admin", "editor", "commenter", "viewer"].map((r) => <option key={r}>{r}</option>)}</Select>
            ) : (
              <Badge tone={m.role === "owner" ? "accent" : "default"}>{m.role}</Badge>
            )}
            {canManage && m.role !== "owner" && <Button size="icon" variant="ghost" aria-label={`Remove ${m.email}`} onClick={() => window.confirm(`Remove ${m.email} from this workspace?`) && run(() => engine.del(`workspaces/${w.id}/members/${m.id}`))}><X className="h-4 w-4" /></Button>}
            {w.role === "owner" && m.role !== "owner" && m.status === "active" && <Button size="sm" variant="ghost" onClick={() => window.confirm(`Make ${m.email} the owner? You will become an admin.`) && run(() => engine.patch(`workspaces/${w.id}/members/${m.id}`, { transfer_ownership: true }))}>Make owner</Button>}
          </div>
        </Card>
      ))}
    </div>
  );
}

function NewCollection({ items, onCreate }: { items: Item[]; onCreate: (name: string, ids: string[]) => void }) {
  const [name, setName] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  return (
    <Card className="space-y-2 p-3">
      <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Collection name" className="h-9" aria-label="Collection name" />
      <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">{items.map((i) => <button key={i.id} type="button" onClick={() => setIds(ids.includes(i.id) ? ids.filter((x) => x !== i.id) : [...ids, i.id])} className={cn("rounded border px-2 py-0.5 text-xs", ids.includes(i.id) ? "border-accent text-accent" : "border-border text-muted")}>{i.title}</button>)}</div>
      <Button size="sm" disabled={!name.trim()} onClick={() => { onCreate(name, ids); setName(""); setIds([]); }}>Create collection</Button>
    </Card>
  );
}

function Sharing({ w, run }: { w: Ws; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [role, setRole] = useState("viewer");
  const [days, setDays] = useState("30");
  const [token, setToken] = useState<string | null>(null);
  const can = w.permissions.create_share_links;
  return (
    <div className="max-w-3xl space-y-3">
      <Notice tone="info">Share links give read-only access ({role}) to anyone with the link, until they expire or you revoke them. The link token is shown once; Orbis AI stores only its hash.</Notice>
      {can ? (
        <Card className="flex flex-wrap items-center gap-2 p-3">
          <Select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Access"><option value="viewer">Can view</option><option value="commenter">Can view (comment role, for signed-in members later)</option></Select>
          <Select value={days} onChange={(e) => setDays(e.target.value)} aria-label="Expiry"><option value="1">Expires in 1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="0">Never expires</option></Select>
          <Button onClick={() => run(async () => { const s = await engine.post<{ token: string }>(`workspaces/${w.id}/shares`, { role, expires_days: Number(days) || null }); setToken(s.token); })}><Link2 className="h-4 w-4" /> Create link</Button>
        </Card>
      ) : <p className="text-sm text-faint">Only admins and owners can create share links.</p>}
      {token && (
        <Card className="flex flex-wrap items-center gap-2 border-success/40 p-3 text-sm">
          <code className="flex-1 truncate text-xs">{`${typeof window !== "undefined" ? window.location.origin : ""}/share/${token}`}</code>
          <Button size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(`${window.location.origin}/share/${token}`)}><Copy className="h-3.5 w-3.5" /> Copy</Button>
        </Card>
      )}
      {w.shares.map((s) => (
        <Card key={s.id} className="flex items-center gap-2 p-3 text-sm">
          <Badge>{s.role}</Badge><span className="text-xs text-faint">created {relativeTime(s.created_at)} · {s.expires_at ? `expires ${s.expires_at.slice(0, 10)}` : "no expiry"}</span>
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => window.confirm("Revoke this share link? Anyone using it loses access.") && run(() => engine.del(`workspaces/${w.id}/shares/${s.id}`))}>Revoke</Button>
        </Card>
      ))}
      <p className="text-xs text-faint">To publish templates or collections to everyone, use <Link href="/community" className="text-accent hover:underline">Community</Link> — publishing copies a snapshot and scans it for personal data first.</p>
    </div>
  );
}
