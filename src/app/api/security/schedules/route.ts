import { NextResponse } from "next/server";
import { z } from "zod";
import { assertAgentAccess } from "@/lib/agent-platform/server";
import { requireUser } from "@/lib/auth";
import { audit } from "@/lib/db/security";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { alertSettingsInput, currentAlertSettings, currentSchedules, describeSchedule, lastRuns, MAX_SCHEDULES, nextRun, scheduleInput, type AuditEvent } from "@/lib/security/schedules";

async function events(auth: Awaited<ReturnType<typeof requireUser>>) {
  const { data, error } = await auth.supabase
    .from("security_audit")
    .select("action,detail,created_at")
    .eq("user_id", auth.user.id)
    .in("action", ["schedule.set", "schedule.removed", "schedule.ran", "alerts.settings"])
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw new ApiError("upstream_error", "Schedules couldn't be loaded.");
  return (data ?? []) as AuditEvent[];
}

/** GET /api/security/schedules — the person's scheduled audits (with last and next run) and alert settings. */
export async function GET() {
  try {
    const auth = await requireUser();
    const ev = await events(auth);
    const last = lastRuns(ev);
    return NextResponse.json({
      schedules: currentSchedules(ev).map((s) => ({ ...s, label: describeSchedule(s), lastRun: last.get(s.id) ?? null, nextRun: nextRun(s, last.get(s.id)) })),
      alerts: currentAlertSettings(ev),
    });
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.union([
  z.object({ op: z.literal("set"), id: z.uuid().optional(), schedule: scheduleInput }),
  z.object({ op: z.literal("remove"), id: z.uuid() }),
  z.object({ op: z.literal("alerts"), alerts: alertSettingsInput }),
]);

/** POST /api/security/schedules — add, change or remove a schedule, or change alert settings. Every change is logged. */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    await assertAgentAccess(auth, "security");
    const input = await parseJsonBody(req, body, 4_000);
    if (input.op === "alerts") {
      await audit(auth.supabase, auth.user.id, "alerts.settings", { detail: input.alerts });
      return NextResponse.json({ ok: true });
    }
    const current = currentSchedules(await events(auth));
    if (input.op === "remove") {
      if (!current.some((s) => s.id === input.id)) throw new ApiError("not_found", "Schedule not found.");
      await audit(auth.supabase, auth.user.id, "schedule.removed", { detail: { id: input.id } });
      return NextResponse.json({ ok: true });
    }
    const id = input.id ?? crypto.randomUUID();
    if (input.id && !current.some((s) => s.id === input.id)) throw new ApiError("not_found", "Schedule not found.");
    if (!input.id && current.length >= MAX_SCHEDULES) throw new ApiError("bad_request", `You can have up to ${MAX_SCHEDULES} scheduled audits.`);
    await audit(auth.supabase, auth.user.id, "schedule.set", { detail: { id, schedule: input.schedule } });
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return errorResponse(err);
  }
}
