import { z } from "zod";
import { TASK_CATEGORIES } from "./intel/types";
import { isSafeHttpUrl } from "./utils";

const modelId = z.string().min(1).max(120);
const category = z.enum(TASK_CATEGORIES);

// ─── Claim DNA ──────────────────────────────────────────────────────────────
export const sourceInput = z.object({
  index: z.number().int().min(1).max(99).optional(),
  url: z.string().max(2048).refine(isSafeHttpUrl, "Only http(s) URLs are allowed.").nullable().optional(),
  title: z.string().max(400).optional(),
  text: z.string().trim().min(1, "Each source needs some text to check against.").max(30_000),
  publishedAt: z.string().max(40).nullable().optional(),
  author: z.string().max(200).nullable().optional(),
  contentKind: z.enum(["snippet", "full_text", "user_pasted"]).optional(),
  provider: z.string().max(40).nullable().optional(),
});

export const claimsAnalyzeRequest = z.object({
  question: z.string().max(2000).default(""),
  answer: z.string().trim().min(10, "Paste an answer or report to analyse.").max(40_000),
  sources: z.array(sourceInput).max(20).default([]),
  mode: z.enum(["rules", "model"]).default("rules"),
  modelId: modelId.optional(),
  projectId: z.uuid().nullable().optional(),
  save: z.boolean().default(true),
});

export const hypothesesRequest = z.object({
  question: z.string().trim().min(3).max(2000),
  context: z.array(z.string().max(600)).max(30).optional(),
  modelId: modelId.optional(),
  useModel: z.boolean().default(false),
});

// Stored documents are validated for shape and size, not re-derived: they are the user's own data.
export const storedReport = z.looseObject({
  id: z.uuid(),
  version: z.literal("claim-dna/1"),
  question: z.string().max(2000),
  answer: z.string().max(40_000),
  mode: z.enum(["rules", "model"]),
  claims: z.array(z.unknown()).max(400),
  sources: z.array(z.unknown()).max(20),
  replay: z.looseObject({ events: z.array(z.unknown()).max(50) }),
});

export const storedArena = z.looseObject({
  id: z.uuid(),
  question: z.string().min(1).max(2000),
  reportId: z.uuid().nullable(),
  hypotheses: z.array(z.unknown()).max(8),
});

// ─── Model Intelligence ─────────────────────────────────────────────────────
export const trialStartRequest = z.object({
  prompt: z.string().trim().min(1).max(8000),
  category,
  /** Two model ids, or omit to let NOVA pick a random available pair. */
  modelIds: z.array(modelId).length(2).optional(),
  testItemId: z.string().max(120).nullable().optional(),
});

export const trialVoteRequest = z.object({
  token: z.string().min(10).max(20_000),
  winner: z.enum(["A", "B", "tie", "both_bad"]),
  ratings: z.object({ A: z.number().int().min(1).max(5).optional(), B: z.number().int().min(1).max(5).optional() }).default({}),
  note: z.string().max(1000).nullable().optional(),
});

export const checkerSpec = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exact"), answer: z.string().max(500) }),
  z.object({ type: z.literal("contains_all"), values: z.array(z.string().max(200)).min(1).max(20) }),
  z.object({ type: z.literal("contains_any"), values: z.array(z.string().max(200)).min(1).max(20) }),
  z.object({ type: z.literal("regex"), pattern: z.string().max(300), flags: z.string().regex(/^[gimsuy]{0,6}$/).optional() }),
  z.object({ type: z.literal("numeric"), answer: z.number(), tolerance: z.number().nonnegative() }),
  z.object({ type: z.literal("json_keys"), keys: z.array(z.string().max(100)).min(1).max(30) }),
  z.object({ type: z.literal("bullets"), count: z.number().int().min(1).max(30), maxWords: z.number().int().min(1).max(200).optional() }),
  z.object({ type: z.literal("lowercase") }),
  z.object({ type: z.literal("not_stated"), forbidden: z.array(z.string().max(100)).max(20).optional() }),
]);

export const customTestSet = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,80}$/, "Use lowercase letters, numbers and dashes."),
  name: z.string().min(1).max(120),
  category,
  version: z.string().min(1).max(20),
  description: z.string().max(500).default(""),
  systemPrompt: z.string().max(2000).default(""),
  items: z
    .array(z.object({ id: z.string().min(1).max(60), prompt: z.string().min(1).max(4000), checker: checkerSpec, probes: z.string().max(200).default("") }))
    .min(1)
    .max(50),
});

export const benchmarkRequest = z
  .object({
    modelId,
    testSetId: z.string().max(120).optional(),
    testSet: customTestSet.optional(),
    maxItems: z.number().int().min(1).max(12).default(8),
  })
  .refine((v) => v.testSetId || v.testSet, "Choose a test set.");

const trialArm = z.object({
  label: z.enum(["A", "B"]),
  modelId,
  displayName: z.string().max(200),
  provider: z.string().max(40),
  servedModel: z.string().max(200).nullable(),
  latencyMs: z.number().nullable(),
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  tokensEstimated: z.boolean(),
  cost: z.number().nullable(),
  simulated: z.boolean(),
  error: z.string().max(1000).nullable(),
});

export const trialRecord = z.object({
  id: z.string().max(80),
  createdAt: z.string().max(40),
  category,
  prompt: z.string().max(8000),
  promptHash: z.string().max(40),
  testItemId: z.string().max(120).nullable(),
  arms: z.array(trialArm).max(2),
  winner: z.enum(["A", "B", "tie", "both_bad"]),
  ratings: z.object({ A: z.number().optional(), B: z.number().optional() }),
  note: z.string().max(1000).nullable(),
  redactions: z.number().int(),
});

export const benchmarkRunRecord = z.object({
  id: z.string().max(80),
  createdAt: z.string().max(40),
  testSetId: z.string().max(120),
  testSetName: z.string().max(200),
  category,
  testSetHash: z.string().max(40),
  modelId,
  displayName: z.string().max(200),
  servedModel: z.string().max(200).nullable(),
  params: z.object({ maxOutputTokens: z.number(), temperature: z.number().nullable() }),
  simulated: z.boolean(),
  results: z
    .array(
      z.object({
        itemId: z.string().max(60),
        passed: z.boolean(),
        score: z.number(),
        detail: z.string().max(500),
        output: z.string().max(4000),
        latencyMs: z.number().nullable(),
        inputTokens: z.number().nullable(),
        outputTokens: z.number().nullable(),
        cost: z.number().nullable(),
        error: z.string().max(1000).nullable(),
      }),
    )
    .max(50),
});

export const routeRequest = z.object({
  prompt: z.string().trim().min(1).max(12_000),
  mode: z.string().max(20).optional(),
  category: category.optional(),
  constraints: z
    .object({
      requireNoTraining: z.boolean().optional(),
      maxRetentionDays: z.number().int().min(0).max(3650).nullable().optional(),
      allowedProviders: z.array(z.string().max(40)).max(10).nullable().optional(),
      maxPricePer1M: z.number().nonnegative().max(10_000).nullable().optional(),
      maxP50LatencyMs: z.number().int().positive().max(600_000).nullable().optional(),
      prefer: z.enum(["personal", "general"]).optional(),
    })
    .default({}),
  execute: z.boolean().default(false),
  /** Guests keep their evaluation history in the browser and send it for planning. */
  history: z.object({ trials: z.array(trialRecord).max(1000), benchmarks: z.array(benchmarkRunRecord).max(200) }).optional(),
});
