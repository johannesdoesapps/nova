"use client";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { CircleCheck, Plug, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Badge, Button, Card, Input, Notice, PageHeader, Select } from "@/components/ui/primitives";
import { engine, useEngine } from "@/components/engine/api";
import { EngineError } from "@/components/engine/engine-error";
import { cn, relativeTime } from "@/lib/utils";

interface Connector { id: string; name: string; category: string; auth: string; priority: string; value: string; feasibility: string; capabilities: Record<string, string[]>; syncs: string; writes: string; revocation: string; api_notes: string; status: string }
interface Connection { id: string; connector_id: string; connector: string; status: string; scopes: string[]; account_label: string | null; workspace_id: string | null; config: Record<string, unknown>; sync: { status: string; last_sync_at: string | null; last_success_at: string | null; counts: Record<string, number>; error: string | null; rate_limit_remaining?: string | null }; has_token: boolean; created_at: string; revoked_at: string | null }
interface Consent { id: string; connector_id: string; action: string; scopes: string[]; purpose: string; created_at: string }

const STATUS: Record<string, { label: string; tone: "success" | "warning" | "default" | "danger" }> = {
  available: { label: "Available", tone: "success" },
  available_limited: { label: "Available (public data; OAuth needs setup)", tone: "warning" },
  planned: { label: "Planned", tone: "default" },
  not_planned: { label: "Not planned", tone: "danger" },
};

export function IntegrationsView() {
  const params = useSearchParams();
  const data = useEngine<{ catalog: Connector[]; connections: Connection[]; consents: Consent[] }>("connectors");
  const spaces = useEngine<{ workspaces: { id: string; name: string; role: string }[] }>("workspaces");
  const [connecting, setConnecting] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger" | "warning"; text: string } | null>(params.get("connected") ? { tone: "success", text: "Connected." } : params.get("error") ? { tone: "danger", text: params.get("error")! } : null);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tone: "success", text: ok });
      await data.reload();
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    }
  };
  const groups = ["P0", "P1", "P2", "P3", "—"];
  const active = data.data?.connections.filter((c) => c.status !== "revoked") ?? [];
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Integrations" description="Connect outside sources to workspaces and Radar. Every connector asks for the minimum access, shows exactly what it syncs, and can be disconnected — with the option to delete everything it brought in." />
      {data.error && <div className="mb-4"><EngineError message={data.error} /></div>}
      {msg && <Notice tone={msg.tone} className="mb-4">{msg.text}</Notice>}

      <h2 className="mb-2 text-sm font-medium">Your connections</h2>
      {active.length === 0 && <p className="mb-6 text-sm text-faint">Nothing connected.</p>}
      <div className="mb-8 space-y-2">
        {active.map((c) => <ConnectionCard key={c.id} c={c} spaces={spaces.data?.workspaces ?? []} run={run} />)}
      </div>

      <h2 className="mb-2 text-sm font-medium">Catalog</h2>
      {groups.map((g) => {
        const items = data.data?.catalog.filter((c) => c.priority === g) ?? [];
        if (!items.length) return null;
        return (
          <div key={g} className="mb-6">
            <div className="mb-2 text-xs uppercase tracking-wider text-faint">{g === "—" ? "Not planned" : `Priority ${g}`}</div>
            <div className="grid gap-3 md:grid-cols-2">
              {items.map((c) => (
                <Card key={c.id} className="flex flex-col p-4">
                  <div className="flex flex-wrap items-center gap-2"><Plug className="h-4 w-4 text-faint" /><span className="font-medium">{c.name}</span><Badge>{c.category}</Badge><Badge tone={STATUS[c.status]?.tone}>{STATUS[c.status]?.label ?? c.status}</Badge></div>
                  <p className="mt-2 text-sm text-muted">{c.value}</p>
                  <p className="mt-1 text-xs text-faint">Feasibility: {c.feasibility}</p>
                  {c.syncs && <p className="mt-1 text-xs text-faint">Syncs: {c.syncs}</p>}
                  {c.writes && <p className="text-xs text-faint">Writes: {c.writes}</p>}
                  {Object.keys(c.capabilities).length > 0 && <p className="mt-1 text-xs text-faint">Access requested per capability: {Object.entries(c.capabilities).map(([k, v]) => `${k.replace(/_/g, " ")} → ${v.length ? v.join(", ") : "no account access"}`).join(" · ")}</p>}
                  {c.api_notes && <p className="mt-1 text-xs text-faint">{c.api_notes}</p>}
                  {c.status.startsWith("available") && ["rss", "github"].includes(c.id) && (
                    connecting === c.id ? <ConnectForm c={c} spaces={spaces.data?.workspaces ?? []} onCancel={() => setConnecting(null)} onConnect={(body) => run(async () => { const r = await engine.post<{ authorize_url?: string }>(`connectors/${c.id}/connect`, body); if (r.authorize_url) window.location.assign(r.authorize_url); setConnecting(null); }, body.oauth ? undefined : `${c.name} connected.`)} /> : <Button size="sm" className="mt-3 self-start" onClick={() => setConnecting(c.id)}>Connect</Button>
                  )}
                  {c.status.startsWith("available") && !["rss", "github"].includes(c.id) && <p className="mt-3 text-xs text-muted">Used directly in {c.id === "slack_webhook" ? "AI Lab (http.post with an allow-listed domain)" : "Signal Radar sources"} — no connection needed.</p>}
                </Card>
              ))}
            </div>
          </div>
        );
      })}

      <details className="rounded-2xl border border-border p-4 text-sm">
        <summary className="cursor-pointer font-medium"><ShieldCheck className="mr-1 inline h-4 w-4" />Consent history</summary>
        <ul className="mt-2 space-y-1 text-xs text-muted">
          {data.data?.consents.map((x) => <li key={x.id}><Badge tone={x.action === "granted" ? "success" : "default"}>{x.action.replace("_", " ")}</Badge> {x.connector_id} · {relativeTime(x.created_at)} · {x.purpose}{x.scopes.length ? ` (scopes: ${x.scopes.join(", ")})` : ""}</li>)}
          {data.data?.consents.length === 0 && <li>No consent records yet.</li>}
        </ul>
      </details>
    </div>
  );
}

function ConnectForm({ c, spaces, onCancel, onConnect }: { c: Connector; spaces: { id: string; name: string; role: string }[]; onCancel: () => void; onConnect: (body: Record<string, unknown>) => void }) {
  const [url, setUrl] = useState("");
  const [repos, setRepos] = useState("");
  const [ws, setWs] = useState("");
  const [cap, setCap] = useState("create_issues_public_repos");
  const editable = spaces.filter((s) => ["owner", "admin"].includes(s.role));
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-accent/40 p-3 text-sm">
      <Select value={ws} onChange={(e) => setWs(e.target.value)} className="w-full" aria-label="Workspace"><option value="">Sync into workspace… (admins)</option>{editable.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
      {c.id === "rss" && <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" className="h-9" aria-label="Feed URL" />}
      {c.id === "github" && (
        <>
          <Input value={repos} onChange={(e) => setRepos(e.target.value)} placeholder="Public repos: owner/name, owner/name" className="h-9" aria-label="Repositories" />
          <p className="text-[11px] text-faint">Public mode reads public issues without signing in (60 requests/hour). To create issues from workflows, connect your account with OAuth below.</p>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onConnect({ workspace_id: ws || undefined, config: c.id === "rss" ? { url } : { repos: repos.split(",").map((x) => x.trim()).filter(Boolean) } })}>Connect {c.id === "github" ? "(public, no sign-in)" : ""}</Button>
        {c.id === "github" && (
          <>
            <Select value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Access level">{Object.entries(c.capabilities).filter(([, v]) => v.length).map(([k, v]) => <option key={k} value={k}>{k.replace(/_/g, " ")} ({v.join(", ")})</option>)}</Select>
            <Button size="sm" variant="secondary" disabled={c.status !== "available"} title={c.status !== "available" ? "The server operator must register a GitHub OAuth app first" : undefined} onClick={() => onConnect({ oauth: true, capability: cap, workspace_id: ws || undefined })}>Sign in with GitHub</Button>
          </>
        )}
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function ConnectionCard({ c, spaces, run }: { c: Connection; spaces: { id: string; name: string; role: string }[]; run: (fn: () => Promise<unknown>, ok?: string) => Promise<void> }) {
  const conflicts = useEngine<{ conflicts: { id: string; local: { title: string; version: number }; remote: { title: string; remote_version: string } }[] }>(`connections/${c.id}/conflicts`);
  const [deleteData, setDeleteData] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const counts = Object.entries(c.sync.counts ?? {}).map(([k, v]) => `${v} ${k}`).join(", ");
  return (
    <Card className="p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.connector}</span><span className="text-xs text-faint">{c.account_label}</span>
        <Badge tone={c.status === "active" ? "success" : "danger"}>{c.status}</Badge>
        <Badge tone={c.sync.status === "ok" ? "success" : c.sync.status === "error" ? "danger" : c.sync.status === "partial" ? "warning" : "default"}>sync: {c.sync.status}</Badge>
        {c.has_token && <Badge>token encrypted at rest</Badge>}
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant="secondary" onClick={() => run(() => engine.post(`connections/${c.id}/sync`), "Sync finished.")} disabled={!c.workspace_id}><RefreshCw className="h-3.5 w-3.5" /> Sync now</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}><Trash2 className="h-3.5 w-3.5" /> Disconnect</Button>
        </div>
      </div>
      <div className="mt-2 grid gap-1 text-xs text-muted sm:grid-cols-2">
        <div>Workspace: {c.workspace_id ? spaces.find((s) => s.id === c.workspace_id)?.name ?? c.workspace_id : <Select value="" onChange={(e) => run(() => engine.patch(`connections/${c.id}`, { workspace_id: e.target.value }))} className="h-7 text-xs" aria-label="Choose workspace"><option value="">choose…</option>{spaces.filter((s) => ["owner", "admin"].includes(s.role)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</div>
        <div>Access: {c.scopes.length ? c.scopes.join(", ") : "public data only"}</div>
        <div>Last sync: {c.sync.last_sync_at ? relativeTime(c.sync.last_sync_at) : "never"}{c.sync.last_success_at ? ` · last success ${relativeTime(c.sync.last_success_at)}` : ""}</div>
        <div>{counts || "No items synced yet"}{c.sync.rate_limit_remaining ? ` · API calls left: ${c.sync.rate_limit_remaining}` : ""}</div>
        {c.sync.error && <div className="text-danger sm:col-span-2">{c.sync.error}</div>}
      </div>
      {conflicts.data && conflicts.data.conflicts.length > 0 && (
        <div className="mt-3 space-y-2 rounded-xl border border-warning/40 p-3">
          <div className="text-xs font-medium text-warning">Sync conflicts — both your copy and the source changed</div>
          {conflicts.data.conflicts.map((x) => (
            <div key={x.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span>{x.local.title} (your v{x.local.version}) vs source ({x.remote.remote_version})</span>
              <Button size="sm" variant="secondary" onClick={() => run(async () => { await engine.post(`conflicts/${x.id}`, { keep: "local" }); await conflicts.reload(); })}>Keep mine</Button>
              <Button size="sm" variant="secondary" onClick={() => run(async () => { await engine.post(`conflicts/${x.id}`, { keep: "remote" }); await conflicts.reload(); })}>Use source</Button>
            </div>
          ))}
        </div>
      )}
      {confirm && (
        <div className={cn("mt-3 space-y-2 rounded-xl border border-danger/40 p-3 text-xs")}>
          <div>Disconnecting deletes the stored credentials and revokes the grant at the provider when possible.</div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} /> Also delete every item this connection synced (and its history)</label>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" onClick={() => run(async () => { const r = await engine.del<{ revocation: string; deleted_items: number }>(`connections/${c.id}?delete_data=${deleteData}`); setConfirm(false); return r; }, "Disconnected.")}><CircleCheck className="h-3.5 w-3.5" /> Disconnect</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
