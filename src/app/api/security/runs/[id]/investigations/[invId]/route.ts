import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { audit, getRunRow } from "@/lib/db/security";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { compactInvestigations, jsonBytes, type Investigation } from "@/lib/security/hunt/investigate";
import { investigationPatch } from "@/lib/security/schema";

/**
 * PATCH /api/security/runs/[id]/investigations/[invId] — record a person's decision on a Threat Hunter
 * investigation: change its state (with a reason), add a note, or mark a recommended action approved,
 * declined, done or verified. Orbis performs none of these actions itself; this is the record of what people
 * decided and did. Every change is also written to the append-only audit trail.
 */
export async function PATCH(req: Request, ctx: RouteContext<"/api/security/runs/[id]/investigations/[invId]">) {
  try {
    const auth = await requireUser();
    const { id: rawId, invId } = await ctx.params;
    const id = requireUuid(rawId);
    if (!/^inv-\d{1,3}$/.test(invId)) throw new ApiError("bad_request", "Unknown investigation.");
    const body = await parseJsonBody(req, investigationPatch, 8_000);
    const run = await getRunRow(auth.supabase, auth.user.id, id);
    if (run.agent !== "threat_hunter") throw new ApiError("bad_request", "Only Threat Hunter runs have investigations.");
    const list = Array.isArray(run.stats.investigations) ? (run.stats.investigations as Investigation[]) : [];
    const i = list.findIndex((x) => x.id === invId);
    if (i < 0) throw new ApiError("not_found", "Investigation not found.");
    const inv = { ...list[i]! };
    const at = new Date().toISOString();
    const before = inv.state;
    if (body.state && body.state !== inv.state) inv.state = body.state;
    // The run record keeps a short copy (the database caps it at 20 KB); the full note is in the audit trail.
    if (body.state || body.note)
      inv.decisions = [...(inv.decisions ?? []), { at, ...(body.state && body.state !== before ? { state: body.state } : {}), note: (body.note ?? "").slice(0, 300) }].slice(-10);
    if (body.action) {
      const [section, n] = body.action.key.split(":") as ["containment" | "credentials" | "eradication", string];
      if (!inv.response[section]?.[Number(n)]) throw new ApiError("bad_request", "That recommended action doesn't exist.");
      inv.actions = { ...(inv.actions ?? {}), [body.action.key]: { status: body.action.status, note: body.action.note, at } };
    }
    let next = [...list];
    next[i] = inv;
    let stats: Record<string, unknown> = { ...run.stats, investigations: next };
    if (jsonBytes(stats) > 19_500) {
      // Make room by shortening details (never by dropping this decision).
      const others = jsonBytes({ ...run.stats, investigations: [] });
      const compact = compactInvestigations(next, Math.max(2_000, 19_000 - others));
      next = compact.investigations;
      if (!next.some((x) => x.id === invId)) throw new ApiError("internal", "This run's record is full, so the decision couldn't be stored here. It is in the audit trail.");
      stats = { ...run.stats, investigations: next, investigationsTrimmed: [...((run.stats.investigationsTrimmed as string[] | undefined) ?? []), ...compact.trimmed].slice(-4) };
    }
    const { error } = await auth.supabase.from("security_runs").update({ stats }).eq("id", id).eq("user_id", auth.user.id);
    if (error) throw new ApiError("internal", "Could not save the decision.");
    await audit(auth.supabase, auth.user.id, "investigation.updated", {
      runId: id,
      detail: {
        investigation: invId,
        ...(body.state ? { state: { from: before, to: inv.state } } : {}),
        ...(body.note ? { note: body.note.slice(0, 2000) } : {}),
        ...(body.action ? { action: body.action } : {}),
      },
    });
    return NextResponse.json({ investigation: inv });
  } catch (err) {
    return errorResponse(err);
  }
}
