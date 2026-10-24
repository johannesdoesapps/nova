import { NextResponse } from "next/server";
import { getAllModels } from "@/lib/ai";
import { getAuth } from "@/lib/auth";
import { budgetStatus } from "@/lib/budget";
import { entitlementFor } from "@/lib/entitlements";
import { errorResponse } from "@/lib/http";
import { planLimits, planUsage } from "@/lib/usage";
import { monthlyAllowances } from "@/lib/allowances";

/**
 * GET /api/usage — the signed-in user's plan, 5-hour and weekly allowance,
 * this month's AI allowance (in USD, with the part for advanced models), tokens
 * and messages today against their caps, usage by provider (OpenAI, Claude),
 * when it renews, and web searches left. Null for guests.
 */

export async function GET() {
  try {
    const auth = await getAuth();
    const [state, entitlement] = await Promise.all([planUsage(auth), entitlementFor(auth)]);
    if (!entitlement) return NextResponse.json({ usage: null, budget: null, plan: null }, { headers: { "Cache-Control": "no-store" } });
    const [budget, limits, allowances] = await Promise.all([
      entitlement.kind !== "unlimited" ? budgetStatus(auth, entitlement, await getAllModels()) : null,
      planLimits(auth),
      auth.mode === "authenticated" ? monthlyAllowances(auth).catch(() => null) : null,
    ]);
    const next = entitlement.plan === "free" ? "pro" : entitlement.plan === "pro" ? "max" : null;
    return NextResponse.json(
      {
        usage: state,
        allowances,
        budget:
          budget && budget.limitUsd
            ? {
                usedShare: Math.min(1, budget.spentUsd / budget.limitUsd),
                state: budget.state,
                resetsAt: budget.resetsAt,
                // Shares only: the plan's AI budget and what requests cost Orbis are internal (Admin → Finance).
                premium: budget.premiumLimitUsd ? { usedShare: Math.min(1, budget.premiumSpentUsd / budget.premiumLimitUsd) } : null,
                tokens: budget.tokenLimit ? { used: budget.tokensUsed, limit: budget.tokenLimit } : null,
                today: budget.dailyLimit ? { used: budget.messagesToday, limit: budget.dailyLimit } : null,
                byProvider: Object.fromEntries(Object.entries(budget.byProvider).map(([k, v]) => [k, { calls: v.calls, inputTokens: v.inputTokens, outputTokens: v.outputTokens }])),
              }
            : null,
        plan: {
          id: entitlement.plan,
          label: entitlement.limits.label,
          interval: entitlement.interval,
          unlimited: entitlement.kind === "unlimited",
          webSearchesLeft: limits.webSearchesLeft,
          webSearches: entitlement.limits.webSearchesPerPeriod,
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
