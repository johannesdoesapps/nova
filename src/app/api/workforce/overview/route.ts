import { NextResponse } from "next/server";
import { AGENTS } from "@/lib/workforce/agents";
import { computeMetrics } from "@/lib/workforce/metrics";
import { vercelWorkspaces } from "@/lib/workforce/sandbox-vercel";
import { requireOperator, wfError } from "@/lib/workforce/server";

/** GET /api/workforce/overview — dashboard data computed from stored records. */
export async function GET() {
  try {
    const { store } = await requireOperator();
    const settings = await store.getSettings();
    await store.purgeExpired(settings.retentionDays);
    const [tasks, approvals, projects, events] = await Promise.all([store.listTasks({ limit: 200 }), store.listApprovals(), store.listProjects(), store.recentEvents(40)]);
    const steps = await store.listStepsFor(tasks.map((t) => t.id));
    const human = new Set([...approvals.filter((a) => a.decided_at).map((a) => a.task_id), ...events.filter((e) => e.type === "task.rework").map((e) => e.task_id ?? "")]);
    const metrics = computeMetrics(tasks, steps, human);
    const running = new Set(steps.filter((s) => s.status === "running").map((s) => s.agent));
    return NextResponse.json({
      settings,
      sandbox: vercelWorkspaces.available(),
      metrics,
      agents: AGENTS.map((a) => ({ ...a, enabled: a.status === "active" && !settings.disabledAgents.includes(a.id), busy: running.has(a.id), model: settings.models[a.id] ?? a.defaultModel })),
      tasks: tasks.slice(0, 60).map((t) => ({ ...t, diff: undefined, report: undefined, plan: undefined, planSummary: t.plan?.summary ?? null })),
      pendingApprovals: approvals.filter((a) => a.status === "pending"),
      projects,
      events,
    });
  } catch (err) {
    return wfError(err);
  }
}
