"use client";
import "@xyflow/react/dist/style.css";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Connection, type Edge, type Node, type NodeChange, type NodeProps, applyNodeChanges } from "@xyflow/react";
import { AlertTriangle, CheckCircle2, GitCompare, Play, Plus, Save, Send, TestTube2, Trash2, X } from "lucide-react";
import { SectionTabs } from "@/components/research/section-tabs";
import { Badge, Button, Card, Input, Notice, Select, Textarea } from "@/components/ui/primitives";
import { engine, useEngine } from "@/components/engine/api";
import { EngineError } from "@/components/engine/engine-error";
import { cn, relativeTime } from "@/lib/utils";
import { LAB_TABS } from "./lab-tabs";
import { NODE_COLOR, type Catalog, type NodeType, type Spec, type Validation, type WfNode, type Workflow } from "./types";

const DEFAULTS: Record<NodeType, Record<string, unknown>> = {
  input: {},
  model_call: { prompt: "", model: "default", max_tokens: 1200, output: "text" },
  retrieval: { source: "web_search", query: "{{inputs.topic}}", top_k: 5 },
  transform: { op: "template", template: "" },
  branch: { condition: "len(previous_step) > 0" },
  approval: { message: "Review before continuing.", show: [] },
  action: { tool: "workspace.create_item", params: { workspace_id: "{{inputs.workspace_id}}", title: "", body: "" } },
  output: { value: "" },
};

type FlowData = { node: WfNode; errors: string[]; warnings: string[] };

function StepNode({ data, selected }: NodeProps<Node<FlowData>>) {
  const n = data.node;
  return (
    <div className={cn("min-w-[170px] max-w-[220px] rounded-xl border bg-panel px-3 py-2 text-xs shadow-lg", selected ? "border-accent" : data.errors.length ? "border-danger/70" : "border-border-strong")}>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !bg-border-strong" />
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ background: NODE_COLOR[n.type] }} />
        <span className="text-[10px] uppercase tracking-wide text-faint">{n.type.replace("_", " ")}</span>
      </div>
      <div className="mt-0.5 truncate text-sm font-medium text-fg">{n.name}</div>
      <div className="font-mono text-[10px] text-faint">{n.id}</div>
      {n.type === "action" && <div className="mt-1 truncate text-[10px] text-muted">{String(n.config.tool)}</div>}
      {(data.errors.length > 0 || data.warnings.length > 0) && (
        <div className={cn("mt-1 text-[10px]", data.errors.length ? "text-danger" : "text-warning")}>{data.errors.length ? `${data.errors.length} error(s)` : `${data.warnings.length} note(s)`}</div>
      )}
      <Handle type="source" position={Position.Right} className="!h-2.5 !w-2.5 !bg-accent" />
    </div>
  );
}
const nodeTypes = { step: StepNode };

export function Composer({ id }: { id: string }) {
  const router = useRouter();
  const wf = useEngine<Workflow>(`lab/workflows/${id}`);
  const catalog = useEngine<Catalog>("lab/catalog");
  const [spec, setSpec] = useState<Spec | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<Validation | null>(null);
  const [panel, setPanel] = useState<"inspector" | "settings" | "tests" | "versions">("settings");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "success" | "danger" | "info"; text: string } | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const [flowNodes, setFlowNodes] = useState<Node<FlowData>[]>([]);

  // Seed local editing state from the server copy once it loads.
  if (wf.data && !spec) {
    setSpec(wf.data.draft);
    setValidation(wf.data.validation);
  }

  const update = useCallback((fn: (s: Spec) => Spec) => {
    setSpec((s) => (s ? fn(s) : s));
    setDirty(true);
  }, []);

  const errorsBy = useMemo(() => {
    const e: Record<string, string[]> = {};
    const w: Record<string, string[]> = {};
    for (const x of validation?.errors ?? []) (e[x.node] ??= []).push(x.message);
    for (const x of validation?.warnings ?? []) (w[x.node] ??= []).push(x.message);
    return { e, w };
  }, [validation]);

  useEffect(() => {
    if (!spec) return;
    // Rebuild canvas nodes from the spec (positions included) whenever it changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFlowNodes(
      spec.nodes.map((n, i) => ({
        id: n.id,
        type: "step",
        position: n.position ?? { x: (i % 5) * 250, y: Math.floor(i / 5) * 160 },
        data: { node: n, errors: errorsBy.e[n.id] ?? [], warnings: errorsBy.w[n.id] ?? [] },
        selected: n.id === selected,
      })),
    );
  }, [spec, errorsBy, selected]);

  const edges: Edge[] = useMemo(() => {
    if (!spec) return [];
    const out: Edge[] = [];
    for (const n of spec.nodes) {
      for (const d of n.depends_on) out.push({ id: `${d}->${n.id}`, source: d, target: n.id, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: "var(--border-strong)" } });
      if (n.when) out.push({ id: `when:${n.when.node}->${n.id}`, source: n.when.node, target: n.id, animated: true, label: n.when.equals ? "if true" : "if false", style: { stroke: NODE_COLOR.branch, strokeDasharray: "5 4" }, labelStyle: { fill: "var(--fg-muted)", fontSize: 10 }, labelBgStyle: { fill: "var(--panel)" }, deletable: false });
    }
    return out;
  }, [spec]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<FlowData>>[]) => {
      setFlowNodes((ns) => applyNodeChanges(changes, ns));
      for (const c of changes) {
        if (c.type === "position" && c.position && !c.dragging) update((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === c.id ? { ...n, position: { x: Math.round(c.position!.x), y: Math.round(c.position!.y) } } : n)) }));
        if (c.type === "select" && c.selected) {
          setSelected(c.id);
          setPanel("inspector");
        }
      }
    },
    [update],
  );
  const onConnect = useCallback((c: Connection) => c.source && c.target && c.source !== c.target && update((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === c.target && !n.depends_on.includes(c.source!) ? { ...n, depends_on: [...n.depends_on, c.source!] } : n)) })), [update]);
  const onEdgesDelete = useCallback((es: Edge[]) => update((s) => ({ ...s, nodes: s.nodes.map((n) => ({ ...n, depends_on: n.depends_on.filter((d) => !es.some((e) => e.source === d && e.target === n.id)) })) })), [update]);

  if (wf.error) return <div className="p-8"><EngineError message={wf.error} /></div>;
  if (!wf.data || !spec) return <div className="p-8 text-sm text-muted">Loading workflow…</div>;

  const node = spec.nodes.find((n) => n.id === selected) ?? null;

  const addNode = (type: NodeType) => {
    let i = spec.nodes.length + 1;
    while (spec.nodes.some((n) => n.id === `${type.split("_")[0]}_${i}`)) i++;
    const nid = `${type.split("_")[0]}_${i}`;
    const prev = spec.nodes.find((n) => n.id === selected);
    const pos = prev?.position ? { x: prev.position.x + 260, y: prev.position.y } : { x: 60 * spec.nodes.length, y: 260 };
    update((s) => ({ ...s, nodes: [...s.nodes, { id: nid, type, name: type.replace("_", " "), config: structuredClone(DEFAULTS[type]), depends_on: prev ? [prev.id] : [], when: null, retry: { max_attempts: 1, backoff_s: 1 }, timeout_s: 60, position: pos }], outputs: type === "output" ? [...s.outputs, nid] : s.outputs }));
    setSelected(nid);
    setPanel("inspector");
  };

  const save = async (): Promise<boolean> => {
    setBusy("save");
    setMsg(null);
    try {
      const r = await engine.put<Workflow>(`lab/workflows/${id}`, { spec });
      setValidation(r.validation);
      setDirty(false);
      void wf.reload();
      setMsg({ tone: r.validation.valid ? "success" : "info", text: r.validation.valid ? "Saved. The draft is valid." : "Saved. Fix the errors marked in red before publishing." });
      return true;
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
      return false;
    } finally {
      setBusy(null);
    }
  };
  const publish = async () => {
    if (dirty && !(await save())) return;
    const changelog = window.prompt("What changed in this version? (optional)") ?? "";
    setBusy("publish");
    try {
      const r = await engine.post<{ version: number; unchanged: boolean }>(`lab/workflows/${id}/publish`, { changelog });
      setMsg({ tone: "success", text: r.unchanged ? `No changes since v${r.version}.` : `Published version ${r.version}. Runs use this exact version.` });
      void wf.reload();
    } catch (e) {
      setMsg({ tone: "danger", text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col lg:h-dvh">
      <div className="border-b border-border px-4 pt-4 sm:px-6">
        <SectionTabs tabs={LAB_TABS} />
        <div className="-mt-3 mb-3 flex flex-wrap items-center gap-2">
          <Input value={spec.name} onChange={(e) => update((s) => ({ ...s, name: e.target.value }))} className="h-9 max-w-sm font-medium" aria-label="Workflow name" />
          <Badge tone={wf.data.status === "published" ? "success" : "default"}>{wf.data.status}{wf.data.latest_version ? ` · v${wf.data.latest_version}` : ""}</Badge>
          {(dirty || wf.data.draft_changed) && wf.data.latest_version > 0 && <Badge tone="warning">draft differs from v{wf.data.latest_version}</Badge>}
          {validation && (validation.valid ? <Badge tone="success"><CheckCircle2 className="h-3 w-3" /> valid</Badge> : <Badge tone="danger">{validation.errors.length} error(s)</Badge>)}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={save} loading={busy === "save"} disabled={!dirty}><Save className="h-3.5 w-3.5" /> Save draft</Button>
            <Button size="sm" variant="secondary" onClick={publish} loading={busy === "publish"}><Send className="h-3.5 w-3.5" /> Publish</Button>
            <Button size="sm" onClick={async () => { if (dirty && !(await save())) return; setRunOpen(true); }}><Play className="h-3.5 w-3.5" /> Run</Button>
          </div>
        </div>
        {msg && <Notice tone={msg.tone} className="mb-3">{msg.text}</Notice>}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[150px_minmax(0,1fr)_380px]">
        <div className="hidden border-r border-border p-3 lg:block">
          <div className="mb-2 text-xs font-medium text-faint">Add step</div>
          <div className="space-y-1">
            {(Object.keys(DEFAULTS) as NodeType[]).map((t) => (
              <button key={t} type="button" onClick={() => addNode(t)} title={catalog.data?.node_types[t]} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-muted hover:bg-panel-2 hover:text-fg">
                <span className="h-2 w-2 rounded-full" style={{ background: NODE_COLOR[t] }} /> {t.replace("_", " ")}
              </button>
            ))}
          </div>
          <p className="mt-4 text-[11px] text-faint">Drag between handles to add a dependency. Select an edge and press Backspace to remove it.</p>
        </div>
        <div className="h-[420px] min-h-0 lg:h-auto" aria-label="Workflow canvas">
          <ReactFlow
            nodes={flowNodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onConnect={onConnect}
            onEdgesDelete={onEdgesDelete}
            onPaneClick={() => { setSelected(null); setPanel("settings"); }}
            fitView
            colorMode="dark"
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} color="var(--border)" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside className="min-h-0 overflow-y-auto border-l border-border">
          <div className="flex gap-1 border-b border-border p-2 text-xs">
            {(["inspector", "settings", "tests", "versions"] as const).map((p) => (
              <button key={p} type="button" onClick={() => setPanel(p)} className={cn("rounded-md px-2 py-1 capitalize", panel === p ? "bg-accent-soft text-fg" : "text-muted hover:text-fg")}>{p === "inspector" ? "Step" : p}</button>
            ))}
          </div>
          <div className="p-3">
            {panel === "inspector" && (node ? <Inspector node={node} spec={spec} catalog={catalog.data} errors={errorsBy.e[node.id] ?? []} warnings={errorsBy.w[node.id] ?? []} update={update} onDelete={() => { update((s) => ({ ...s, nodes: s.nodes.filter((n) => n.id !== node.id).map((n) => ({ ...n, depends_on: n.depends_on.filter((d) => d !== node.id), when: n.when?.node === node.id ? null : n.when })), outputs: s.outputs.filter((o) => o !== node.id) })); setSelected(null); setPanel("settings"); }} /> : <p className="text-sm text-faint">Select a step on the canvas.</p>)}
            {panel === "settings" && <Settings spec={spec} catalog={catalog.data} update={update} validation={validation} />}
            {panel === "tests" && <Tests id={id} initial={wf.data.tests} save={async (tests) => { await engine.put(`lab/workflows/${id}`, { spec, tests }); setDirty(false); }} />}
            {panel === "versions" && <Versions id={id} wf={wf.data} />}
          </div>
        </aside>
      </div>
      {runOpen && <RunDialog wf={wf.data} spec={spec} onClose={() => setRunOpen(false)} onStarted={(rid) => router.push(`/lab/runs/${rid}`)} />}
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}

function Inspector({ node, spec, catalog, errors, warnings, update, onDelete }: { node: WfNode; spec: Spec; catalog: Catalog | null; errors: string[]; warnings: string[]; update: (fn: (s: Spec) => Spec) => void; onDelete: () => void }) {
  const set = (patch: Partial<WfNode>) => update((s) => ({ ...s, nodes: s.nodes.map((n) => (n.id === node.id ? { ...n, ...patch } : n)) }));
  const setCfg = (k: string, v: unknown) => set({ config: { ...node.config, [k]: v } });
  const [raw, setRaw] = useState<string | null>(null);
  const c = node.config as Record<string, unknown>;
  const branches = spec.nodes.filter((n) => n.type === "branch" && n.id !== node.id);
  const tool = catalog?.tools.find((t) => t.id === c.tool);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: NODE_COLOR[node.type] }} />
        <span className="text-sm font-medium capitalize">{node.type.replace("_", " ")}</span>
        <span className="font-mono text-xs text-faint">{node.id}</span>
        <Button variant="ghost" size="icon" className="ml-auto" onClick={onDelete} aria-label="Delete step"><Trash2 className="h-4 w-4" /></Button>
      </div>
      <p className="text-[11px] text-faint">{catalog?.node_types[node.type]}</p>
      {errors.map((e) => <Notice key={e} tone="danger">{e}</Notice>)}
      {warnings.map((e) => <Notice key={e} tone="warning">{e}</Notice>)}
      <Field label="Name"><Input value={node.name} onChange={(e) => set({ name: e.target.value })} className="h-8" /></Field>

      {node.type === "model_call" && (
        <>
          <Field label="Model"><Select value={String(c.model ?? "default")} onChange={(e) => setCfg("model", e.target.value)} className="w-full"><option value="default">Default</option>{catalog?.models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.priced ? "" : " (price unverified)"}</option>)}</Select></Field>
          <Field label="Prompt" hint="Reference data with {{inputs.name}} or {{nodes.step_id.output}}. Untrusted step outputs are wrapped and labelled automatically."><Textarea value={String(c.prompt ?? "")} onChange={(e) => setCfg("prompt", e.target.value)} rows={7} className="font-mono text-xs" /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Output"><Select value={String(c.output ?? "text")} onChange={(e) => setCfg("output", e.target.value)} className="w-full"><option>text</option><option>json</option></Select></Field>
            <Field label="Max tokens"><Input type="number" value={Number(c.max_tokens ?? 1200)} onChange={(e) => setCfg("max_tokens", Number(e.target.value))} className="h-9" /></Field>
          </div>
        </>
      )}
      {node.type === "retrieval" && (
        <>
          <Field label="Source"><Select value={String(c.source)} onChange={(e) => setCfg("source", e.target.value)} className="w-full"><option value="web_search">Web search</option><option value="workspace">Workspace</option><option value="radar">Radar items</option><option value="url">URL (allow-listed)</option></Select></Field>
          {c.source === "url" ? <Field label="URL"><Input value={String(c.url ?? "")} onChange={(e) => setCfg("url", e.target.value)} className="h-8" /></Field> : <Field label="Query"><Input value={String(c.query ?? "")} onChange={(e) => setCfg("query", e.target.value)} className="h-8" /></Field>}
          {c.source === "workspace" && <Field label="Workspace id"><Input value={String(c.workspace_id ?? "")} onChange={(e) => setCfg("workspace_id", e.target.value)} className="h-8 font-mono text-xs" /></Field>}
          <Field label="Max results"><Input type="number" min={1} max={10} value={Number(c.top_k ?? 5)} onChange={(e) => setCfg("top_k", Number(e.target.value))} className="h-8" /></Field>
          <Notice tone="info">Retrieved content is untrusted: it is shown to models as data only and can&apos;t trigger actions.</Notice>
        </>
      )}
      {node.type === "transform" && (
        <>
          <Field label="Operation"><Select value={String(c.op)} onChange={(e) => setCfg("op", e.target.value)} className="w-full">{["template", "extract_json", "regex_extract", "pick", "join", "truncate", "count", "lowercase", "split_lines"].map((o) => <option key={o}>{o}</option>)}</Select></Field>
          {c.op === "template" ? <Field label="Template"><Textarea value={String(c.template ?? "")} onChange={(e) => setCfg("template", e.target.value)} rows={4} className="font-mono text-xs" /></Field> : <Field label="Input"><Input value={String(c.input ?? "")} onChange={(e) => setCfg("input", e.target.value)} className="h-8 font-mono text-xs" placeholder="{{nodes.step.output}}" /></Field>}
          {c.op === "pick" && <Field label="Path"><Input value={String(c.path ?? "")} onChange={(e) => setCfg("path", e.target.value)} className="h-8" placeholder="title or items.0.url" /></Field>}
          {c.op === "regex_extract" && <Field label="Pattern"><Input value={String(c.pattern ?? "")} onChange={(e) => setCfg("pattern", e.target.value)} className="h-8 font-mono text-xs" /></Field>}
          {c.op === "join" && <Field label="Format per item" hint="e.g. [{n}] {title} — {url}"><Input value={String(c.format ?? "")} onChange={(e) => setCfg("format", e.target.value)} className="h-8" /></Field>}
          {c.op === "truncate" && <Field label="Max characters"><Input type="number" value={Number(c.max_chars ?? 2000)} onChange={(e) => setCfg("max_chars", Number(e.target.value))} className="h-8" /></Field>}
        </>
      )}
      {node.type === "branch" && <Field label="Condition" hint="Safe expression over step outputs (by id) and inputs (input_name). Functions: len, lower, upper, contains, startswith, str, int, float."><Input value={String(c.condition ?? "")} onChange={(e) => setCfg("condition", e.target.value)} className="h-8 font-mono text-xs" /></Field>}
      {node.type === "approval" && (
        <>
          <Field label="Message to the approver"><Textarea value={String(c.message ?? "")} onChange={(e) => setCfg("message", e.target.value)} rows={3} /></Field>
          <Field label="Show outputs of (step ids, comma-separated)"><Input value={((c.show as string[]) ?? []).join(", ")} onChange={(e) => setCfg("show", e.target.value.split(",").map((x) => x.trim()).filter(Boolean))} className="h-8" /></Field>
        </>
      )}
      {node.type === "action" && (
        <>
          <Field label="Tool"><Select value={String(c.tool)} onChange={(e) => { const t = catalog?.tools.find((x) => x.id === e.target.value); set({ config: { tool: e.target.value, params: Object.fromEntries((t?.required_params ?? []).map((p) => [p, ""])) } }); }} className="w-full">{catalog?.tools.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
          {tool && (
            <div className="space-y-1 rounded-lg border border-border p-2 text-[11px] text-muted">
              <div>{tool.description}</div>
              <div className="flex flex-wrap gap-1"><Badge tone={tool.consequential ? "warning" : "default"}>{tool.risk.replace("_", " ")}</Badge>{tool.data_egress && <Badge>sends data out</Badge>}{tool.consequential && <Badge tone="warning">always needs approval</Badge>}{!tool.granted && <Badge tone="danger">not enabled in Tool permissions</Badge>}{!spec.permissions.tools.includes(tool.id) && <Badge tone="danger">not in workflow permissions</Badge>}</div>
            </div>
          )}
          {Object.entries((c.params as Record<string, unknown>) ?? {}).map(([k, v]) => (
            <Field key={k} label={k}><Textarea value={typeof v === "string" ? v : JSON.stringify(v)} onChange={(e) => setCfg("params", { ...(c.params as object), [k]: e.target.value })} rows={k === "body" ? 4 : 1} className="font-mono text-xs" /></Field>
          ))}
        </>
      )}
      {node.type === "output" && <Field label="Value"><Textarea value={String(c.value ?? "")} onChange={(e) => setCfg("value", e.target.value)} rows={3} className="font-mono text-xs" /></Field>}

      <div className="grid grid-cols-2 gap-2 border-t border-border pt-3">
        <Field label="Run only when"><Select value={node.when?.node ?? ""} onChange={(e) => set({ when: e.target.value ? { node: e.target.value, equals: node.when?.equals ?? true } : null })} className="w-full"><option value="">always</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.id}</option>)}</Select></Field>
        {node.when && <Field label="is"><Select value={String(node.when.equals)} onChange={(e) => set({ when: { node: node.when!.node, equals: e.target.value === "true" } })} className="w-full"><option value="true">true</option><option value="false">false</option></Select></Field>}
        <Field label="Attempts (retries)"><Input type="number" min={1} max={5} value={node.retry?.max_attempts ?? 1} onChange={(e) => set({ retry: { max_attempts: Number(e.target.value), backoff_s: node.retry?.backoff_s ?? 1 } })} className="h-8" /></Field>
        <Field label="Timeout (s)"><Input type="number" min={1} max={600} value={node.timeout_s ?? 60} onChange={(e) => set({ timeout_s: Number(e.target.value) })} className="h-8" /></Field>
      </div>
      <div className="text-[11px] text-faint">Depends on: {node.depends_on.join(", ") || "nothing"}</div>
      <details className="text-xs">
        <summary className="cursor-pointer text-accent" onClick={() => setRaw(JSON.stringify(node.config, null, 2))}>Edit raw config (JSON)</summary>
        {raw !== null && (
          <div className="mt-2 space-y-2">
            <Textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={8} className="font-mono text-xs" />
            <Button size="sm" variant="secondary" onClick={() => { try { set({ config: JSON.parse(raw) }); } catch { window.alert("Invalid JSON"); } }}>Apply</Button>
          </div>
        )}
      </details>
    </div>
  );
}

function Settings({ spec, catalog, update, validation }: { spec: Spec; catalog: Catalog | null; update: (fn: (s: Spec) => Spec) => void; validation: Validation | null }) {
  const set = (patch: Partial<Spec>) => update((s) => ({ ...s, ...patch }));
  return (
    <div className="space-y-4">
      {validation?.estimate && (
        <div className="rounded-xl border border-border bg-bg-elev p-3 text-xs text-muted">
          <div className="font-medium text-fg">Estimate (worst case)</div>
          <div>≤ {validation.estimate.model_calls_max} model calls · ≤ {validation.estimate.output_tokens_max.toLocaleString()} output tokens · cost {validation.estimate.cost_usd_max === null ? "unknown (unverified prices)" : `≤ $${validation.estimate.cost_usd_max}`}</div>
          {validation.estimate.consequential_steps.length > 0 && <div className="mt-1 flex items-center gap-1 text-warning"><AlertTriangle className="h-3 w-3" /> Approval gates: {validation.estimate.consequential_steps.join(", ")}</div>}
          {validation.warnings.filter((w) => !w.node).map((w) => <div key={w.message} className="mt-1 text-warning">{w.message}</div>)}
          {validation.errors.filter((w) => !w.node).map((w) => <div key={w.message} className="mt-1 text-danger">{w.message}</div>)}
        </div>
      )}
      <Field label="Description"><Textarea value={spec.description} onChange={(e) => set({ description: e.target.value })} rows={2} /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Trigger"><Select value={spec.trigger.type} onChange={(e) => set({ trigger: { type: e.target.value as Spec["trigger"]["type"], config: e.target.value === "schedule" ? { every: "daily", at_hour_utc: 8 } : {} } })} className="w-full"><option value="manual">Manual</option><option value="schedule">Schedule</option><option value="radar_signal">Radar signal</option><option value="webhook">Webhook (planned)</option></Select></Field>
        {spec.trigger.type === "schedule" && <Field label="Every"><Select value={String(spec.trigger.config.every ?? "daily")} onChange={(e) => set({ trigger: { ...spec.trigger, config: { ...spec.trigger.config, every: e.target.value } } })} className="w-full"><option>hourly</option><option>daily</option><option>weekly</option></Select></Field>}
        {spec.trigger.type === "radar_signal" && <Field label="Radar watch id"><Input value={String(spec.trigger.config.watch_id ?? "")} onChange={(e) => set({ trigger: { ...spec.trigger, config: { watch_id: e.target.value } } })} className="h-8 font-mono text-xs" /></Field>}
      </div>
      {spec.trigger.type !== "manual" && <p className="text-[11px] text-faint">Scheduled and signal triggers run only while the Orbis worker process is running, and stop at every approval gate until you approve.</p>}

      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-muted">Inputs <Button size="sm" variant="ghost" onClick={() => set({ inputs: [...spec.inputs, { name: `input_${spec.inputs.length + 1}`, type: "string", required: true, sensitive: false }] })}><Plus className="h-3 w-3" /></Button></div>
        <div className="space-y-2">
          {spec.inputs.map((i, k) => (
            <div key={k} className="grid grid-cols-[1fr_90px_auto] items-center gap-1 rounded-lg border border-border p-2 text-xs">
              <Input value={i.name} onChange={(e) => set({ inputs: spec.inputs.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)) })} className="h-7 font-mono text-xs" aria-label="Input name" />
              <Select value={i.type} onChange={(e) => set({ inputs: spec.inputs.map((x, j) => (j === k ? { ...x, type: e.target.value as typeof i.type } : x)) })} className="h-7 text-xs">{["string", "text", "number", "boolean", "json"].map((t) => <option key={t}>{t}</option>)}</Select>
              <button type="button" aria-label="Remove input" onClick={() => set({ inputs: spec.inputs.filter((_, j) => j !== k) })}><X className="h-3.5 w-3.5 text-faint" /></button>
              <label className="col-span-3 flex gap-3 text-[11px] text-muted">
                <span className="flex items-center gap-1"><input type="checkbox" checked={i.required} onChange={(e) => set({ inputs: spec.inputs.map((x, j) => (j === k ? { ...x, required: e.target.checked } : x)) })} /> required</span>
                <span className="flex items-center gap-1"><input type="checkbox" checked={i.sensitive} onChange={(e) => set({ inputs: spec.inputs.map((x, j) => (j === k ? { ...x, sensitive: e.target.checked } : x)) })} /> sensitive (masked in logs, gated before leaving Orbis)</span>
              </label>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted">Budget limits</div>
        <div className="grid grid-cols-2 gap-2">
          {([["max_cost_usd", "Max cost ($)"], ["max_model_calls", "Max model calls"], ["max_tokens", "Max tokens"], ["max_duration_s", "Max duration (s)"]] as const).map(([k, l]) => (
            <Field key={k} label={l}><Input type="number" value={spec.budget[k]} onChange={(e) => set({ budget: { ...spec.budget, [k]: Number(e.target.value) } })} className="h-8" /></Field>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted">Permissions — what this workflow may use</div>
        <div className="space-y-1">
          {catalog?.tools.map((t) => (
            <label key={t.id} className="flex items-start gap-2 text-xs">
              <input type="checkbox" className="mt-0.5" checked={spec.permissions.tools.includes(t.id)} onChange={(e) => set({ permissions: { ...spec.permissions, tools: e.target.checked ? [...spec.permissions.tools, t.id] : spec.permissions.tools.filter((x) => x !== t.id) } })} />
              <span>{t.name} <span className="text-faint">· {t.risk.replace("_", " ")}{t.consequential ? " · approval required" : ""}{!t.granted ? " · you haven't enabled it" : ""}</span></span>
            </label>
          ))}
        </div>
        <Field label="Allowed network domains (comma-separated)" hint="Used by URL fetch and HTTP tools. Internal addresses are always blocked."><Input value={spec.permissions.network_domains.join(", ")} onChange={(e) => set({ permissions: { ...spec.permissions, network_domains: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) } })} className="h-8" /></Field>
        <label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={spec.permissions.allow_external_models} onChange={(e) => set({ permissions: { ...spec.permissions, allow_external_models: e.target.checked } })} /> Allow external model providers</label>
        <label className="mt-1 flex items-center gap-2 text-xs"><input type="checkbox" checked={spec.permissions.share_sensitive_with_models} onChange={(e) => set({ permissions: { ...spec.permissions, share_sensitive_with_models: e.target.checked } })} /> Send sensitive inputs to models without asking each time</label>
      </div>
    </div>
  );
}

function Tests({ id, initial, save }: { id: string; initial: unknown[]; save: (tests: unknown[]) => Promise<void> }) {
  const [text, setText] = useState(JSON.stringify(initial.length ? initial : [{ name: "happy path", inputs: {}, mocks: {}, expect: [{ node: "$run", op: "run_status", value: "succeeded" }] }], null, 2));
  const [res, setRes] = useState<{ results: { name: string; passed: boolean; checks: { ok: boolean; message: string }[] }[]; summary: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setErr(null);
    try {
      await save(JSON.parse(text));
      setRes(await engine.post(`lab/workflows/${id}/test`));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="space-y-2">
      <p className="text-[11px] text-faint">Tests run in test mode: actions are simulated, approvals auto-granted, paid models replaced by the demo model, and any step can be mocked. Publishing requires all tests to pass.</p>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} className="font-mono text-xs" aria-label="Test cases JSON" />
      <Button size="sm" onClick={run}><TestTube2 className="h-3.5 w-3.5" /> Save & run tests</Button>
      {err && <Notice tone="danger">{err}</Notice>}
      {res && (
        <div className="space-y-2 text-xs">
          <div className="font-medium">{res.summary}</div>
          {res.results.map((r) => (
            <div key={r.name} className={cn("rounded-lg border p-2", r.passed ? "border-success/40" : "border-danger/40")}>
              <div className="font-medium">{r.passed ? "✓" : "✗"} {r.name}</div>
              {r.checks.map((c, i) => <div key={i} className={c.ok ? "text-muted" : "text-danger"}>{c.message}</div>)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Versions({ id, wf }: { id: string; wf: Workflow }) {
  const published = wf.versions.filter((v) => v.version > 0);
  const [diff, setDiff] = useState<{ added: string[]; removed: string[]; changed: string[]; settings_changed: string[]; unified: string } | null>(null);
  return (
    <div className="space-y-2 text-xs">
      {published.length === 0 && <p className="text-faint">Not published yet. Live runs always use an immutable published version.</p>}
      {published.map((v, i) => (
        <div key={v.version} className="rounded-lg border border-border p-2">
          <div className="flex items-center gap-2"><Badge tone={i === 0 ? "success" : "default"}>v{v.version}</Badge><span className="text-faint">{relativeTime(v.created_at)}</span><span className="font-mono text-[10px] text-faint">{v.spec_hash.slice(0, 10)}</span></div>
          {v.changelog && <div className="mt-1 text-muted">{v.changelog}</div>}
          {i > 0 && <Button size="sm" variant="ghost" className="mt-1" onClick={async () => setDiff(await engine.get(`lab/workflows/${id}/diff?a=${v.version}&b=${published[0]!.version}`))}><GitCompare className="h-3 w-3" /> Compare with v{published[0]!.version}</Button>}
        </div>
      ))}
      {diff && (
        <div className="space-y-1 rounded-lg border border-border p-2">
          <div>Added: {diff.added.join(", ") || "—"} · Removed: {diff.removed.join(", ") || "—"} · Changed: {diff.changed.join(", ") || "—"}</div>
          {diff.settings_changed.length > 0 && <div>Settings changed: {diff.settings_changed.join(", ")}</div>}
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-[10px] text-muted">{diff.unified}</pre>
        </div>
      )}
      <Link href={`/lab/runs?workflow=${id}`} className="block text-accent hover:underline">See runs of this workflow →</Link>
    </div>
  );
}

function RunDialog({ wf, spec, onClose, onStarted }: { wf: Workflow; spec: Spec; onClose: () => void; onStarted: (id: string) => void }) {
  const [inputs, setInputs] = useState<Record<string, string>>(Object.fromEntries(spec.inputs.map((i) => [i.name, i.default == null ? "" : String(i.default)])));
  const [mode, setMode] = useState<"dry_run" | "live">(wf.latest_version ? "live" : "dry_run");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await engine.post<{ id: string }>(`lab/workflows/${wf.id}/runs`, { inputs, mode });
      onStarted(r.id);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label="Run workflow">
      <Card className="w-full max-w-lg space-y-3 p-5">
        <div className="flex items-center justify-between"><div className="font-medium">Run “{spec.name}”</div><Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></Button></div>
        <Select value={mode} onChange={(e) => setMode(e.target.value as "dry_run" | "live")} className="w-full">
          <option value="dry_run">Dry run — nothing external happens; actions are simulated</option>
          <option value="live" disabled={!wf.latest_version}>Live — uses published v{wf.latest_version || "?"}{wf.draft_changed ? " (not your latest edits)" : ""}</option>
        </Select>
        {spec.inputs.map((i) => (
          <Field key={i.name} label={`${i.label || i.name}${i.required ? " *" : ""}${i.sensitive ? " (sensitive)" : ""}`}>
            {i.type === "text" ? <Textarea value={inputs[i.name] ?? ""} onChange={(e) => setInputs({ ...inputs, [i.name]: e.target.value })} rows={3} /> : <Input type={i.sensitive ? "password" : "text"} value={inputs[i.name] ?? ""} onChange={(e) => setInputs({ ...inputs, [i.name]: e.target.value })} className="h-9" />}
          </Field>
        ))}
        <p className="text-[11px] text-faint">Budget: ≤ ${spec.budget.max_cost_usd} · ≤ {spec.budget.max_model_calls} model calls · ≤ {spec.budget.max_duration_s}s. Consequential steps pause for your approval.</p>
        {err && <Notice tone="danger">{err}</Notice>}
        <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={start} loading={busy}><Play className="h-4 w-4" /> Start</Button></div>
      </Card>
    </div>
  );
}
