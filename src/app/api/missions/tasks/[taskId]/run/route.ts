import { getProvider, resolveModelChoice, withTimeout } from "@/lib/ai";
import { estimateCost, estimateTokens } from "@/lib/ai/cost";
import type { Usage } from "@/lib/ai/types";
import { requireUser } from "@/lib/auth";
import { finishRun, getMission, getTask, startRun, updateTask } from "@/lib/db/missions";
import { ApiError, errorResponse, ndjsonStream, parseJsonBody } from "@/lib/http";
import { taskRunMessages } from "@/lib/missions/prompts";
import { taskRunRequest } from "@/lib/missions/schema";
import { enforceLimits, planLimits, recordRunLater, shouldSaveAllowance } from "@/lib/usage";
import { uuid } from "@/lib/validation";
import { withTimeContext } from "@/lib/ai/turn-context";
import { isAutoId } from "@/lib/ai/platform";

export const maxDuration = 60;

/**
 * POST /api/missions/tasks/[taskId]/run — delegate a task to a model, streamed
 * as NDJSON. Every attempt is recorded in task_runs (succeeded, failed or
 * cancelled). A successful draft is attached to the task, which moves to
 * "in progress"; only the user can mark it completed.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/missions/tasks/[taskId]/run">) {
  try {
    const { taskId } = await ctx.params;
    if (!uuid.safeParse(taskId).success) throw new ApiError("not_found", "Task not found.");
    const body = await parseJsonBody(req, taskRunRequest);
    const auth = await requireUser();
    const task = await getTask(auth.supabase, auth.user.id, taskId);
    const { mission, tasks } = await getMission(auth.supabase, auth.user.id, task.project_id);
    if (mission.status === "paused") throw new ApiError("bad_request", "This mission is paused. Resume it to run tasks.");
    if (mission.status === "archived") throw new ApiError("bad_request", "This mission is archived.");
    if (task.status === "cancelled") throw new ApiError("bad_request", "This task is cancelled.");

    const requested = body.modelId ?? "auto";
    const { model, routing } = await resolveModelChoice(requested, {
      prompt: `${task.title}\n${task.description}`,
      preferLowCost: isAutoId(requested) ? await shouldSaveAllowance(auth) : false,
      tiers: (await planLimits(auth)).tiers,
    });
    if (model.provider === "demo") throw new ApiError("not_configured", "Running tasks needs a real AI provider. An administrator can add one in Admin.");
    await enforceLimits(req, auth, 1, [model], { purpose: "mission-task" });

    const messages = withTimeContext(taskRunMessages({
      missionName: mission.name,
      goal: mission.goal ?? "",
      task: { title: task.title, description: task.description, milestone: task.milestone },
      siblings: tasks.filter((t) => t.id !== task.id).map((t) => ({ title: t.title, status: t.status })),
      completedOutputs: tasks.filter((t) => t.id !== task.id && t.status === "completed" && t.output).map((t) => ({ title: t.title, output: t.output! })),
      instruction: body.instruction,
    }), req);
    const runId = await startRun(auth.supabase, auth.user.id, task, model.id);

    return ndjsonStream(async (send, signal) => {
      send({ type: "meta", runId, model: { id: model.id, displayName: model.displayName, provider: model.provider }, routing });
      const started = performance.now();
      let text = "";
      let usage: Usage | null = null;
      try {
        for await (const ev of getProvider(model.provider).stream({ model, messages, maxOutputTokens: 3000, signal: withTimeout(55_000, signal) })) {
          if (ev.type === "delta") {
            text += ev.text;
            send({ type: "delta", text: ev.text });
          } else if (ev.type === "usage") usage = ev.usage;
        }
      } catch (err) {
        const cancelled = signal.aborted;
        await finishRun(auth.supabase, runId, { status: cancelled ? "cancelled" : "failed", output: text, error: cancelled ? "Cancelled by the user." : err instanceof ApiError ? err.message : "The model call failed." });
        recordRunLater(auth, { model, prompt: task.title, response: text, latencyMs: performance.now() - started, usage: usage ?? { inputTokens: null, outputTokens: null, estimated: true }, status: "error", purpose: "mission-task" });
        throw err;
      }
      if (!text.trim()) {
        await finishRun(auth.supabase, runId, { status: "failed", error: "The model returned an empty reply." });
        throw new ApiError("upstream_error", "The model returned an empty reply. Try again or choose another model.");
      }
      usage ??= { inputTokens: estimateTokens(messages), outputTokens: estimateTokens(text), estimated: true };
      recordRunLater(auth, { model, prompt: task.title, response: text, latencyMs: performance.now() - started, usage, status: "success", purpose: "mission-task" });
      await finishRun(auth.supabase, runId, { status: "succeeded", output: text });
      const updated = await updateTask(auth.supabase, auth.user.id, task.id, {
        output: text.slice(0, 60000),
        output_model: model.id,
        ...(task.status === "pending" || task.status === "blocked" ? { status: "in_progress" } : {}),
      });
      send({ type: "done", task: updated, latencyMs: Math.round(performance.now() - started), usage, estimatedCost: estimateCost(model, usage) });
    }, req.signal);
  } catch (err) {
    return errorResponse(err);
  }
}
