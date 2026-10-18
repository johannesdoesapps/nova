"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Copy, Plus, Workflow as WorkflowIcon } from "lucide-react";
import { SectionTabs } from "@/components/research/section-tabs";
import { Badge, Button, Card, EmptyState, Notice, PageHeader } from "@/components/ui/primitives";
import { engine, useEngine } from "@/components/engine/api";
import { EngineError } from "@/components/engine/engine-error";
import { relativeTime } from "@/lib/utils";
import { LAB_TABS } from "./lab-tabs";
import type { Catalog, Tool } from "./types";

export function WorkflowsList() {
  const router = useRouter();
  const list = useEngine<{ workflows: { id: string; name: string; status: string; latest_version: number; updated_at: string; template_id: string | null }[] }>("lab/workflows");
  const create = async () => {
    const w = await engine.post<{ id: string }>("lab/workflows", { spec: { name: "Untitled workflow", nodes: [{ id: "result", type: "output", name: "Result", config: { value: "Hello" }, position: { x: 0, y: 0 } }], outputs: ["result"] } });
    router.push(`/lab/workflows/${w.id}`);
  };
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Workflows" description="Versioned workflows built in the Intelligence Composer." actions={<Button onClick={create}><Plus className="h-4 w-4" /> Blank workflow</Button>} />
      <SectionTabs tabs={LAB_TABS} />
      {list.error && <EngineError message={list.error} />}
      {list.data?.workflows.length === 0 && <EmptyState icon={<WorkflowIcon className="h-8 w-8" />} title="No workflows yet" action={<Link href="/lab" className="text-sm text-accent hover:underline">Start from a goal</Link>}>Describe a goal, start from a template, or build one from scratch.</EmptyState>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {list.data?.workflows.filter((w) => w.status !== "archived").map((w) => (
          <Link key={w.id} href={`/lab/workflows/${w.id}`} className="rounded-2xl border border-border bg-panel p-4 hover:border-border-strong">
            <div className="flex items-center gap-2"><Badge tone={w.status === "published" ? "success" : "default"}>{w.status}{w.latest_version ? ` v${w.latest_version}` : ""}</Badge>{w.template_id && <Badge>template</Badge>}</div>
            <div className="mt-2 font-medium">{w.name}</div>
            <div className="text-xs text-faint">Updated {relativeTime(w.updated_at)}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function TemplatesGallery() {
  const router = useRouter();
  const cat = useEngine<Catalog>("lab/catalog");
  const [err, setErr] = useState<string | null>(null);
  const use = async (tid: string) => {
    try {
      const w = await engine.post<{ id: string }>("lab/workflows", { template_id: tid });
      router.push(`/lab/workflows/${w.id}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Workflow templates" description="Reusable starting points. Using one copies it into your own draft; approvals and permissions still apply." />
      <SectionTabs tabs={LAB_TABS} />
      {cat.error && <EngineError message={cat.error} />}
      {err && <Notice tone="danger" className="mb-3">{err}</Notice>}
      <div className="grid gap-3 md:grid-cols-2">
        {cat.data?.templates.map((t) => (
          <Card key={t.id} className="flex flex-col p-4">
            <div className="flex flex-wrap items-center gap-2"><Badge tone="accent">{t.category}</Badge><Badge>{t.trigger}</Badge><span className="text-xs text-faint">{t.node_count} steps</span></div>
            <div className="mt-2 font-medium">{t.name}</div>
            <p className="mt-1 flex-1 text-sm text-muted">{t.description}</p>
            <div className="mt-2 text-xs text-faint">Tools: {t.tools.join(", ") || "none"}</div>
            <div className="text-xs text-faint">Needs: {t.requires.join("; ")}</div>
            <Button size="sm" className="mt-3 self-start" onClick={() => use(t.id)}><Copy className="h-3.5 w-3.5" /> Use template</Button>
          </Card>
        ))}
      </div>
    </div>
  );
}

const RISK_COPY: Record<Tool["risk"], string> = {
  read: "Reads data",
  internal_write: "Writes inside NOVA AI",
  external_send: "Sends or posts outside NOVA AI — always asks first",
  irreversible: "Cannot be undone — always asks first",
};

export function ToolsPermissions() {
  const cat = useEngine<Catalog>("lab/catalog");
  const [err, setErr] = useState<string | null>(null);
  const toggle = async (t: Tool) => {
    const flip = (granted: boolean) => cat.setData((d) => (d ? { ...d, tools: d.tools.map((x) => (x.id === t.id ? { ...x, granted } : x)) } : d));
    flip(!t.granted); // optimistic; rolled back if the engine refuses
    try {
      await engine.put(`lab/tools/${t.id}`, { granted: !t.granted });
    } catch (e) {
      flip(t.granted);
      setErr((e as Error).message);
    }
  };
  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-8 sm:px-6">
      <PageHeader title="Tool permissions" description="Which tools your workflows may use at all. A workflow also has to list a tool in its own permissions, and consequential tools pause for approval every time." />
      <SectionTabs tabs={LAB_TABS} />
      {cat.error && <EngineError message={cat.error} />}
      {err && <Notice tone="danger" className="mb-3">{err}</Notice>}
      <div className="space-y-2">
        {cat.data?.tools.map((t) => (
          <Card key={t.id} className="flex flex-wrap items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{t.name}</span><span className="font-mono text-xs text-faint">{t.id}</span><Badge tone={t.consequential ? "warning" : "default"}>{RISK_COPY[t.risk]}</Badge>{t.data_egress && <Badge>data leaves NOVA AI</Badge>}{t.implementation !== "real" && <Badge tone="warning">{t.implementation === "needs_config" ? "simulated until configured" : t.implementation}</Badge>}{t.connector && <Badge>needs {t.connector} connection</Badge>}</div>
              <p className="mt-1 text-sm text-muted">{t.description}</p>
              {t.notes && <p className="text-xs text-faint">{t.notes}</p>}
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={t.granted} onChange={() => toggle(t)} className="h-4 w-4 accent-[var(--accent)]" /> Enabled</label>
          </Card>
        ))}
      </div>
    </div>
  );
}
