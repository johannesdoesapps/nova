import { z } from "zod";

export const TASK_STATUSES = ["pending", "in_progress", "completed", "blocked", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const PRIORITIES = ["low", "medium", "high"] as const;
export const MISSION_STATUSES = ["active", "paused", "completed", "archived"] as const;

const title = z.string().trim().min(1, "Give the task a title.").max(200);
const description = z.string().trim().max(4000).default("");
const milestone = z.string().trim().max(120).nullable().default(null);

export const planTask = z.object({
  title,
  description,
  priority: z.enum(PRIORITIES).default("medium"),
  aiSuitable: z.boolean().default(false),
});

/** The AI's proposed plan, which the user edits before anything is saved. */
export const missionPlan = z.object({
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(1200).default(""),
  milestones: z
    .array(z.object({ name: z.string().trim().min(1).max(120), tasks: z.array(planTask).min(1).max(12) }))
    .min(1)
    .max(8),
  researchNeeds: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
});
export type MissionPlan = z.infer<typeof missionPlan>;

export const planRequest = z.object({
  goal: z.string().trim().min(8, "Describe the goal in a few more words.").max(4000),
  modelId: z.string().min(1).max(120).optional(),
});

export const missionCreate = z.object({
  name: z.string().trim().min(1, "Give the mission a name.").max(120),
  goal: z.string().trim().max(4000).default(""),
  description: z.string().trim().max(2000).default(""),
  tasks: z
    .array(planTask.extend({ milestone }))
    .max(80)
    .default([]),
});

export const missionPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  goal: z.string().trim().max(4000).optional(),
  status: z.enum(MISSION_STATUSES).optional(),
});

export const taskCreate = planTask.extend({ milestone });

export const taskPatch = z.object({
  title: title.optional(),
  description: z.string().trim().max(4000).optional(),
  milestone: z.string().trim().max(120).nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  aiSuitable: z.boolean().optional(),
  /** Users may edit or clear an AI draft. */
  output: z.string().max(60000).nullable().optional(),
});

export const taskRunRequest = z.object({
  modelId: z.string().min(1).max(120).optional(),
  instruction: z.string().trim().max(1000).optional(),
});
