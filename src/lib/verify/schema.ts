import { z } from "zod";
import type { ClaimKind, ClaimStatus, Stance } from "../claims/types";

export const SEARCH_MISSING = "Web search isn't set up on this site (SEARCH_PROVIDER and SEARCH_API_KEY), so claims were identified but not checked against sources.";

export const verifyRequest = z.object({
  question: z.string().trim().max(4000).default(""),
  answer: z.string().trim().min(1, "There's nothing to verify.").max(40000),
  modelId: z.string().min(1).max(120).optional(),
});

export interface VerifiedEvidence {
  url: string | null;
  title: string;
  stance: Stance;
  /** Only present when the quote was found word-for-word in the source text. */
  quote: string | null;
}

export interface VerifiedClaim {
  text: string;
  kind: ClaimKind;
  hedged: boolean;
  /** null means no check was run for this claim. */
  status: ClaimStatus | null;
  evidence: VerifiedEvidence[];
}

export interface VerifyResult {
  searched: boolean;
  reason: string | null;
  headline: string | null;
  claims: VerifiedClaim[];
  sources: { url: string; title: string }[];
  notices: string[];
}
