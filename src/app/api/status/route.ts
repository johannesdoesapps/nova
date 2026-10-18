import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth";
import { integrationStatus, serverEnv } from "@/lib/env";
import { errorResponse } from "@/lib/http";
import { usageSummary } from "@/lib/usage";

/** GET /api/status — which integrations are configured (booleans only) and today's usage. */
export async function GET() {
  try {
    const auth = await getAuth();
    return NextResponse.json(
      {
        integrations: integrationStatus(),
        limits: { maxCompareModels: serverEnv().maxCompareModels, dailyRequestLimit: serverEnv().dailyRequestLimit },
        user: auth.user ? { id: auth.user.id, email: auth.user.email, displayName: auth.user.displayName } : null,
        usage: await usageSummary(auth),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
