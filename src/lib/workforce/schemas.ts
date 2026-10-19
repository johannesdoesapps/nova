import { z } from "zod";

/** Structured outputs. Every model output is parsed and validated here before any downstream use. */

const path = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes("..") && !p.includes("\\"), "Paths must be relative to the repository.");

export const archaeologyOut = z.object({
  summary: z.string().min(1).max(3000),
  relevantFiles: z.array(z.object({ path, why: z.string().max(400) })).max(25),
  existing: z.array(z.string().max(400)).max(15).default([]),
  conventions: z.array(z.string().max(300)).max(15).default([]),
});
export type ArchaeologyOut = z.infer<typeof archaeologyOut>;

export const planOut = z.object({
  summary: z.string().min(1).max(2000),
  approach: z.string().max(4000).default(""),
  changes: z
    .array(z.object({ path, action: z.enum(["modify", "create"]), intent: z.string().min(1).max(1000) }))
    .min(1)
    .max(15),
  tests: z.array(z.string().max(500)).max(15).default([]),
  risks: z.array(z.string().max(500)).max(15).default([]),
  acceptanceCriteria: z.array(z.string().min(3).max(500)).min(1).max(15),
  risk: z.enum(["low", "medium", "high"]),
  outOfScope: z.array(z.string().max(300)).max(10).default([]),
});

export const editsOut = z.object({
  edits: z
    .array(
      z.discriminatedUnion("action", [
        z.object({ action: z.literal("replace"), path, search: z.string().min(1).max(20000), replace: z.string().max(40000) }),
        z.object({ action: z.literal("write"), path, content: z.string().max(80000) }),
      ]),
    )
    .min(1)
    .max(30),
  notes: z.string().max(3000).default(""),
});
export type Edit = z.infer<typeof editsOut>["edits"][number];

export const repairOut = editsOut.extend({ rootCause: z.string().min(1).max(2000) });

const severity = z.enum(["critical", "high", "medium", "low"]);

export const reviewOut = z.object({
  recommendation: z.enum(["approve", "request_changes", "reject"]),
  summary: z.string().max(3000),
  findings: z.array(z.object({ severity, file: z.string().max(300).optional(), issue: z.string().min(1).max(1500), evidence: z.string().max(1500).default("") })).max(25).default([]),
  criteria: z.array(z.object({ criterion: z.string().max(500), status: z.enum(["met", "not_met", "unclear"]), evidence: z.string().max(1500) })).max(20),
});
export type ReviewOut = z.infer<typeof reviewOut>;

export const securityOut = z.object({
  findings: z.array(z.object({ severity, file: z.string().max(300), quote: z.string().max(500), issue: z.string().min(1).max(1500), remediation: z.string().max(1500).default("") })).max(15).default([]),
});

/** Pull the outermost JSON object from a model reply and validate it. */
export function parseModelJson<T extends z.ZodType>(text: string, schema: T): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const src = fenced ?? text;
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "No JSON object found in the reply." };
  let raw: unknown;
  try {
    raw = JSON.parse(src.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message.slice(0, 200)}` };
  }
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, error: `Output didn't match the schema: ${r.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  return { ok: true, data: r.data };
}
