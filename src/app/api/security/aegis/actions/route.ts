import { NextResponse } from "next/server";
import { z } from "zod";
import { assertAgentAccess } from "@/lib/agent-platform/server";
import { requireUser } from "@/lib/auth";
import { audit, listFindings, listRuns, listTargets } from "@/lib/db/security";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import type { AegisFinding } from "@/lib/security/aegis/model";
import { canTransition, REMEDIATION_STATUSES, remediations } from "@/lib/security/aegis/workflow";

const uuid = z.string().uuid();
const body = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("asset"),
    asset: z.string().min(1).max(300),
    criticality: z.enum(["critical", "high", "medium", "low"]).nullable().optional(),
    exposure: z.enum(["internet", "internal"]).nullable().optional(),
    data: z
      .array(z.enum(["personal", "financial", "credentials", "health", "public"]))
      .max(5)
      .optional(),
    owner: z.string().trim().max(120).nullable().optional(),
    links: z.array(z.string().min(1).max(300)).max(20).optional(),
  }),
  z.object({ kind: z.literal("exception"), findingId: uuid, until: z.string().date().optional(), reason: z.string().trim().min(10).max(1000).optional(), revoke: z.boolean().optional() }),
  z.object({ kind: z.literal("task"), taskId: z.string().regex(/^T-[0-9A-F]{8}$/), action: z.enum(["accept", "dismiss"]) }),
  z.object({
    kind: z.literal("remediation"),
    remediationId: z
      .string()
      .regex(/^R-[0-9a-z]{6,20}$/)
      .optional(),
    title: z.string().trim().min(3).max(200),
    findingIds: z.array(uuid).min(1).max(20),
    status: z.enum(REMEDIATION_STATUSES),
    note: z.string().trim().max(1000).optional(),
    rollback: z.string().trim().max(1000).optional(),
  }),
  z.object({
    kind: z.literal("investigation"),
    findingId: uuid,
    note: z.string().trim().max(2000).optional(),
    conclusion: z.string().trim().min(10).max(2000).optional(),
    outcome: z.enum(["exploitable", "not_exploitable", "false_positive", "exploited", "inconclusive"]).optional(),
  }),
  z.object({ kind: z.literal("viewed") }),
]);

/**
 * POST /api/security/aegis/actions — record a person's decision for Aegis: facts about an asset (criticality,
 * exposure, data, owner, links), a time-limited risk exception, accepting or dismissing a task, a remediation
 * step, or an investigation note/conclusion. Everything is validated against the user's own data and written to
 * the append-only audit trail; nothing here changes any system. Outcome statuses (verified, failed…) can't be set
 * by hand — they come from re-checks.
 */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    await assertAgentAccess(auth, "security");
    const b = await parseJsonBody(req, body, 20_000);
    const db = auth.supabase;
    const uid = auth.user.id;
    const findings = b.kind === "exception" || b.kind === "remediation" || b.kind === "investigation" ? ((await listFindings(db, uid, { includeDuplicates: true })) as unknown as AegisFinding[]) : [];
    const own = (id: string) => findings.some((f) => f.id === id);

    if (b.kind === "asset") {
      const [runs, targets, fs] = await Promise.all([listRuns(db, uid, 200), listTargets(db, uid), listFindings(db, uid, { includeDuplicates: true })]);
      const known = new Set<string>([...targets.map((t) => t.hostname), ...runs.map((r) => r.asset ?? ""), ...fs.map((f) => f.asset)]);
      for (const a of [b.asset, ...(b.links ?? [])]) if (!known.has(a)) throw new ApiError("bad_request", `${a} isn't one of your assets.`);
      if (b.links?.includes(b.asset)) throw new ApiError("bad_request", "An asset can't be linked to itself.");
      const { kind: _k, ...detail } = b;
      void _k;
      await audit(db, uid, "aegis.asset", { detail });
    } else if (b.kind === "exception") {
      if (!own(b.findingId)) throw new ApiError("not_found", "Finding not found.");
      if (!b.revoke) {
        if (!b.until || !b.reason) throw new ApiError("bad_request", "An exception needs an end date and a reason.");
        const days = (Date.parse(b.until) - Date.now()) / 86_400_000;
        if (days < 1 || days > 366) throw new ApiError("bad_request", "Exceptions can last from 1 day to 1 year; review it again after that.");
      }
      await audit(db, uid, "aegis.exception", { findingId: b.findingId, detail: { findingId: b.findingId, until: b.until ?? null, reason: b.reason ?? null, revoked: !!b.revoke } });
    } else if (b.kind === "task") {
      await audit(db, uid, "aegis.task", { detail: { taskId: b.taskId, action: b.action } });
    } else if (b.kind === "remediation") {
      for (const id of b.findingIds) if (!own(id)) throw new ApiError("not_found", "Finding not found.");
      const { data: evs } = await db.from("security_audit").select("detail,created_at").eq("user_id", uid).eq("action", "aegis.workflow").order("created_at").limit(2000);
      const events = ((evs ?? []) as { detail: Record<string, unknown>; created_at: string }[]).filter((e) => e.detail.kind === "remediation");
      const id = b.remediationId ?? `R-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const current = b.remediationId ? remediations(events, findings).find((r) => r.id === b.remediationId) : null;
      if (b.remediationId && !current) throw new ApiError("not_found", "Remediation not found.");
      const problem = canTransition(current?.status ?? null, b.status);
      if (problem) throw new ApiError("bad_request", problem);
      await audit(db, uid, "aegis.workflow", {
        findingId: b.findingIds[0],
        detail: { kind: "remediation", remediationId: id, title: b.title, findingIds: b.findingIds, status: b.status, note: b.note ?? "", rollback: b.rollback ?? current?.rollback ?? null },
      });
      return NextResponse.json({ ok: true, remediationId: id });
    } else if (b.kind === "investigation") {
      if (!own(b.findingId)) throw new ApiError("not_found", "Finding not found.");
      if (!b.note && !b.conclusion) throw new ApiError("bad_request", "Add a note or a conclusion.");
      if (b.conclusion && !b.outcome) throw new ApiError("bad_request", "A conclusion needs an outcome.");
      await audit(db, uid, "aegis.workflow", {
        findingId: b.findingId,
        detail: { kind: "investigation", findingId: b.findingId, note: b.note ?? null, conclusion: b.conclusion ?? null, outcome: b.outcome ?? null },
      });
    } else {
      await audit(db, uid, "aegis.viewed", { detail: {} });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
