import { z } from "zod";
import { SEVERITY_ORDER, type FindingDraft } from "./types";

/**
 * Scheduled audits (Workflow D) and alert preferences (Workflow E), stored as events in the append-only
 * security_audit log ("schedule.set", "schedule.removed", "schedule.ran", "alerts.settings"), so every change is on
 * record with who and when. Scheduled audits are read-only checks without AI: a GitHub repository, a Vercel project
 * or Cloudflare zones. Website scans stay manual (they need the ownership proof re-checked by the person).
 */

export const SCHEDULE_KINDS = ["repository", "deployment", "cloudflare"] as const;
export const FREQUENCIES = ["daily", "weekly"] as const;

export const scheduleInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("repository"), repo: z.string().trim().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "Use owner/name."), frequency: z.enum(FREQUENCIES), enabled: z.boolean().default(true) }),
  z.object({ kind: z.literal("deployment"), project: z.string().trim().regex(/^[A-Za-z0-9._-]{1,100}$/), teamId: z.string().regex(/^team_[A-Za-z0-9]{1,64}$/).nullable(), frequency: z.enum(FREQUENCIES), enabled: z.boolean().default(true) }),
  z.object({ kind: z.literal("cloudflare"), zone: z.string().trim().regex(/^[A-Za-z0-9.-]{1,253}$/).nullable(), frequency: z.enum(FREQUENCIES), enabled: z.boolean().default(true) }),
]);
export type ScheduleInput = z.infer<typeof scheduleInput>;
export type Schedule = ScheduleInput & { id: string; createdAt: string; updatedAt: string };

export const MAX_SCHEDULES = 10;

export interface AuditEvent {
  action: string;
  detail: Record<string, unknown> | null;
  created_at: string;
}

/** The current schedules from the event log (oldest first). Later events replace earlier ones; removals delete. */
export function currentSchedules(events: AuditEvent[]): Schedule[] {
  const map = new Map<string, Schedule>();
  for (const e of [...events].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const id = typeof e.detail?.id === "string" ? e.detail.id : null;
    if (!id) continue;
    if (e.action === "schedule.removed") map.delete(id);
    else if (e.action === "schedule.set") {
      const parsed = scheduleInput.safeParse(e.detail?.schedule);
      if (!parsed.success) continue;
      map.set(id, { ...parsed.data, id, createdAt: map.get(id)?.createdAt ?? e.created_at, updatedAt: e.created_at });
    }
  }
  return [...map.values()];
}

/** When each schedule last ran (from "schedule.ran" events). */
export function lastRuns(events: AuditEvent[]): Map<string, { at: string; runId: string | null; outcome: string }> {
  const out = new Map<string, { at: string; runId: string | null; outcome: string }>();
  for (const e of events) {
    if (e.action !== "schedule.ran" || typeof e.detail?.id !== "string") continue;
    const prev = out.get(e.detail.id);
    if (!prev || prev.at < e.created_at) out.set(e.detail.id, { at: e.created_at, runId: typeof e.detail.runId === "string" ? e.detail.runId : null, outcome: String(e.detail.outcome ?? "unknown") });
  }
  return out;
}

const INTERVAL = { daily: 20 * 3600_000, weekly: 6.5 * 86_400_000 };

/** Due when enabled and the interval (with slack for the cron's timing) has passed since the last run. */
export function isDue(s: Schedule, last: { at: string } | undefined, now = Date.now()): boolean {
  if (!s.enabled) return false;
  if (!last) return true;
  return now - Date.parse(last.at) >= INTERVAL[s.frequency];
}

export function nextRun(s: Schedule, last: { at: string } | undefined, now = Date.now()): string | null {
  if (!s.enabled) return null;
  if (!last) return "at the next daily run (07:17 UTC)";
  const t = Date.parse(last.at) + INTERVAL[s.frequency];
  return t <= now ? "at the next daily run (07:17 UTC)" : `on or after ${new Date(t).toISOString().slice(0, 10)} (daily run at 07:17 UTC)`;
}

export function describeSchedule(s: ScheduleInput): string {
  const what = s.kind === "repository" ? `Code audit of ${s.repo}` : s.kind === "deployment" ? `Vercel deployment audit of ${s.project}` : `Cloudflare review of ${s.zone ?? "the first five active zones"}`;
  return `${what}, ${s.frequency}`;
}

/* ------------------------------------------------------------------ alerts */

export interface AlertSettings {
  /** Email the person about new or reopened serious findings. */
  email: boolean;
  /** Lowest severity that alerts. */
  minSeverity: "critical" | "high";
}
export const DEFAULT_ALERTS: AlertSettings = { email: true, minSeverity: "high" };
export const alertSettingsInput = z.object({ email: z.boolean(), minSeverity: z.enum(["critical", "high"]) });

export function currentAlertSettings(events: AuditEvent[]): AlertSettings {
  const last = [...events].filter((e) => e.action === "alerts.settings").sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const parsed = alertSettingsInput.safeParse(last?.detail);
  return parsed.success ? parsed.data : DEFAULT_ALERTS;
}

/**
 * The findings worth an alert from one run: new or reopened, at or above the threshold, and confirmed or likely.
 * Findings that still need verification never alert (they'd be noise presented as fact).
 */
export function alertWorthy(drafts: FindingDraft[], saved: { createdFingerprints: string[]; reopenedFingerprints: string[] }, settings: AlertSettings): { finding: FindingDraft; reopened: boolean }[] {
  const created = new Set(saved.createdFingerprints);
  const reopened = new Set(saved.reopenedFingerprints);
  const max = SEVERITY_ORDER[settings.minSeverity];
  return drafts
    .filter((f) => (created.has(f.fingerprint) || reopened.has(f.fingerprint)) && SEVERITY_ORDER[f.severity] <= max && (f.confidence === "confirmed" || f.confidence === "firm"))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map((f) => ({ finding: f, reopened: reopened.has(f.fingerprint) }));
}

/** Alert text: titles, severity and where — no evidence or secrets (email isn't a safe place for them). */
export function alertText(items: { finding: FindingDraft; reopened: boolean }[], runUrl: string): { subject: string; text: string } {
  const top = items[0]!.finding;
  const subject = `Orbis Security: ${items.length} ${top.severity === "critical" ? "critical" : "serious"} finding${items.length === 1 ? "" : "s"} — ${top.title.slice(0, 80)}`;
  const lines = items.slice(0, 10).map((i) => `- [${i.finding.severity}${i.reopened ? ", reopened" : ", new"}] ${i.finding.title.slice(0, 160)}${i.finding.location ? ` (${i.finding.location.slice(0, 120)})` : ""}`);
  const text = [
    `The Security Team found ${items.length} new or reopened finding${items.length === 1 ? "" : "s"} that ${items.length === 1 ? "is" : "are"} confirmed or likely:`,
    "",
    ...lines,
    ...(items.length > 10 ? [`…and ${items.length - 10} more.`] : []),
    "",
    `Evidence, impact and fixes: ${runUrl}`,
    "",
    "These come from automated checks; review them before acting. Turn these emails off on the Security Team page.",
  ].join("\n");
  return { subject, text };
}
