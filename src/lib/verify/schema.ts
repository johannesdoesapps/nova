import { z } from "zod";
import type { ClaimKind, ClaimStatus, Stance } from "../claims/types";

export const SEARCH_MISSING = "Web search isn't set up on this site (SEARCH_PROVIDER and SEARCH_API_KEY), so claims were identified but not checked against web sources.";

/** At most this many claims are judged in one check; the rest are listed as not checked. */
export const MAX_CHECKED_CLAIMS = 25;

export const VERIFY_SCOPES = ["answer", "claims", "document", "responses"] as const;
export type VerifyScope = (typeof VERIFY_SCOPES)[number];

export const verifyRequest = z
  .object({
    /** What is reviewed: a whole answer, chosen claims, a document, or several model responses. */
    scope: z.enum(VERIFY_SCOPES).default("answer"),
    question: z.string().trim().max(4000).default(""),
    /** The answer or document text (scopes "answer" and "document"). */
    answer: z.string().trim().max(40000).default(""),
    /** Scope "claims": the claims the user chose. */
    claims: z.array(z.string().trim().min(1).max(1000)).max(MAX_CHECKED_CLAIMS).optional(),
    /** Scope "responses": two to four answers to the same question. */
    responses: z
      .array(z.object({ label: z.string().trim().min(1).max(80), text: z.string().trim().min(1).max(20000) }))
      .max(4)
      .optional(),
    /** Reference documents the user supplies as evidence. */
    documents: z
      .array(z.object({ name: z.string().trim().min(1).max(120), content: z.string().trim().min(1).max(40000) }))
      .max(3)
      .optional(),
    /** Search the web for evidence (when search is set up). */
    web: z.boolean().default(true),
    modelId: z.string().min(1).max(120).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.scope === "claims" && !v.claims?.length) ctx.addIssue({ code: "custom", message: "Choose at least one claim to check.", path: ["claims"] });
    if (v.scope === "responses" && (v.responses?.length ?? 0) < 2) ctx.addIssue({ code: "custom", message: "Add at least two responses to compare.", path: ["responses"] });
    if ((v.scope === "answer" || v.scope === "document") && !v.answer) ctx.addIssue({ code: "custom", message: "There's nothing to verify.", path: ["answer"] });
  });
export type VerifyRequest = z.infer<typeof verifyRequest>;

export interface VerifiedEvidence {
  url: string | null;
  title: string;
  stance: Stance;
  /** Only present when the quote was found word-for-word in the source text. */
  quote: string | null;
  /** "web": a search result snippet; "document": text the user supplied. */
  origin?: "web" | "document";
}

export interface VerifiedClaim {
  text: string;
  kind: ClaimKind;
  hedged: boolean;
  /** null means no check was run for this claim. */
  status: ClaimStatus | null;
  evidence: VerifiedEvidence[];
  /** One sentence on what the sources showed. */
  finding?: string;
  limitations?: string[];
  /** Scope "responses": which responses make this claim. */
  from?: string[];
}

export type StepStatus = "done" | "skipped" | "failed";

/** One stage of the check, so the user can see what was and wasn't done. */
export interface VerifyStep {
  id: "claims" | "documents" | "web" | "compare";
  label: string;
  status: StepStatus;
  detail: string;
}

export interface VerifyResult {
  searched: boolean;
  reason: string | null;
  headline: string | null;
  claims: VerifiedClaim[];
  sources: { url: string; title: string; origin?: "web" | "document" }[];
  notices: string[];
  steps?: VerifyStep[];
  /** When sources were retrieved (ISO). */
  retrievedAt?: string | null;
  /** "model" when an AI model judged claim–source pairs; "rules" for keyword checks only. */
  method?: "model" | "rules" | null;
}

export const reviseRequest = z.object({
  question: z.string().trim().max(4000).default(""),
  answer: z.string().trim().min(1).max(40000),
  findings: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(1000),
        status: z.string().max(40).nullable(),
        evidence: z
          .array(z.object({ title: z.string().max(300), url: z.string().max(2000).nullable(), stance: z.string().max(20), quote: z.string().max(1000).nullable() }))
          .max(5)
          .default([]),
      }),
    )
    .min(1)
    .max(60),
  modelId: z.string().min(1).max(120).optional(),
});
export type ReviseRequest = z.infer<typeof reviseRequest>;
