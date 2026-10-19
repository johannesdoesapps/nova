import { NextResponse } from "next/server";
import { getAllModels } from "@/lib/ai";
import { getAuth } from "@/lib/auth";
import { budgetStatus } from "@/lib/budget";
import { entitlementFor } from "@/lib/entitlements";
import { errorResponse } from "@/lib/http";
import { planUsage } from "@/lib/usage";

/**
 * GET /api/usage — the signed-in user's 5-hour and weekly allowance, and how
 * much of this month's AI budget is used (as a share, not dollars). Null for guests.
 */
export async function GET() {
  try {
    const auth = await getAuth();
    const [state, entitlement] = await Promise.all([planUsage(auth), entitlementFor(auth)]);
    const budget = entitlement && entitlement.kind !== "unlimited" ? await budgetStatus(auth, entitlement, await getAllModels()) : null;
    return NextResponse.json(
      {
        usage: state,
        budget:
          budget && budget.limitUsd
            ? { usedShare: Math.min(1, budget.spentUsd / budget.limitUsd), state: budget.state, resetsAt: budget.resetsAt }
            : null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
