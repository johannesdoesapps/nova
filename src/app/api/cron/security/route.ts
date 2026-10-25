import { NextResponse } from "next/server";
import { reportError } from "@/lib/observability";
import { runDueSchedules } from "@/lib/security/scheduler";
import { serviceSupabase } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * GET /api/cron/security — once a day (vercel.json): run the Security Team audits people scheduled. Only Vercel
 * Cron can call it (CRON_SECRET bearer); without that secret the route refuses everything.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = serviceSupabase();
  if (!db) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  try {
    const r = await runDueSchedules(db, { budgetMs: 240_000, signal: req.signal });
    // Counts and outcomes only: no user ids in the response.
    return NextResponse.json({ ok: true, ...("ran" in r ? { ran: r.ran.length, failed: r.ran.filter((x) => x.outcome !== "completed").length } : {}), ...("due" in r ? { due: r.due, deferred: r.deferred } : {}), ...("skipped" in r ? { skipped: r.skipped } : {}) });
  } catch (err) {
    reportError(err, { where: "cron.security" });
    return NextResponse.json({ error: "Scheduled audits failed." }, { status: 500 });
  }
}
