import { NextResponse } from "next/server";
import { getAllModels } from "@/lib/ai";
import { getAuth } from "@/lib/auth";
import { budgetStatus } from "@/lib/budget";
import { entitlementFor } from "@/lib/entitlements";
import { errorResponse } from "@/lib/http";
import { planLimits, planUsage } from "@/lib/usage";

/**
 * GET /api/usage — the signed-in user's plan, 5-hour and weekly allowance,
 * share of this month's AI budget used (not dollars) and when it renews, and
 * web searches left. Null for guests.
 */
export async function GET() {
  try {
    const auth = await getAuth();
    const [state, entitlement] = await Promise.all([planUsage(auth), entitlementFor(auth)]);
    if (!entitlement) return NextResponse.json({ usage: null, budget: null, plan: null }, { headers: { "Cache-Control": "no-store" } });
    const [budget, limits] = await Promise.all([
      entitlement.kind !== "unlimited" ? budgetStatus(auth, entitlement, await getAllModels()) : null,
      planLimits(auth),
    ]);
    const next = entitlement.plan === "free" ? "pro" : entitlement.plan === "pro" ? "max" : null;
    return NextResponse.json(
      {
        usage: state,
        budget: budget && budget.limitUsd ? { usedShare: Math.min(1, budget.spentUsd / budget.limitUsd), state: budget.state, resetsAt: budget.resetsAt } : null,
        plan: {
          id: entitlement.plan,
          label: entitlement.limits.label,
          interval: entitlement.interval,
          unlimited: entitlement.kind === "unlimited",
          webSearchesLeft: limits.webSearchesLeft,
          maxOutputTokens: limits.maxOutputTokens,
          tiers: limits.tiers,
          upgradeTo: next ? { id: next, label: entitlement.billing.plans[next].label, priceUsd: entitlement.billing.plans[next].priceUsd } : null,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
