import { NextResponse } from "next/server";
import { parseJsonBody, requireUuid } from "@/lib/http";
import { decideApproval } from "@/lib/workforce/commander";
import { approvalDecisionSchema, requireOperator, wfError } from "@/lib/workforce/server";

/**
 * POST /api/workforce/approvals/[id] — approve or reject. The decision is
 * bound to the exact payload the operator saw (hash), and the orchestrator
 * re-checks it before acting, so approvals can't be bypassed from the UI.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/workforce/approvals/[id]">) {
  try {
    const { rt } = await requireOperator();
    const id = requireUuid((await ctx.params).id);
    const b = await parseJsonBody(req, approvalDecisionSchema);
    const a = await decideApproval(rt, id, b.decision, b.note, b.payloadHash);
    return NextResponse.json({ approval: { ...a, status: b.decision } });
  } catch (err) {
    return wfError(err);
  }
}
