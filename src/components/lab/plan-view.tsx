"use client";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { AlertTriangle, ArrowRight, CircleHelp, Plus, ShieldAlert, Sparkles, Trash2, Wand2 } from "lucide-react";
import { SectionTabs } from "@/components/research/section-tabs";
import { Badge, Button, Card, Input, Notice, PageHeader, Select, Textarea } from "@/components/ui/primitives";
import { engine, useEngine } from "@/components/engine/api";
import { EngineError } from "@/components/engine/engine-error";
import { cn } from "@/lib/utils";
import { LAB_TABS } from "./lab-tabs";
import type { Catalog } from "./types";

const KINDS = ["research", "fetch", "analyze", "draft", "transform", "decide", "act", "save", "monitor", "deliver"] as const;

interface PlanTask {
  id: string;
  title: string;
  description: string;
  kind: (typeof KINDS)[number];
  depends_on: string[];
  tool: string | null;
  model: string | null;
  needs_approval: boolean;
  approval_reasons: string[];
  risk: "low" | "medium" | "high";
  params: Record<string, unknown>;
}

interface Plan {
  goal: string;
  interpreted_as: string;
  assumptions: string[];
  success_criteria: string[];
  open_questions: string[];
  inputs: unknown[];
  tasks: PlanTask[];
  warnings: string[];
  planner: "model" | "rules";
  estimate: { model_calls: number; cost_usd_max: number | null; approvals: string[]; external_services: string[] };
}

const EXAMPLES = [
  "Research the four-day work week and email a cited summary to alex@example.com",
  "Summarise https://en.wikipedia.org/wiki/Retrieval-augmented_generation and save it to my workspace",
  "Monitor open-source vector databases every week",
  "Compare Postgres and MongoDB for a small analytics team, with sources",
];

export function PlanView() {
  const router = useRouter();
  const catalog = useEngine<Catalog>("lab/catalog");
  const [goal, setGoal] = useState("");
  const [useModel, setUseModel] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const make = async () => {
    setBusy("plan");
    setError(null);
    try {
      setPlan(await engine.post<Plan>("lab/plan", { goal, use_model: useModel }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const recheck = async (p: Plan) => {
    try {
      setPlan(await engine.post<Plan>("lab/plan/review", p));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const edit = (id: string, patch: Partial<PlanTask>) => plan && setPlan({ ...plan, tasks: plan.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  const remove = (id: string) => plan && void recheck({ ...plan, tasks: plan.tasks.filter((t) => t.id !== id).map((t) => ({ ...t, depends_on: t.depends_on.filter((d) => d !== id) })) });
  const add = () => {
    if (!plan) return;
    const n = plan.tasks.length + 1;
    const last = plan.tasks.filter((t) => t.kind !== "deliver").at(-1);
    const task: PlanTask = { id: `task_${n}`, title: "New step", description: "", kind: "analyze", depends_on: last ? [last.id] : [], tool: null, model: null, needs_approval: false, approval_reasons: [], risk: "low", params: {} };
    const deliverIdx = plan.tasks.findIndex((t) => t.kind === "deliver");
    const tasks = [...plan.tasks];
    tasks.splice(deliverIdx >= 0 ? deliverIdx : tasks.length, 0, task);
    setPlan({ ...plan, tasks });
  };
  const build = async () => {
    if (!plan) return;
    setBusy("build");
    setError(null);
    try {
      const r = await engine.post<{ workflow_id: string }>("lab/plan/compile", { plan });
      router.push(`/lab/workflows/${r.workflow_id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };

  const tools = catalog.data?.tools ?? [];
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="AI Lab" description="Describe an outcome. NOVA AI proposes a plan you can edit — tasks, dependencies, tools and models — then turns it into a workflow you control. Nothing runs until you publish and start it." />
      <SectionTabs tabs={LAB_TABS} />
      {catalog.error && <div className="mb-4"><EngineError message={catalog.error} /></div>}

      <Card className="space-y-3 p-4">
        <div className="flex items-center gap-2 text-sm font-medium"><Wand2 className="h-4 w-4 text-accent" /> Intent-to-Outcome</div>
        <Textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={3} maxLength={4000} placeholder="What do you want to get done?" aria-label="Goal" />
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((x) => <button key={x} type="button" onClick={() => setGoal(x)} className="rounded-lg border border-border px-2 py-1 text-xs text-muted hover:text-fg">{x}</button>)}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={useModel} onChange={(e) => setUseModel(e.target.checked)} className="accent-[var(--accent)]" /> Ask a model to draft the plan (uses one model call; falls back to rules)
          </label>
          <Button onClick={make} loading={busy === "plan"} disabled={goal.trim().length < 5}><Sparkles className="h-4 w-4" /> Propose a plan</Button>
        </div>
        {error && <EngineError message={error} />}
      </Card>

      {plan && (
        <div className="mt-6 space-y-4">
          <Card className="p-4">
            <div className="flex flex-wrap items-center gap-2"><Badge tone="accent">{plan.planner === "model" ? "Model-drafted plan" : "Rule-based plan"}</Badge><span className="text-sm text-muted">Interpreted as: {plan.interpreted_as}</span></div>
            <div className="mt-3 grid gap-4 md:grid-cols-3">
              <ListBox title="Assumptions" items={plan.assumptions} />
              <ListBox title="Success criteria" items={plan.success_criteria} />
              <ListBox title="Open questions" items={plan.open_questions} icon={<CircleHelp className="h-3.5 w-3.5 text-warning" />} empty="None — but check the inputs before running." />
            </div>
            {plan.warnings.map((w) => <Notice key={w} tone="warning" className="mt-3">{w}</Notice>)}
          </Card>

          <div className="space-y-2">
            {plan.tasks.map((t, i) => (
              <Card key={t.id} className={cn("p-3", t.needs_approval && "border-warning/40")}>
                <div className="flex flex-wrap items-start gap-2">
                  <span className="mt-2 w-6 text-center font-mono text-xs text-faint">{i + 1}</span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Input value={t.title} onChange={(e) => edit(t.id, { title: e.target.value })} className="h-8 max-w-md" aria-label="Task title" />
                      <Select value={t.kind} onChange={(e) => edit(t.id, { kind: e.target.value as PlanTask["kind"] })} aria-label="Kind">{KINDS.map((k) => <option key={k}>{k}</option>)}</Select>
                      {["research", "fetch", "act", "save", "monitor"].includes(t.kind) && (
                        <Select value={t.tool ?? ""} onChange={(e) => edit(t.id, { tool: e.target.value || null })} aria-label="Tool">
                          <option value="">(default tool)</option>
                          {tools.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                        </Select>
                      )}
                      {["analyze", "draft", "transform"].includes(t.kind) && (
                        <Select value={t.model ?? ""} onChange={(e) => edit(t.id, { model: e.target.value || null })} aria-label="Model">
                          <option value="">(default model)</option>
                          {catalog.data?.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                        </Select>
                      )}
                      <Badge tone={t.risk === "high" ? "danger" : t.risk === "medium" ? "warning" : "default"}>{t.risk} risk</Badge>
                      {t.needs_approval && <Badge tone="warning"><ShieldAlert className="h-3 w-3" /> needs your approval</Badge>}
                    </div>
                    {t.description && <p className="text-xs text-muted">{t.description}</p>}
                    <div className="flex flex-wrap items-center gap-1 text-[11px] text-faint">
                      Depends on:
                      {plan.tasks.slice(0, i).map((d) => (
                        <button key={d.id} type="button" onClick={() => edit(t.id, { depends_on: t.depends_on.includes(d.id) ? t.depends_on.filter((x) => x !== d.id) : [...t.depends_on, d.id] })} className={cn("rounded border px-1.5 py-0.5", t.depends_on.includes(d.id) ? "border-accent text-accent" : "border-border")}>
                          {d.id}
                        </button>
                      ))}
                      {i === 0 && <span>nothing (first step)</span>}
                    </div>
                  </div>
                  <Button variant="ghost" size="icon" aria-label="Remove task" onClick={() => remove(t.id)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              </Card>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={add}><Plus className="h-3.5 w-3.5" /> Add step</Button>
              <Button variant="secondary" size="sm" onClick={() => recheck(plan)}>Re-check plan</Button>
            </div>
            <div className="text-xs text-muted">
              ≤ {plan.estimate.model_calls} model call(s) · cost {plan.estimate.cost_usd_max === null ? "unknown (prices not verified)" : `≤ $${plan.estimate.cost_usd_max}`} · {plan.estimate.approvals.length} approval gate(s)
              {plan.estimate.external_services.length > 0 && <> · sends data to: {plan.estimate.external_services.join(", ")}</>}
            </div>
            <Button onClick={build} loading={busy === "build"}>Build workflow <ArrowRight className="h-4 w-4" /></Button>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-faint"><AlertTriangle className="h-3.5 w-3.5" /> Approval requirements come from NOVA AI&apos;s policy, not from the plan: editing a task can&apos;t remove the gate on sending, posting or deleting.</p>
        </div>
      )}
    </div>
  );
}

function ListBox({ title, items, icon, empty = "None." }: { title: string; items: string[]; icon?: ReactNode; empty?: string }) {
  return (
    <div>
      <div className="flex items-center gap-1 text-xs font-medium text-muted">{icon}{title}</div>
      {items.length ? <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">{items.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="mt-1 text-sm text-faint">{empty}</p>}
    </div>
  );
}
