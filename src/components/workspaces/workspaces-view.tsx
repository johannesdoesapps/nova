"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Layers, Plus, Upload } from "lucide-react";
import { Badge, Button, Card, EmptyState, Input, Notice, PageHeader } from "@/components/ui/primitives";
import { engine, useEngine } from "@/components/engine/api";
import { EngineError } from "@/components/engine/engine-error";
import { relativeTime } from "@/lib/utils";

interface WsRow { id: string; name: string; description: string | null; visibility: string; role: string; item_count: number; member_count: number; updated_at: string }

export function WorkspacesView() {
  const router = useRouter();
  const list = useEngine<{ workspaces: WsRow[]; permission_matrix: Record<string, Record<string, boolean>> }>("workspaces");
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [importReport, setImportReport] = useState<{ bundle: unknown; report: { workspace_name: string; items: number; skipped: number; collections: number; warnings: string[] } } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const create = async () => {
    try {
      const w = await engine.post<{ id: string }>("workspaces", { name });
      router.push(`/workspaces/${w.id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const pick = async (f: File) => {
    setErr(null);
    try {
      if (f.size > 10_000_000) throw new Error("Bundle is larger than 10 MB.");
      const bundle = JSON.parse(await f.text());
      setImportReport({ bundle, report: await engine.post("workspaces/import?dry_run=true", bundle) });
    } catch (e) {
      setErr(`Import failed: ${(e as Error).message}`);
    }
  };
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Workspaces" description="Shared project spaces that keep chats, documents, research, tasks, workflows and decisions in one context — with roles, comments and full version history." />
      {list.error && <div className="mb-4"><EngineError message={list.error} /></div>}
      <Card className="mb-5 flex flex-wrap items-center gap-2 p-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New workspace name" className="h-9 max-w-xs" aria-label="Workspace name" />
        <Button onClick={create} disabled={!name.trim()}><Plus className="h-4 w-4" /> Create</Button>
        <input ref={file} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
        <Button variant="secondary" onClick={() => file.current?.click()}><Upload className="h-4 w-4" /> Import bundle</Button>
      </Card>
      {err && <Notice tone="danger" className="mb-4">{err}</Notice>}
      {importReport && (
        <Card className="mb-5 space-y-2 border-accent/40 p-4 text-sm">
          <div className="font-medium">Import preview: “{importReport.report.workspace_name}”</div>
          <div className="text-muted">{importReport.report.items} item(s), {importReport.report.collections} collection(s){importReport.report.skipped ? `, ${importReport.report.skipped} skipped` : ""}. Nothing has been written yet.</div>
          {importReport.report.warnings.map((w) => <Notice key={w} tone="warning">{w}</Notice>)}
          <div className="flex gap-2">
            <Button onClick={async () => { const r = await engine.post<{ workspace_id: string }>("workspaces/import?dry_run=false", importReport.bundle); router.push(`/workspaces/${r.workspace_id}`); }}>Import as new workspace</Button>
            <Button variant="ghost" onClick={() => setImportReport(null)}>Cancel</Button>
          </div>
        </Card>
      )}
      {list.data?.workspaces.length === 0 && <EmptyState icon={<Layers className="h-8 w-8" />} title="No workspaces yet">Create one for each project you work on with others (or alone).</EmptyState>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.data?.workspaces.map((w) => (
          <Link key={w.id} href={`/workspaces/${w.id}`} className="rounded-2xl border border-border bg-panel p-4 hover:border-border-strong">
            <div className="flex flex-wrap items-center gap-2"><Badge tone="accent">{w.role.replace("invited:", "invited as ")}</Badge><Badge>{w.visibility}</Badge></div>
            <div className="mt-2 font-medium">{w.name}</div>
            <div className="text-xs text-faint">{w.item_count} items · {w.member_count} member(s) · updated {relativeTime(w.updated_at)}</div>
          </Link>
        ))}
      </div>
      {list.data && (
        <details className="mt-8 rounded-2xl border border-border p-4 text-sm">
          <summary className="cursor-pointer font-medium">Roles and permissions</summary>
          <div tabIndex={0} role="region" aria-label="Table (scrolls sideways)" className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="text-faint"><tr><th className="py-1 font-medium">Action</th>{["owner", "admin", "editor", "commenter", "viewer"].map((r) => <th key={r} className="font-medium capitalize">{r}</th>)}</tr></thead>
              <tbody className="divide-y divide-border">{Object.entries(list.data.permission_matrix).map(([a, roles]) => <tr key={a}><td className="py-1">{a.replace(/_/g, " ")}</td>{["owner", "admin", "editor", "commenter", "viewer"].map((r) => <td key={r}>{roles[r] ? "✓" : "—"}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
