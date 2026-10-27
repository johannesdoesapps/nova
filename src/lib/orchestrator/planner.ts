import { z } from "zod";
import { parseModelJson } from "../workforce/schemas";
import { LIMITS } from "./types";

/**
 * Planning tasks: a lead agent breaks a development task into smaller sub-tasks with dependencies. The model's
 * answer is untrusted output: it's parsed against a strict schema, dependencies may only point to earlier
 * sub-tasks (so the graph can't have cycles), and the count is capped. The sub-tasks are then created as ordinary
 * queued tasks that depend on the planning task, so none starts unless the plan was recorded as completed.
 */

export const planSchema = z
  .object({
    summary: z.string().trim().min(1).max(2000),
    subtasks: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(200),
            instructions: z.string().trim().min(1).max(8000),
            type: z
              .string()
              .trim()
              .toLowerCase()
              .regex(/^[a-z][a-z0-9_-]{0,39}$/),
            dependsOn: z.array(z.number().int().min(0)).max(LIMITS.subtasks).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(LIMITS.subtasks),
  })
  .strict();
export type Plan = z.infer<typeof planSchema>;

/** Why a parsed plan can't be used, or null. Dependencies must name earlier sub-tasks (this rules out cycles). */
export function planProblem(plan: Plan): string | null {
  for (const [i, s] of plan.subtasks.entries()) {
    for (const d of s.dependsOn) {
      if (d >= i) return `Sub-task ${i} ("${s.title}") depends on sub-task ${d}, which isn't an earlier one. Dependencies must point to earlier sub-tasks.`;
    }
    if (new Set(s.dependsOn).size !== s.dependsOn.length) return `Sub-task ${i} lists a dependency twice.`;
  }
  return null;
}

export function parsePlan(text: string): { ok: true; plan: Plan } | { ok: false; error: string } {
  const parsed = parseModelJson(text, planSchema);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const problem = planProblem(parsed.data);
  return problem ? { ok: false, error: problem } : { ok: true, plan: parsed.data };
}

export const PLAN_INSTRUCTIONS = `Break the development task into at most ${LIMITS.subtasks} smaller sub-tasks that specialist agents can do one by one.
Reply with one JSON object only, no prose:
{"summary": "one paragraph: the approach", "subtasks": [{"title": "...", "instructions": "what to do and how to tell it's done", "type": "a short lowercase task type such as frontend, backend, security, tests, review", "dependsOn": [indexes of earlier sub-tasks that must be finished first]}]}
- Index sub-tasks from 0. A sub-task may only depend on earlier ones.
- Keep sub-tasks independent where you can, so they can run in parallel.`;

/** The plan as the planning task's output (what was decided, readable without the sub-task records). */
export function planOutput(plan: Plan, ids: string[]): string {
  return [
    plan.summary,
    "",
    ...plan.subtasks.map((s, i) => `${i}. [${s.type}] ${s.title}${s.dependsOn.length ? ` (after ${s.dependsOn.join(", ")})` : ""}${ids[i] ? ` — task ${ids[i]}` : ""}`),
  ].join("\n");
}
