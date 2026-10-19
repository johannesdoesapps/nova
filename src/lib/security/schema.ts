import { z } from "zod";
import { CONFIDENCES, FINDING_STATUSES, SEVERITIES } from "./types";

const modelId = z.string().min(1).max(120).optional();
const parentId = z.uuid().optional();
const filePath = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((p) => !p.split(/[\\/]/).includes(".."), "File paths can't contain '..'.");

export const targetCreate = z.object({ host: z.string().trim().min(3).max(300) });

export const sentinelRequest = z.object({
  targetId: z.uuid(),
  scope: z.enum(["passive", "active"]).default("passive"),
  /** The user's explicit confirmation, required for every scan. */
  authorized: z.literal(true, { error: "Confirm you own or are authorised to test this website." }),
  modelId,
  parentId,
});

export const hunterRequest = z
  .object({
    logs: z.array(z.object({ name: z.string().trim().min(1).max(200), content: z.string().max(3_000_000) })).max(10).default([]),
    indicators: z.string().max(20_000).default(""),
    asset: z.string().trim().max(120).default(""),
    modelId,
    parentId,
  })
  .refine((b) => b.logs.some((l) => l.content.trim()) || b.indicators.trim(), "Add a log file or some indicators to investigate.")
  .refine((b) => b.logs.reduce((n, l) => n + l.content.length, 0) <= 3_000_000, "Logs are limited to 3 MB per investigation.");

export const guardianRequest = z
  .object({
    source: z.discriminatedUnion("type", [
      z.object({ type: z.literal("upload"), files: z.array(z.object({ path: filePath, content: z.string().max(1_000_000) })).min(1).max(800) }),
      z.object({ type: z.literal("github"), repo: z.string().trim().min(3).max(300) }),
    ]),
    asset: z.string().trim().max(120).default(""),
    aiReview: z.boolean().default(true),
    proposeFixes: z.boolean().default(false),
    modelId,
    parentId,
  })
  .refine((b) => b.source.type !== "upload" || b.source.files.reduce((n, f) => n + f.content.length, 0) <= 3_000_000, "Uploads are limited to 3 MB of code per audit.");

export const coordinateStart = z.object({ plan: z.array(z.enum(["sentinel", "threat_hunter", "code_guardian"])).min(1).max(3), asset: z.string().trim().max(120).default("") });
export const coordinateReport = z.object({ modelId });

export const findingPatch = z.object({
  status: z.enum(FINDING_STATUSES).optional(),
  severity: z.enum(SEVERITIES).optional(),
  confidence: z.enum(CONFIDENCES).optional(),
  user_note: z.string().max(4000).nullable().optional(),
  duplicate_of: z.uuid().nullable().optional(),
});

export const findingsQuery = z.object({
  agent: z.string().max(30).optional(),
  severity: z.enum(SEVERITIES).optional(),
  status: z.enum(FINDING_STATUSES).optional(),
  asset: z.string().max(300).optional(),
  q: z.string().max(100).optional(),
  sort: z.enum(["severity", "recent", "oldest"]).optional(),
  includeDuplicates: z.enum(["1", "0"]).optional(),
});
