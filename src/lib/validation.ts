import { z } from "zod";
import { CHAT_MODES } from "./ai/modes";

export const uuid = z.uuid();
const modelId = z.string().min(1).max(120);

import { ALLOWED_ATTACHMENT_EXT, MAX_ATTACHMENT_CHARS } from "./limits";
export { ALLOWED_ATTACHMENT_EXT, MAX_ATTACHMENT_CHARS };

export const historyMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(20_000),
});

export const searchRequest = z.object({
  query: z.string().trim().min(2, "Ask a slightly longer question.").max(500),
  modelId: modelId.optional(),
  projectId: uuid.nullable().optional(),
  history: z.array(historyMessage).max(10).optional(),
});

export const chatRequest = z.object({
  conversationId: uuid.nullable().optional(),
  projectId: uuid.nullable().optional(),
  message: z.string().trim().min(1).max(12_000),
  mode: z.enum(CHAT_MODES).default("research"),
  modelId: modelId.optional(),
  useWeb: z.boolean().optional(),
  /** Used only for guests (no persistence); authenticated history is loaded from the DB. */
  history: z.array(historyMessage).max(30).optional(),
  attachments: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .max(200)
          .refine((n) => ALLOWED_ATTACHMENT_EXT.some((ext) => n.toLowerCase().endsWith(ext)), "Unsupported file type."),
        content: z.string().max(MAX_ATTACHMENT_CHARS),
      }),
    )
    .max(3)
    .optional(),
});

export const compareRequest = z.object({
  prompt: z.string().trim().min(1).max(8_000),
  modelIds: z.array(modelId).min(2, "Select at least two models.").max(6),
  systemPrompt: z.string().max(4_000).optional(),
});

export const saveComparisonRequest = z.object({
  prompt: z.string().min(1).max(8_000),
  projectId: uuid.nullable().optional(),
  preferredModelId: modelId.nullable().optional(),
  results: z
    .array(
      z.object({
        modelId,
        displayName: z.string().max(200),
        provider: z.string().max(40),
        status: z.enum(["success", "error"]),
        text: z.string().max(60_000),
        error: z.string().max(1_000).nullable().optional(),
        latencyMs: z.number().nonnegative().nullable(),
        inputTokens: z.number().int().nonnegative().nullable(),
        outputTokens: z.number().int().nonnegative().nullable(),
        estimatedCost: z.number().nonnegative().nullable(),
        simulated: z.boolean(),
      }),
    )
    .min(1)
    .max(6),
});

export const projectCreate = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).nullable().optional(),
});
export const projectPatch = projectCreate.partial().refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const noteCreate = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(100_000),
  sourceType: z.enum(["note", "chat", "search", "comparison"]).default("note"),
  sourceRef: z.string().max(200).nullable().optional(),
});

export const conversationPatch = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    mode: z.enum(CHAT_MODES).optional(),
    projectId: uuid.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

export const discoverQuery = z.object({
  search: z.string().trim().max(120).optional(),
  task: z
    .string()
    .regex(/^[a-z0-9-]{1,60}$/)
    .optional(),
  library: z
    .string()
    .regex(/^[a-z0-9_.-]{1,60}$/i)
    .optional(),
  tag: z
    .string()
    .regex(/^[\w:.-]{1,80}$/)
    .optional(),
  sort: z.enum(["trendingScore", "downloads", "likes", "lastModified", "createdAt"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z
    .string()
    .max(500)
    .regex(/^[\w=+/-]+$/)
    .optional(),
});

export const favoriteRequest = z.object({
  modelId: z.string().min(1).max(200),
  source: z.enum(["hub", "registry"]).default("hub"),
});

export const saveSearchRequest = z.object({
  searchId: uuid,
  projectId: uuid,
});
