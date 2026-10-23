import { NextResponse } from "next/server";
import { getAllModels } from "@/lib/ai";
import { getAuth } from "@/lib/auth";
import { budgetStatus } from "@/lib/budget";
import { entitlementFor } from "@/lib/entitlements";
import { errorResponse } from "@/lib/http";
import { planLimits, planUsage } from "@/lib/usage";

/**
 * GET /api/usage — the signed-in user's plan, 5-hour and weekly allowance,
 * this month's AI allowance (in USD, with the part for advanced models), tokens
 * and messages today against their caps, usage by provider (OpenAI, Claude),
 * when it renews, and web searches left. Null for guests.
 */
const round = (n: number) => Math.round(n * 100) / 100;

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
        budget:
          budget && budget.limitUsd
            ? {
                usedShare: Math.min(1, budget.spentUsd / budget.limitUsd),
                state: budget.state,
                resetsAt: budget.resetsAt,
                limitUsd: round(budget.limitUsd),
                remainingUsd: round(Math.max(0, budget.limitUsd - budget.spentUsd)),
                premium: budget.premiumLimitUsd ? { usedShare: Math.min(1, budget.premiumSpentUsd / budget.premiumLimitUsd), remainingUsd: round(Math.max(0, budget.premiumLimitUsd - budget.premiumSpentUsd)), limitUsd: round(budget.premiumLimitUsd) } : null,
                tokens: budget.tokenLimit ? { used: budget.tokensUsed, limit: budget.tokenLimit } : null,
                today: budget.dailyLimit ? { used: budget.messagesToday, limit: budget.dailyLimit } : null,
                byProvider: Object.fromEntries(Object.entries(budget.byProvider).map(([k, v]) => [k, { ...v, costUsd: round(v.costUsd) }])),
              }
            : null,
        plan: {
          id: entitlement.plan,
          label: entitlement.limits.label,
          interval: entitlement.interval,
          unlimited: entitlement.kind === "unlimited",
          webSearchesLeft: limits.webSearchesLeft,
          maxOutputTokens: limits.maxOutputTokens,
          tiers: limits.tiers,
          paymentIssue: entitlement.paymentIssue,
          upgradeTo: next ? { id: next, label: entitlement.billing.plans[next].label, priceUsd: entitlement.billing.plans[next].priceUsd } : null,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
