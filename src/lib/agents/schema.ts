import { z } from "zod";
import { ALLOWED_ATTACHMENT_EXT, MAX_ATTACHMENT_CHARS } from "../limits";
import { AGENT_ACCENTS, AGENT_CAPABILITIES, AGENT_ICONS, HISTORY_LIMITS, RESPONSE_STYLES } from "./types";

/** Fields a user can set on a custom agent. Shared by create, update and guest chat. */
export const agentInput = z.object({
  name: z.string().trim().min(1, "Give the agent a name.").max(80, "Keep the name under 80 characters."),
  description: z.string().trim().max(300, "Keep the description under 300 characters.").default(""),
  instructions: z
    .string()
    .trim()
    .min(20, "Describe the agent's role in at least 20 characters.")
    .max(8000, "Instructions can be at most 8,000 characters."),
  icon: z.enum(AGENT_ICONS).default("bot"),
  accent: z.enum(AGENT_ACCENTS).default("violet"),
  modelId: z.string().min(1).max(120).nullable().default(null),
  capabilities: z
    .array(z.enum(AGENT_CAPABILITIES))
    .max(AGENT_CAPABILITIES.length)
    .default([])
    .transform((c) => [...new Set(c)]),
  starters: z.array(z.string().trim().min(1).max(200)).max(4, "Up to 4 starter prompts.").default([]),
  responseStyle: z.enum(RESPONSE_STYLES).default("balanced"),
  historyLimit: z
    .number()
    .int()
    .refine((n) => (HISTORY_LIMITS as readonly number[]).includes(n), "Choose 10, 20 or 40 messages.")
    .default(20),
});
export type AgentInput = z.infer<typeof agentInput>;

export const agentPatch = agentInput.partial();

const agentId = z.union([z.uuid(), z.enum(["research", "coding", "writing", "data", "creative", "general"])]);

export const agentChatRequest = z.object({
  agentId,
  conversationId: z.uuid().nullable().optional(),
  message: z.string().trim().min(1).max(12_000),
  modelId: z.string().min(1).max(120).optional(),
  useWeb: z.boolean().optional(),
  /** The browser's IANA time zone, so the model can answer "what time is it". */
  timeZone: z.string().max(64).optional(),
  /** The user allows another compatible model to answer if the chosen one fails (also needs the admin setting). */
  allowFallback: z.boolean().optional(),
  /** Guests only: prior turns, since the server keeps no guest history. */
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(20_000) }))
    .max(30)
    .optional(),
  /** Guests only (no accounts configured): a custom agent kept in the browser. */
  agent: agentInput.optional(),
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
export type AgentChatRequest = z.infer<typeof agentChatRequest>;
