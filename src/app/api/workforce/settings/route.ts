import { NextResponse } from "next/server";
import { ApiError, parseJsonBody } from "@/lib/http";
import { ACTIVE_STATUSES } from "@/lib/workforce/types";
import { workforceSettingsSchema } from "@/lib/workforce/settings";
import { requireOperator, wfError } from "@/lib/workforce/server";

/** GET /api/workforce/settings */
export async function GET() {
  try {
    const { store } = await requireOperator();
    return NextResponse.json({ settings: await store.getSettings() });
  } catch (err) {
    return wfError(err);
  }
}

/**
 * PUT /api/workforce/settings — validated and enforced server-side. Turning
 * on the emergency stop pauses every active task and stops running checks.
 */
export async function PUT(req: Request) {
  try {
    const { store, rt } = await requireOperator();
    const next = await parseJsonBody(req, workforceSettingsSchema);
    if (next.maxBudgetUsd < next.defaultBudgetUsd) throw new ApiError("bad_request", "The default budget can’t be above the maximum.");
    const prev = await store.getSettings();
    await store.saveSettings(next);
    const changed = Object.keys(next).filter((k) => JSON.stringify(next[k as keyof typeof next]) !== JSON.stringify(prev[k as keyof typeof prev]));
    await store.addEvent({ task_id: null, level: "audit", type: "settings.updated", message: `Workforce settings changed: ${changed.join(", ") || "no changes"}`, data: { changed } });
    if (next.emergencyStop && !prev.emergencyStop) {
      for (const t of await store.listTasks({ statuses: [...ACTIVE_STATUSES, "planned", "awaiting_approval"] })) {
        const steps = await store.listSteps(t.id);
        const ws = t.sandbox_name ? rt.workspaces(t.sandbox_name) : null;
        for (const s of steps.filter((x) => x.status === "running")) {
          const handle = (s.state as { handle?: string | null }).handle;
          if (handle && ws) await ws.killCheck(handle).catch(() => {});
          await store.updateStep(s.id, { status: "pending", state: {} });
        }
        await store.updateTask(t.id, { status: "paused", status_reason: "Paused by the emergency stop." });
        await store.addEvent({ task_id: t.id, level: "audit", type: "task.paused", message: "Paused by the emergency stop; running checks were stopped." });
      }
    }
    return NextResponse.json({ settings: next });
  } catch (err) {
    return wfError(err);
  }
}
