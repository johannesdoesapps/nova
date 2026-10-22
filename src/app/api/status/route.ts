import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { getAuth } from "@/lib/auth";
import { integrationStatus, serverEnv } from "@/lib/env";
import { errorResponse } from "@/lib/http";
import { usageSummary } from "@/lib/usage";

/** GET /api/status — which integrations are configured (booleans only; setting names for administrators) and today's usage. */
export async function GET() {
  try {
    const auth = await getAuth();
    const admin = await isAdmin(auth);
    // Which server settings exist is setup detail: administrators see the names, everyone else whether a feature is on.
    const integrations = integrationStatus().map(({ envVars, ...rest }) => (admin ? { ...rest, envVars } : rest));
    return NextResponse.json(
      {
        integrations,
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
