"use client";
import Link from "next/link";
import { useState } from "react";
import { Ban, CircleStop, RotateCcw, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import { SectionTabs } from "@/components/research/section-tabs";
import { Badge, Button, Card, Notice, PageHeader, Textarea } from "@/components/ui/primitives";
import { engine, useEngine } from "@/components/engine/api";
import { EngineError } from "@/components/engine/engine-error";
import { cn, formatUsd, relativeTime } from "@/lib/utils";
import { LAB_TABS } from "./lab-tabs";
import { NODE_COLOR, RUN_TONE, STEP_TONE, TERMINAL, type Approval, type Catalog, type Run } from "./types";

const TRUST: Record<string, { label: string; tone: "default" | "accent" | "warning" }> = {
  trusted: { label: "trusted", tone: "default" },
  generated: { label: "model-generated", tone: "accent" },
  untrusted: { label: "untrusted content", tone: "warning" },
};

function show(v: unknown): string {
  if (v === undefined || v === null) return "—";
  return typeof v === "string" ? v : JSON.stringify(v, null, 2);
}

export function RunView({ id }: { id: string }) {
  const run = useEngine<Run>(`lab/runs/${id}`, { poll: 1500, pollWhile: (r) => !TERMINAL.includes(r.status) });
  const kinds = useEngine<Catalog>("lab/catalog").data?.approval_kinds ?? {};
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (what: string, fn: () => Promise<Run>) => {
    setBusy(what);
    setErr(null);
    try {
      run.setData(await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  if (run.error) return <div className="p-8"><EngineError message={run.error} /></div>;
  const r = run.data;
  if (!r) return <div className="p-8 text-sm text-muted">Loading run…</div>;
  const spec = r.spec;
  const order = spec?.nodes.map((n) => n.id) ?? Object.keys(r.state.steps);
  const pending = r.approvals.filter((a) => a.status === "pending");
  const u = r.state.usage;
  return (
    <div className="mx-auto max-w-7xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader
        title={spec?.name ?? "Run"}
        badge={<Badge tone={RUN_TONE[r.status] ?? "default"}>{r.status.replace("_", " ")}</Badge>}
        description={<>Run of <Link className="text-accent hover:underline" href={`/lab/workflows/${r.workflow_id}`}>{r.version > 0 ? `version ${r.version}` : "a draft snapshot"}</Link> · {r.mode === "dry_run" ? "dry run (no external effects)" : r.mode} · started {relativeTime(r.created_at)}</>}
        actions={
          <>
            {!TERMINAL.includes(r.status) && <Button variant="danger" size="sm" loading={busy === "cancel"} onClick={() => act("cancel", () => engine.post(`lab/runs/${id}/cancel`))}><CircleStop className="h-3.5 w-3.5" /> Cancel run</Button>}
            {["failed", "interrupted", "budget_exceeded"].includes(r.status) && <Button size="sm" loading={busy === "resume"} onClick={() => act("resume", () => engine.post(`lab/runs/${id}/resume`))}><RotateCcw className="h-3.5 w-3.5" /> Resume from checkpoint</Button>}
          </>
        }
      />
      <SectionTabs tabs={LAB_TABS} />
      {err && <Notice tone="danger" className="mb-4">{err}</Notice>}
      {r.error && <Notice tone={r.status === "interrupted" ? "warning" : "danger"} className="mb-4">{r.error}</Notice>}

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        {[["Model calls", `${u.model_calls} / ${spec?.budget.max_model_calls ?? "?"}`], ["Tokens", `${(u.input_tokens + u.output_tokens).toLocaleString()} / ${spec?.budget.max_tokens.toLocaleString() ?? "?"}`], ["Cost", u.cost_unknown_calls ? `${formatUsd(u.cost_usd)} + ${u.cost_unknown_calls} unpriced` : `${formatUsd(u.cost_usd)} / $${spec?.budget.max_cost_usd ?? "?"}`], ["Steps run", String(u.steps_run)]].map(([k, v]) => (
          <Card key={k} className="p-3"><div className="text-xs text-faint">{k}</div><div className="text-lg font-semibold tabular-nums">{v}</div></Card>
        ))}
      </div>

      {pending.map((a) => <ApprovalCard key={a.id} a={a} kinds={kinds} stepName={spec?.nodes.find((n) => n.id === a.step_id)?.name ?? a.step_id} onDecide={(approve, note) => act("approve", () => engine.post(`lab/approvals/${a.id}`, { decision: approve ? "approve" : "reject", note }))} busy={busy === "approve"} />)}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-2">
          <div className="text-sm font-medium">Steps</div>
          {order.map((sid, i) => {
            const st = r.state.steps[sid];
            const n = spec?.nodes.find((x) => x.id === sid);
            if (!st) return null;
            return (
              <details key={sid} className="rounded-xl border border-border bg-panel p-3" open={st.status === "failed" || st.status === "waiting_approval"}>
                <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm">
                  <span className="font-mono text-xs text-faint">{i + 1}</span>
                  <span className="h-2 w-2 rounded-full" style={{ background: n ? NODE_COLOR[n.type] : "#888" }} />
                  <span className="font-medium">{n?.name ?? sid}</span>
                  <Badge tone={STEP_TONE[st.status] ?? "default"}>{st.status.replace("_", " ")}</Badge>
                  {st.trust && st.status === "succeeded" && <Badge tone={TRUST[st.trust]!.tone}>{TRUST[st.trust]!.label}</Badge>}
                  {st.attempts > 1 && <Badge>{st.attempts} attempts</Badge>}
                  {st.flags?.map((f) => <Badge key={f} tone="warning">{f.replace("injection:", "instruction-like text: ")}</Badge>)}
                  {st.model?.simulated && <Badge tone="warning">simulated</Badge>}
                  <span className="ml-auto text-[11px] text-faint">{st.duration_ms != null ? `${st.duration_ms} ms` : ""}</span>
                </summary>
                <div className="mt-2 space-y-2 text-xs">
                  {st.error && <div className="text-danger">{st.error}</div>}
                  {st.skipped_reason && <div className="text-muted">{st.skipped_reason}</div>}
                  {st.model && <div className="text-muted">{st.model.id}{st.model.served ? ` (served as ${st.model.served})` : ""} · {st.model.input_tokens}+{st.model.output_tokens} tokens · {formatUsd(st.model.cost_usd)} · {st.model.latency_ms} ms</div>}
                  {st.output !== undefined && <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-elev p-2 text-[11px] text-muted">{show(st.output)}</pre>}
                </div>
              </details>
            );
          })}
          {Object.keys(r.state.outputs ?? {}).length > 0 && (
            <Card className="p-4">
              <div className="mb-2 text-sm font-medium">Outputs</div>
              {Object.entries(r.state.outputs).map(([k, v]) => <div key={k} className="mb-2"><div className="font-mono text-xs text-faint">{k}</div><pre className="whitespace-pre-wrap text-sm">{show(v)}</pre></div>)}
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <Card className="p-4">
            <div className="mb-2 text-sm font-medium">Execution log</div>
            <ol className="max-h-[520px] space-y-1 overflow-y-auto text-xs">
              {r.events.map((e) => (
                <li key={e.seq} className="flex gap-2">
                  <span className="shrink-0 font-mono text-[10px] text-faint">{e.ts.slice(11, 19)}</span>
                  <span className={cn(e.level === "error" ? "text-danger" : e.level === "warn" ? "text-warning" : "text-muted")}>{e.step_id && <span className="font-mono text-faint">[{e.step_id}] </span>}{e.message}</span>
                </li>
              ))}
            </ol>
          </Card>
          {r.approvals.filter((a) => a.status !== "pending").length > 0 && (
            <Card className="p-4 text-xs">
              <div className="mb-2 text-sm font-medium">Approval history</div>
              {r.approvals.filter((a) => a.status !== "pending").map((a) => <div key={a.id} className="mb-1">{a.status === "approved" ? "✓" : "✗"} {a.step_id} — {a.status} by {a.decided_by === "system" ? "system (run cancelled)" : "you"} {relativeTime(a.decided_at)}{a.note ? ` · “${a.note}”` : ""} <span className="font-mono text-faint">#{a.payload_hash.slice(0, 8)}</span></div>)}
            </Card>
          )}
          {r.outbox.length > 0 && (
            <Card className="p-4 text-xs">
              <div className="mb-2 text-sm font-medium">External actions</div>
              {r.outbox.map((o) => <div key={o.id} className="mb-1"><Badge tone={o.status === "performed" ? "success" : "warning"}>{o.status}</Badge> {o.tool} {relativeTime(o.created_at)}</div>)}
              <p className="mt-1 text-faint">Each action has an idempotency key, so resuming a run never repeats an action that already happened.</p>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

export function ApprovalCard({ a, kinds, stepName, onDecide, busy }: { a: Approval; kinds: Record<string, string>; stepName: string; onDecide: (approve: boolean, note: string) => void; busy: boolean }) {
  const [note, setNote] = useState("");
  return (
    <Card className="mb-5 border-warning/50 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-warning"><ShieldAlert className="h-4 w-4" /> Your approval is needed: {stepName}</div>
      <ul className="mt-2 space-y-1 text-sm">
        {a.kinds.map((k, i) => <li key={k}><Badge tone="warning">{k.replace(/_/g, " ")}</Badge> <span className="text-muted">{a.reasons[i] ?? kinds[k]}</span></li>)}
      </ul>
      <div className="mt-3 text-xs text-muted">Exactly what will happen (approval is bound to this content; if it changes, you&apos;ll be asked again):</div>
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-bg-elev p-3 text-xs">{JSON.stringify(a.payload, null, 2)}</pre>
      <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={1} className="mt-3" placeholder="Note (optional)" maxLength={1000} />
      <div className="mt-2 flex gap-2">
        <Button onClick={() => onDecide(true, note)} loading={busy}><ShieldCheck className="h-4 w-4" /> Approve</Button>
        <Button variant="danger" onClick={() => onDecide(false, note)} disabled={busy}><ShieldX className="h-4 w-4" /> Reject</Button>
      </div>
    </Card>
  );
}

export function RunsList({ workflowId }: { workflowId?: string } = {}) {
  const runs = useEngine<{ runs: { id: string; workflow_name: string; version: number; status: string; mode: string; created_at: string; usage: Run["state"]["usage"] | null; error: string | null }[] }>(
    workflowId ? `lab/runs?workflow_id=${encodeURIComponent(workflowId)}` : "lab/runs",
  );
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Runs" description="Every workflow run with its status, mode and usage. Open one to see step-by-step logs." />
      <SectionTabs tabs={LAB_TABS} />
      {workflowId && (
        <p className="mb-3 text-sm text-muted">
          Showing runs of {runs.data?.runs[0]?.workflow_name ? <span className="font-medium text-fg">{runs.data.runs[0].workflow_name}</span> : "one workflow"}.{" "}
          <Link href="/lab/runs" className="text-accent hover:underline">Show all runs</Link>
        </p>
      )}
      {runs.error && <EngineError message={runs.error} />}
      {runs.data?.runs.length === 0 && <p className="text-sm text-faint">{workflowId ? "This workflow hasn’t run yet." : "No runs yet."}</p>}
      <div className="space-y-2">
        {runs.data?.runs.map((r) => (
          <Link key={r.id} href={`/lab/runs/${r.id}`} className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-panel p-3 text-sm hover:border-border-strong">
            <Badge tone={RUN_TONE[r.status] ?? "default"}>{r.status.replace("_", " ")}</Badge>
            <span className="font-medium">{r.workflow_name}</span>
            <span className="text-xs text-faint">{r.version > 0 ? `v${r.version}` : r.version < -9999 ? "test" : "draft"} · {r.mode.replace("_", " ")} · {relativeTime(r.created_at)}</span>
            <span className="ml-auto text-xs text-faint">{r.usage ? `${r.usage.model_calls} model calls · ${formatUsd(r.usage.cost_usd)}` : ""}</span>
            {r.error && <span className="w-full truncate text-xs text-danger">{r.error}</span>}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function ApprovalsInbox() {
  const ap = useEngine<{ approvals: Approval[] }>("lab/approvals?status=pending", { poll: 5000, pollWhile: () => true });
  const kinds = useEngine<Catalog>("lab/catalog").data?.approval_kinds ?? {};
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Approvals" description="Runs waiting for you. Orbis AI never sends, posts, deletes or shares sensitive data without an approval for that exact content." />
      <SectionTabs tabs={LAB_TABS} />
      {ap.error && <EngineError message={ap.error} />}
      {err && <Notice tone="danger" className="mb-3">{err}</Notice>}
      {ap.data?.approvals.length === 0 && <div className="flex items-center gap-2 text-sm text-faint"><Ban className="h-4 w-4" /> Nothing is waiting for approval.</div>}
      {ap.data?.approvals.map((a) => (
        <div key={a.id}>
          <Link href={`/lab/runs/${a.run_id}`} className="mb-1 block text-xs text-accent hover:underline">Open run →</Link>
          <ApprovalCard a={a} kinds={kinds} stepName={a.step_id} busy={false} onDecide={async (approve, note) => { try { await engine.post(`lab/approvals/${a.id}`, { decision: approve ? "approve" : "reject", note }); void ap.reload(); } catch (e) { setErr((e as Error).message); } }} />
        </div>
      ))}
    </div>
  );
}
