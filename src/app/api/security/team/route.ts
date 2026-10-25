import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listConnections } from "@/lib/connectors/runtime";
import { auditLog, listFindings, listRuns } from "@/lib/db/security";
import { errorResponse } from "@/lib/http";
import { classify } from "@/lib/security/details";
import { serviceState } from "@/lib/security/connections";
import { currentAlertSettings, currentSchedules, type AuditEvent } from "@/lib/security/schedules";
import { teamAgents, type EventLike, type RunLike } from "@/lib/security/team-agents";

const OPEN = new Set(["open", "investigating", "fix_proposed"]);

/** Plain-words labels for log entries shown as recent events. Anything else is shown by its action name. */
const EVENT_LABEL: Record<string, string> = {
  "alert.raised": "Serious findings alerted",
  "audit.started": "Code audit started",
  "audit.finished": "Code audit finished",
  "scan.started": "Website scan started",
  "scan.finished": "Website scan finished",
  "deployment_audit.finished": "Vercel deployment audit finished",
  "deployment_gate.evaluated": "Deploy gate evaluated",
  "cloudflare_review.finished": "Cloudflare review finished",
  "cloudflare.change_applied": "Cloudflare setting changed (approved)",
  "cloudflare.change_failed": "Cloudflare change failed",
  "pr.comment": "Summary posted to a pull request",
  "verification.disproven": "Finding disproven by verification",
  "finding.updated": "Finding updated",
  "schedule.set": "Schedule saved",
  "schedule.removed": "Schedule removed",
  "schedule.ran": "Scheduled audit ran",
  "alerts.settings": "Alert settings changed",
  "connector.connected": "Service connected",
  "run.failed": "Run failed",
};

/**
 * GET /api/security/team — the Security Team overview: connected services (as the person's own connections),
 * findings by severity and by verification status, open vs resolved, new and reopened this week, last audit,
 * schedules, recent events and suggested next actions. Read-only; scoped to the signed-in person.
 */
export async function GET() {
  try {
    const auth = await requireUser();
    const [rows, findings, runs, log, settingsEvents] = await Promise.all([
      listConnections(auth).catch(() => []),
      listFindings(auth.supabase, auth.user.id, { scope: "security" }),
      listRuns(auth.supabase, auth.user.id, 80),
      auditLog(auth.supabase, auth.user.id, 300),
      auth.supabase.from("security_audit").select("action,detail,created_at").eq("user_id", auth.user.id).in("action", ["schedule.set", "schedule.removed", "alerts.settings"]).order("created_at").limit(2000),
    ]);
    const integrations = await Promise.all((["github", "vercel", "cloudflare"] as const).map((id) => serviceState(auth, id, rows)));

    const open = findings.filter((f) => OPEN.has(f.status));
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 } as Record<string, number>;
    for (const f of open) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    const byVerification = { confirmed: 0, likely: 0, needs_verification: 0, informational: 0 } as Record<string, number>;
    for (const f of open) {
      const c = classify(f as never);
      if (c in byVerification) byVerification[c]!++;
    }
    const week = Date.now() - 7 * 86_400_000;
    const status = {
      open: open.length,
      awaitingVerification: findings.filter((f) => f.status === "fixed").length,
      fixedVerified: findings.filter((f) => f.status === "verified").length,
      acceptedRisk: findings.filter((f) => f.status === "accepted_risk").length,
      falsePositive: findings.filter((f) => f.status === "false_positive").length,
    };
    const events = log as unknown as (AuditEvent & { id: number; run_id: string | null; finding_id: string | null })[];
    const reopenedRecently = new Set(
      events.filter((e) => Date.parse(e.created_at) >= week && e.action === "alert.raised").flatMap((e) => ((e.detail?.top as { reopened?: boolean }[] | undefined) ?? []).filter((t) => t.reopened).map(() => e.run_id)),
    );
    const newThisWeek = findings.filter((f) => Date.parse(f.first_seen) >= week).length;
    const last = runs.find((r) => r.status === "completed");
    const settings = (settingsEvents.data ?? []) as AuditEvent[];
    const schedules = currentSchedules(settings);
    const agents = teamAgents({
      runs: runs as unknown as RunLike[],
      events: events as unknown as EventLike[],
      integrations,
      fixesAwaitingApproval: findings.filter((f) => f.status === "fix_proposed" && !!f.patch).length,
      activeSchedules: schedules.filter((s) => s.enabled).length,
      alertsByEmail: currentAlertSettings(settings).email,
    });

    const next: { text: string; href?: string; action?: string }[] = [];
    const gh = integrations[0]!;
    if (gh.status !== "connected") next.push({ text: "Connect GitHub so Code Guardian can audit private repositories and pull requests.", href: "/connectors" });
    if (byVerification.needs_verification) next.push({ text: `${byVerification.needs_verification} open finding(s) still need verification: review them before acting.`, href: "/agents/security?tab=findings" });
    if (bySeverity.critical || bySeverity.high) next.push({ text: `${(bySeverity.critical ?? 0) + (bySeverity.high ?? 0)} open critical/high finding(s): start with these.`, href: "/agents/security?tab=findings" });
    if (status.awaitingVerification) next.push({ text: `${status.awaitingVerification} fix(es) are awaiting verification: run a re-check to confirm them.` });
    if (integrations[1]!.status === "connected" && !runs.some((r) => r.action === "deployment")) next.push({ text: "Run a Vercel deployment audit.", action: "deployment" });
    if (integrations[2]!.status === "connected" && !runs.some((r) => r.action === "cloudflare")) next.push({ text: "Run a Cloudflare protection review.", action: "cloudflare" });
    if (!schedules.length) next.push({ text: "Schedule a daily or weekly audit so regressions are caught without you remembering to check.", href: "/agents/security?tab=schedules" });

    return NextResponse.json({
      agents,
      integrations,
      bySeverity,
      byVerification,
      status,
      newThisWeek,
      reopenedAlertsThisWeek: reopenedRecently.size,
      lastAudit: last ? { id: last.id, agent: last.agent, action: last.action, asset: last.asset, at: last.finished_at ?? last.started_at } : null,
      events: events.slice(0, 15).map((e) => ({ id: e.id, label: EVENT_LABEL[e.action] ?? e.action, action: e.action, at: e.created_at, runId: e.run_id, findingId: e.finding_id })),
      next: next.slice(0, 6),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
