"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Dialog } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import { btn, btnPrimary, field, label } from "./bits";

export interface ProjectLite {
  id: string;
  name: string;
  repo: string;
  branch: string;
}

const RANK = { assist: 0, collaborate: 1, execute: 2 } as const;
const AUTONOMY_INFO = {
  assist: "Analyse and plan only. No changes are made.",
  collaborate: "Builds in an isolated workspace after you approve the plan.",
  execute: "Proceeds automatically for low/medium-risk plans; high-risk plans still need approval. Nothing is pushed or deployed.",
};

export function NewTaskDialog({ open, onClose, projects, maxAutonomy, defaultBudget, maxBudget }: { open: boolean; onClose: () => void; projects: ProjectLite[]; maxAutonomy: keyof typeof RANK; defaultBudget: number; maxBudget: number }) {
  const router = useRouter();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [criteria, setCriteria] = useState("");
  const [priority, setPriority] = useState("medium");
  const [autonomy, setAutonomy] = useState<keyof typeof RANK>("collaborate");
  const [budget, setBudget] = useState(String(defaultBudget));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await jsonFetch<{ task: { id: string } }>("/api/workforce/tasks", {
        method: "POST",
        body: JSON.stringify({ projectId, title, objective, acceptanceCriteria: criteria.split("\n").map((c) => c.trim()).filter((c) => c.length >= 3), priority, autonomy, budgetUsd: Number(budget) }),
      });
      onClose();
      router.push(`/workforce/tasks/${r.task.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New engineering task" description="Orbis Commander plans it, the specialist agents build and check it in an isolated workspace, and nothing ships without you." width={620}>
      {projects.length === 0 ? (
        <p className="text-[14px] text-s-ink-2">Register a project first (Projects tab).</p>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="nt-project" className={label}>
                Project
              </label>
              <select id="nt-project" value={projectId} onChange={(e) => setProjectId(e.target.value)} className={field}>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.repo}@{p.branch}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="nt-priority" className={label}>
                Priority
              </label>
              <select id="nt-priority" value={priority} onChange={(e) => setPriority(e.target.value)} className={field}>
                {["low", "medium", "high", "urgent"].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="nt-title" className={label}>
              Title
            </label>
            <input id="nt-title" value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} maxLength={200} placeholder="Add rate-limit headers to the chat API" className={field} />
          </div>
          <div>
            <label htmlFor="nt-objective" className={label}>
              What should be done
            </label>
            <textarea id="nt-objective" value={objective} onChange={(e) => setObjective(e.target.value)} required minLength={10} rows={4} placeholder="Describe the change, where it applies and any constraints." className={field} />
          </div>
          <div>
            <label htmlFor="nt-criteria" className={label}>
              Acceptance criteria (one per line)
            </label>
            <textarea id="nt-criteria" value={criteria} onChange={(e) => setCriteria(e.target.value)} rows={3} placeholder={"Responses include X-RateLimit-Remaining\nA unit test covers the header"} className={field} />
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
            <fieldset>
              <legend className={label}>Autonomy</legend>
              <div className="space-y-1.5">
                {(Object.keys(RANK) as (keyof typeof RANK)[]).map((a) => (
                  <label key={a} className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-[13px] ${autonomy === a ? "border-s-line-strong bg-s-hover" : "border-s-line"} ${RANK[a] > RANK[maxAutonomy] ? "pointer-events-none opacity-40" : ""}`}>
                    <input type="radio" name="autonomy" value={a} checked={autonomy === a} disabled={RANK[a] > RANK[maxAutonomy]} onChange={() => setAutonomy(a)} className="mt-0.5 accent-[var(--s-accent)]" />
                    <span>
                      <span className="font-medium capitalize">{a}</span>
                      <span className="block text-[12px] text-s-ink-3">
                        {AUTONOMY_INFO[a]}
                        {RANK[a] > RANK[maxAutonomy] ? " (above the allowed maximum in Settings)" : ""}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <label htmlFor="nt-budget" className={label}>
                Budget (USD)
              </label>
              <input id="nt-budget" type="number" min={0.01} max={maxBudget} step={0.01} value={budget} onChange={(e) => setBudget(e.target.value)} className={field} />
              <p className="mt-1 text-[11.5px] text-s-ink-3">Estimated model cost cap; work stops and asks before exceeding it. Max ${maxBudget}.</p>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-[13px] text-s-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={btn}>
              Cancel
            </button>
            <button type="submit" disabled={busy || !projectId} className={btnPrimary}>
              {busy ? <Loader2 className="animate-spin" /> : <Plus />} Create task
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
