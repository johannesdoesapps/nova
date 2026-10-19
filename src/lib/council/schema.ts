import { z } from "zod";

const text = z.string().max(24_000);
export const labelled = z.object({ label: z.string().trim().min(1).max(40), text });
export const councilSource = z.object({
  index: z.number().int().min(1).max(20),
  url: z.url().max(2048).refine((u) => /^https?:\/\//i.test(u), "Sources must be web links."),
  title: z.string().max(300),
  snippet: z.string().max(2000),
});
const question = z.string().trim().min(1, "Ask a question.").max(12_000);
const modelId = z.string().min(1).max(120);

export const councilAnswerRequest = z.object({ question, modelId, sources: z.array(councilSource).max(8).default([]) });
export const councilCritiqueRequest = z.object({
  question,
  modelId,
  responses: z.array(labelled).min(1).max(4),
  sources: z.array(councilSource).max(8).default([]),
});
export const councilImproveRequest = z.object({ question, modelId, response: labelled, instruction: z.string().max(500).optional() });
export const councilSynthesizeRequest = z.object({
  question,
  modelId,
  kind: z.enum(["council", "compare"]).default("council"),
  responses: z.array(labelled).min(1).max(4),
  critiques: z.array(labelled).max(4).default([]),
  sources: z.array(councilSource).max(8).default([]),
});

const answerRecord = z.object({
  modelId,
  label: z.string().max(40),
  text,
  status: z.enum(["done", "error", "cancelled"]),
  latencyMs: z.number().nullable().optional(),
});

export const councilSessionInput = z.object({
  kind: z.enum(["council", "arena"]).default("council"),
  question,
  mode: z.enum(["quick", "deep", "blind", "open"]),
  models: z.array(modelId).min(1).max(4),
  result: z.object({
    answers: z.array(answerRecord).max(4),
    critiques: z.array(z.object({ modelId, label: z.string().max(40), text })).max(4).default([]),
    synthesis: z.object({ modelId, text }).nullable().default(null),
    sources: z.array(councilSource).max(8).default([]),
    /** Arena: the response the user preferred and their 1–5 ratings by label. */
    preferred: z.string().max(40).nullable().default(null),
    ratings: z.record(z.string().max(40), z.number().int().min(1).max(5)).default({}),
  }),
});
export type CouncilSessionInput = z.infer<typeof councilSessionInput>;
