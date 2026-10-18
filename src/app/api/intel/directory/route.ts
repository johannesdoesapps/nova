import { NextResponse } from "next/server";
import { getModels } from "@/lib/ai";
import { serverEnv } from "@/lib/env";
import { validatePrice, PRICE_STALE_DAYS } from "@/lib/intel/pricing";
import { parsePrivacyProfiles, POLICY_PAGES, privacyFor } from "@/lib/intel/profiles";

/** GET /api/intel/directory — models with price provenance/validation and privacy profiles. */
export async function GET() {
  const now = new Date().toISOString();
  const profiles = parsePrivacyProfiles(serverEnv().privacyProfilesJson);
  const models = (await getModels()).map((m) => ({
    ...m,
    priceValidation: validatePrice(m, now),
    privacy: privacyFor(m.provider, profiles),
    policyPage: POLICY_PAGES[m.provider] ?? null,
  }));
  return NextResponse.json({ models, priceStaleDays: PRICE_STALE_DAYS, generatedAt: now }, { headers: { "Cache-Control": "no-store" } });
}
