import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { audit, getFinding, updateFinding } from "@/lib/db/security";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { classify, findingDetails, investigation, type FindingLike } from "@/lib/security/details";
import { findingPatch } from "@/lib/security/schema";

/**
 * GET /api/security/findings/[id] — a finding with related findings, duplicates and its audit history, plus
 * its classification, details (reproduction, expected vs observed, impact, root cause, verification) and the
 * investigation record, all derived from what was recorded.
 */
export async function GET(_req: Request, ctx: RouteContext<"/api/security/findings/[id]">) {
  try {
    const auth = await requireUser();
    const id = requireUuid((await ctx.params).id);
    const data = await getFinding(auth.supabase, auth.user.id, id);
    const others = (data.related as unknown as FindingLike[]).map((r) => ({ ...r, description: "", evidence: [], remediation: "", verification: "not_verified", related: [id] }));
    return NextResponse.json({ ...data, classification: classify(data.finding, others), details: findingDetails(data.finding), investigation: investigation(data.finding, others) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * PATCH /api/security/findings/[id] — change status, correct severity or
 * confidence, add a note, or mark as a duplicate. Every change is audited
 * with its previous value.
 */
export async function PATCH(req: Request, ctx: RouteContext<"/api/security/findings/[id]">) {
  try {
    const auth = await requireUser();
    const id = requireUuid((await ctx.params).id);
    const body = await parseJsonBody(req, findingPatch);
    const { finding: before } = await getFinding(auth.supabase, auth.user.id, id);
    if (body.duplicate_of) {
      if (body.duplicate_of === id) throw new ApiError("bad_request", "A finding can't be a duplicate of itself.");
      const { finding: target } = await getFinding(auth.supabase, auth.user.id, body.duplicate_of);
      if (target.duplicate_of) throw new ApiError("bad_request", "Choose the original finding, not another duplicate.");
    }
    const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
    if (!Object.keys(patch).length) throw new ApiError("bad_request", "Nothing to change.");
    const finding = await updateFinding(auth.supabase, auth.user.id, id, patch);
    const changes = Object.fromEntries(Object.keys(patch).map((k) => [k, { from: (before as unknown as Record<string, unknown>)[k] ?? null, to: patch[k] }]));
    await audit(auth.supabase, auth.user.id, "finding.updated", { findingId: id, detail: changes });
    return NextResponse.json({ finding });
  } catch (err) {
    return errorResponse(err);
  }
}
