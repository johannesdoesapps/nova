import { z } from "zod";
import { FEEDBACK_FEATURES, FEEDBACK_RATINGS } from "./events";

export const feedbackRequest = z.object({
  feature: z.enum(FEEDBACK_FEATURES),
  /** Which result: a message id, a template id with its run time, or a check's id. */
  subjectId: z.string().trim().min(1).max(100),
  rating: z.enum(FEEDBACK_RATINGS),
  /** Written by the user, only if they chose to. */
  comment: z.string().trim().max(1000).optional(),
  modelId: z.string().trim().max(120).optional(),
});

export const feedbackDelete = z.object({ feature: z.enum(FEEDBACK_FEATURES), subjectId: z.string().trim().min(1).max(100) });

/** Events the browser may report (the rest are recorded by the server itself). */
export const clientEvent = z.object({
  /** comparison_started: Council runs its steps from the browser, so its start is reported from there. */
  event: z.enum(["useful_result", "palette_command", "comparison_started"]),
  props: z.record(z.string().max(30), z.union([z.string().max(60), z.number()])).default({}),
});

export const eventSettings = z.object({ productEvents: z.boolean() });
