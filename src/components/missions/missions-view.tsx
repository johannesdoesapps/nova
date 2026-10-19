"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRight, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useCatalog } from "@/components/common/model-picker";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { ModelSelector } from "@/components/studio/model-selector";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { MissionPlan } from "@/lib/missions/schema";
import { cn } from "@/lib/utils";
import { StatusPill, progressOf } from "./mission-bits";

type Counts = Record<"pending" | "in_progress" | "completed" | "blocked" | "cancelled", number>;
interface MissionSummary {
  id: string;
  name: string;
  goal: string | null;
  status: "active" | "paused" | "completed" | "archived";
  updated_at: string;
  counts: Counts;
}

const EXAMPLES = ["Help me launch an online business selling handmade candles", "Plan and write a 6-week blog series about personal finance", "Prepare for a software engineering job search in three months"];

export function MissionsView() {
  const { user } = useApp();
  const router = useRouter();
  const catalog = useCatalog();
  const [missions, setMissions] = useState<MissionSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [modelId, setModelId] = useState<string>("auto:deep");
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<MissionPlan | null>(null);
  const [planBy, setPlanBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    jsonFetch<{ missions: MissionSummary[] }>("/api/missions")
      .then((r) => alive && setMissions(r.missions))
      .catch((e: Error) => alive && setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [user]);

  const makePlan = async () => {
    if (!goal.trim() || planning) return;
    setPlanning(true);
    setError(null);
    try {
      const r = await jsonFetch<{ plan: MissionPlan; model: { displayName: string } }>("/api/missions/plan", { method: "POST", body: JSON.stringify({ goal, modelId }) });
      setPlan(r.plan);
      setPlanBy(r.model.displayName);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPlanning(false);
    }
  };

  const create = async (empty = false) => {
    setCreating(true);
    setError(null);
    try {
      const body = empty || !plan
        ? { name: goal.trim().slice(0, 120) || "New mission", goal: goal.trim(), tasks: [] }
        : {
            name: plan.title,
            goal: goal.trim(),
            description: [plan.summary, plan.researchNeeds.length ? `Research needed:\n${plan.researchNeeds.map((r) => `- ${r}`).join("\n")}` : ""].filter(Boolean).join("\n\n"),
            tasks: plan.milestones.flatMap((m) => m.tasks.map((t) => ({ ...t, milestone: m.name }))),
          };
      const r = await jsonFetch<{ mission: { id: string } }>("/api/missions", { method: "POST", body: JSON.stringify(body) });
      router.push(`/missions/${r.mission.id}`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };

  const editTask = (mi: number, ti: number, patch: Partial<MissionPlan["milestones"][number]["tasks"][number]>) =>
    setPlan((p) => p && { ...p, milestones: p.milestones.map((m, i) => (i !== mi ? m : { ...m, tasks: m.tasks.map((t, j) => (j !== ti ? t : { ...t, ...patch })) })) });
  const removeTask = (mi: number, ti: number) =>
    setPlan((p) => p && { ...p, milestones: p.milestones.map((m, i) => (i !== mi ? m : { ...m, tasks: m.tasks.filter((_, j) => j !== ti) })).filter((m) => m.tasks.length) });
  const addTask = (mi: number) =>
    setPlan((p) => p && { ...p, milestones: p.milestones.map((m, i) => (i !== mi ? m : { ...m, tasks: [...m.tasks, { title: "New task", description: "", priority: "medium", aiSuitable: false }] })) });

  if (!user) {
    return (
      <>
        <StudioHeader>
          <span className="text-[14px] font-medium text-s-ink-2">Missions</span>
        </StudioHeader>
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div>
            <h1 className="font-serif text-[36px]">Mission Control</h1>
            <p className="mt-2 text-[15px] text-s-ink-2">Turn big goals into plans and tracked tasks. Missions are saved to your account.</p>
            <Link href="/login?next=/missions" className="mt-5 inline-flex h-10 items-center rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink">
              Sign in to start
            </Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <StudioHeader>
        <span className="text-[14px] font-medium text-s-ink-2">Missions</span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1040px] px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(34px,5vw,46px)] leading-[1.05] tracking-[-0.01em]">Mission Control</h1>
            <p className="mt-2 max-w-2xl text-[15.5px] text-s-ink-2">Describe a goal. Nova drafts a plan you can edit, then tracks the work and lets AI draft the tasks it can help with.</p>
          </div>

          {!plan && (
            <form
              className="composer glass-strong glass-edge s-in mt-7 rounded-[26px] p-3 [animation-delay:60ms] sm:p-4"
              onSubmit={(e) => {
                e.preventDefault();
                void makePlan();
              }}
            >
              <label htmlFor="mission-goal" className="sr-only">
                Goal
              </label>
              <textarea
                id="mission-goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={2}
                maxLength={4000}
                placeholder="What do you want to achieve?"
                className="s-scroll block max-h-48 min-h-[60px] w-full resize-y bg-transparent px-2 pt-1 text-[16px] leading-relaxed text-s-ink outline-none placeholder:text-s-ink-3"
              />
              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-s-line px-1 pt-3">
                <ModelSelector models={catalog?.models ?? null} value={modelId} onChange={setModelId} auto={catalog?.auto ?? null} />
                <div className="ml-auto flex items-center gap-2">
                  <button type="button" onClick={() => void create(true)} disabled={!goal.trim() || creating} className="h-10 rounded-full px-3.5 text-[13px] text-s-ink-2 transition hover:bg-s-hover disabled:opacity-40">
                    Start without a plan
                  </button>
                  <button
                    type="submit"
                    disabled={!goal.trim() || planning}
                    className="inline-flex h-10 items-center gap-2 rounded-full bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink transition hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
                  >
                    <Sparkles className="h-4 w-4" /> {planning ? "Planning…" : "Plan with AI"}
                  </button>
                </div>
              </div>
              {!goal && (
                <div className="mt-3 flex flex-wrap gap-1.5 px-1">
                  {EXAMPLES.map((x) => (
                    <button key={x} type="button" onClick={() => setGoal(x)} className="rounded-full border border-s-line px-3 py-1.5 text-[12.5px] text-s-ink-3 transition hover:border-s-line-strong hover:text-s-ink">
                      {x}
                    </button>
                  ))}
                </div>
              )}
            </form>
          )}

          {error && <p className="mt-4 rounded-xl border border-s-line px-3.5 py-2.5 text-[13px] text-s-danger">{error}</p>}

          {plan && (
            <section className="glass-strong glass-edge s-in mt-7 rounded-[26px] p-5 sm:p-7" aria-label="Proposed plan">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-[11.5px] font-medium uppercase tracking-[0.1em] text-s-ink-3">Proposed plan · drafted by {planBy} · edit before saving</div>
                  <input
                    value={plan.title}
                    onChange={(e) => setPlan({ ...plan, title: e.target.value })}
                    aria-label="Mission name"
                    className="mt-2 w-full bg-transparent font-serif text-[30px] leading-tight outline-none"
                  />
                  <p className="mt-1 text-[14px] leading-relaxed text-s-ink-2">{plan.summary}</p>
                </div>
                <button type="button" onClick={() => setPlan(null)} aria-label="Discard plan" className="grid h-9 w-9 place-items-center rounded-xl text-s-ink-3 transition hover:bg-s-hover hover:text-s-ink">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-5 space-y-5">
                {plan.milestones.map((m, mi) => (
                  <div key={mi}>
                    <input
                      value={m.name}
                      onChange={(e) => setPlan({ ...plan, milestones: plan.milestones.map((x, i) => (i === mi ? { ...x, name: e.target.value } : x)) })}
                      aria-label="Milestone name"
                      className="w-full bg-transparent text-[13px] font-medium uppercase tracking-[0.08em] text-s-ink-2 outline-none"
                    />
                    <ul className="mt-2 divide-y divide-s-line rounded-2xl border border-s-line">
                      {m.tasks.map((t, ti) => (
                        <li key={ti} className="flex flex-wrap items-center gap-2 px-3 py-2">
                          <input value={t.title} onChange={(e) => editTask(mi, ti, { title: e.target.value })} aria-label="Task title" className="min-w-0 flex-1 bg-transparent text-[14px] outline-none" />
                          <select value={t.priority} onChange={(e) => editTask(mi, ti, { priority: e.target.value as "low" })} aria-label="Priority" className="h-8 rounded-lg border border-s-line bg-transparent px-2 text-[12px] text-s-ink-2">
                            <option value="high" className="bg-s-bg">High</option>
                            <option value="medium" className="bg-s-bg">Medium</option>
                            <option value="low" className="bg-s-bg">Low</option>
                          </select>
                          <button
                            type="button"
                            aria-pressed={t.aiSuitable}
                            onClick={() => editTask(mi, ti, { aiSuitable: !t.aiSuitable })}
                            title="Whether AI can draft this task"
                            className={cn("h-8 rounded-lg px-2.5 text-[12px] transition", t.aiSuitable ? "bg-s-accent-soft text-s-ink" : "border border-s-line text-s-ink-3")}
                          >
                            {t.aiSuitable ? "AI can draft" : "You do this"}
                          </button>
                          <button type="button" aria-label="Remove task" onClick={() => removeTask(mi, ti)} className="grid h-8 w-8 place-items-center rounded-lg text-s-ink-3 hover:bg-s-hover hover:text-s-danger">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                    <button type="button" onClick={() => addTask(mi)} className="mt-1.5 inline-flex items-center gap-1 text-[12.5px] text-s-ink-3 hover:text-s-ink">
                      <Plus className="h-3.5 w-3.5" /> Add task
                    </button>
                  </div>
                ))}
                {plan.researchNeeds.length > 0 && (
                  <div className="rounded-2xl border border-s-line px-4 py-3">
                    <div className="text-[13px] font-medium">Research needed</div>
                    <ul className="mt-1 list-disc pl-5 text-[13.5px] text-s-ink-2">
                      {plan.researchNeeds.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
              <div className="mt-6 flex justify-end gap-2">
                <button type="button" onClick={() => void makePlan()} disabled={planning} className="h-10 rounded-full border border-s-line-strong px-4 text-[13.5px] transition hover:bg-s-hover disabled:opacity-40">
                  {planning ? "Planning…" : "Re-plan"}
                </button>
                <button
                  type="button"
                  onClick={() => void create(false)}
                  disabled={creating || !plan.title.trim()}
                  className="inline-flex h-10 items-center gap-2 rounded-full bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-40"
                >
                  {creating ? "Creating…" : "Create mission"} <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </section>
          )}

          <section className="mt-12" aria-labelledby="missions-h">
            <h2 id="missions-h" className="mb-3 text-[13px] font-medium uppercase tracking-[0.1em] text-s-ink-3">
              Your missions
            </h2>
            {loadError && <p className="text-[13px] text-s-danger">{loadError}</p>}
            {missions === null && !loadError && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="s-skeleton h-28 rounded-[20px]" />
                <div className="s-skeleton h-28 rounded-[20px]" />
              </div>
            )}
            {missions?.length === 0 && <p className="text-[14px] text-s-ink-3">No missions yet. Describe a goal above to start one.</p>}
            <div className="grid gap-3 sm:grid-cols-2">
              {missions?.map((m) => {
                const p = progressOf(m.counts);
                return (
                  <Link key={m.id} href={`/missions/${m.id}`} className="glass group block rounded-[22px] p-5 transition hover:-translate-y-0.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-[15px] font-medium">{m.name}</div>
                        {m.goal && <p className="mt-0.5 line-clamp-2 text-[13px] text-s-ink-3">{m.goal}</p>}
                      </div>
                      <StatusPill status={m.status} />
                    </div>
                    <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-s-hover" role="progressbar" aria-valuenow={p.pct} aria-valuemin={0} aria-valuemax={100} aria-label="Progress">
                      <div className="h-full rounded-full bg-s-ink-2 transition-[width] duration-500" style={{ width: `${p.pct}%` }} />
                    </div>
                    <div className="mt-2 flex justify-between text-[12px] text-s-ink-3">
                      <span>
                        {p.done}/{p.total} tasks done{m.counts.blocked ? ` · ${m.counts.blocked} blocked` : ""}
                      </span>
                      <span>{new Date(m.updated_at).toLocaleDateString()}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
