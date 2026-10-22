import { z } from "zod";

const key = z.string().regex(/^[a-z][a-z0-9-]{0,59}$/);

/** One step of a template run. Earlier steps' results come from the browser, so finished steps are never run again. */
export const templateStepRequest = z
  .object({
    templateId: key,
    stepId: key,
    inputs: z.record(key, z.string().max(40_000)),
    prior: z.record(key, z.string().max(30_000)).default({}),
    /** The user's own version of this step's instructions (same placeholders). */
    instructions: z.string().trim().min(1).max(8_000).optional(),
    modelId: z.string().min(1).max(120).optional(),
    requestId: z.uuid().optional(),
  })
  .refine((v) => Object.values(v.inputs).reduce((n, s) => n + s.length, 0) <= 60_000, "The inputs are too long in total (up to 60,000 characters).");
export type TemplateStepRequest = z.infer<typeof templateStepRequest>;
