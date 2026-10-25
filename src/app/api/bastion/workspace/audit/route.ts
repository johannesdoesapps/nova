import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { loadWorkspacePolicy } from "@/lib/bastion/controls";
import { auditRows, recordEvent, requireFeature, requirePermission, resolveWorkspace } from "@/lib/bastion/customer/workspace";
import { historyDays } from "@/lib/bastion/customer/tiers";
import { DEFAULT_CUSTOMER_POLICY } from "@/lib/bastion/customer/policy";
import { errorResponse } from "@/lib/http";

const AREAS: Record<string, (a: string) => boolean> = {
  decisions: (a) => /^bastion\.(deny|allow|needs_approval)$/.test(a),
  policy: (a) => a === "bastion.policy" || a === "bastion.role",
  findings: (a) => a === "bastion.finding" || a === "bastion.assessment",
  integrations: (a) => a === "bastion.integration",
  notices: (a) => a === "bastion.notice",
  access: (a) => a === "bastion.access_review" || a === "bastion.role",
  security: (a) => !a.startsWith("bastion."),
};

/**
 * GET /api/bastion/workspace/audit?workspace=&area=&q=&format=json — the workspace's security audit log within its
 * history window: who did what, when, the outcome, the correlation id, and whether the record's signature checks
 * out. Secrets are never stored in these records. `format=json` downloads it (Business).
 */
export async function GET(req: Request) {
  try {
    const auth = await requireUser();
    const url = new URL(req.url);
    const ctx = await resolveWorkspace(auth, url.searchParams.get("workspace"));
    requirePermission(ctx, "audit_view");
    const ws = await loadWorkspacePolicy(ctx.db, ctx.ownerId);
    const days = historyDays(ctx.tier, ws === "unavailable" ? null : (ws.current.policy ?? DEFAULT_CUSTOMER_POLICY).retentionDays);
    const area = url.searchParams.get("area") ?? "";
    const q = (url.searchParams.get("q") ?? "").toLowerCase().slice(0, 100);
    const rows = (await auditRows(ctx, { sinceDays: days, limit: 2000 }))
      .filter((r) => !area || AREAS[area]?.(r.action))
      .filter((r) => !q || `${r.action} ${JSON.stringify(r.detail)}`.toLowerCase().includes(q))
      .map((r) => {
        const { sig: _s, policy: _p, ...detail } = r.detail;
        void _s;
        void _p;
        return {
          id: r.id,
          at: r.created_at,
          action: r.action,
          actor: typeof detail.actor === "string" ? detail.actor : null,
          cid: typeof detail.cid === "string" ? detail.cid : null,
          integrity: r.integrity,
          detail,
        };
      });
    if (url.searchParams.get("format") === "json") {
      requireFeature(ctx, "export");
      await recordEvent(ctx, "bastion.export", { what: "audit", rows: rows.length, area: area || "all" });
      return new NextResponse(JSON.stringify({ workspace: ctx.ownerId, exportedAt: new Date().toISOString(), days, rows }, null, 2), {
        headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="bastion-audit-${new Date().toISOString().slice(0, 10)}.json"`, "Cache-Control": "no-store" },
      });
    }
    return NextResponse.json(
      { days, total: rows.length, rows: rows.slice(0, 300), tamperedOrUnsigned: rows.filter((r) => r.integrity !== "signed" && r.action.startsWith("bastion.")).length },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
