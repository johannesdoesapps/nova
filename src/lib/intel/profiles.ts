import { z } from "zod";
import type { PrivacyProfile } from "./types";

/**
 * Privacy profiles per provider. Defaults are deliberately "not verified":
 * provider data policies change and differ by account tier/contract, so the
 * operator must confirm them (with a source URL and date) for their account.
 * Override with ORBIS_PRIVACY_PROFILES (JSON keyed by provider id).
 */
export const UNVERIFIED_PRIVACY: PrivacyProfile = {
  trainsOnApiData: null,
  retentionDays: null,
  zeroRetentionAvailable: null,
  processingRegions: null,
  sourceUrl: null,
  verifiedAt: null,
  notes: "Not verified for this deployment. Check the provider's current API data-usage policy and your contract.",
};

export const POLICY_PAGES: Record<string, string> = {
  anthropic: "https://www.anthropic.com/legal/commercial-terms",
  openai: "https://openai.com/policies/",
  google: "https://ai.google.dev/gemini-api/terms",
  xai: "https://x.ai/legal",
  deepseek: "https://platform.deepseek.com/downloads/DeepSeek%20Open%20Platform%20Terms%20of%20Service.html",
  huggingface: "https://huggingface.co/docs/inference-providers",
  demo: "",
};

const profileSchema = z.object({
  trainsOnApiData: z.boolean().nullable().default(null),
  retentionDays: z.number().int().nonnegative().nullable().default(null),
  zeroRetentionAvailable: z.boolean().nullable().default(null),
  processingRegions: z.array(z.string().max(40)).max(20).nullable().default(null),
  sourceUrl: z.url().nullable().default(null),
  verifiedAt: z.string().max(40).nullable().default(null),
  notes: z.string().max(500).default(""),
});

export function parsePrivacyProfiles(json: string | undefined): Record<string, PrivacyProfile> {
  const base: Record<string, PrivacyProfile> = {
    demo: { ...UNVERIFIED_PRIVACY, trainsOnApiData: false, retentionDays: 0, notes: "Simulated locally; nothing leaves the server." },
  };
  if (!json) return base;
  try {
    const parsed = z.record(z.string(), profileSchema).safeParse(JSON.parse(json));
    if (!parsed.success) {
      console.warn("[orbis] ORBIS_PRIVACY_PROFILES is invalid and was ignored.");
      return base;
    }
    return { ...base, ...parsed.data };
  } catch {
    console.warn("[orbis] ORBIS_PRIVACY_PROFILES is not valid JSON and was ignored.");
    return base;
  }
}

export function privacyFor(provider: string, profiles: Record<string, PrivacyProfile>): PrivacyProfile {
  return profiles[provider] ?? UNVERIFIED_PRIVACY;
}
