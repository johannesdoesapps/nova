import { NextResponse } from "next/server";
import { alertOwner } from "@/lib/alerts";
import { dailyFindings } from "@/lib/billing/daily-check";
import { claimNotification } from "@/lib/email";
import { serverEnv } from "@/lib/env";
import { resolveBilling } from "@/lib/plans";
import { reportError } from "@/lib/observability";
import { serviceSupabase } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;

/**
 * GET /api/cron/daily — once a day (vercel.json): unusual AI spend, the site-wide cap getting close, and requests
 * reserved but never recorded. Each finding emails the owner once a day. Only Vercel Cron can call it: Vercel sends
 * CRON_SECRET as a bearer token, and without that secret set the route refuses everything.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const db = serviceSupabase();
  if (!db) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  try {
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const from = Math.min(today - 8 * DAY, month);
    const { data: runs, error } = await db
      .from("model_runs")
      .select("created_at, estimated_cost")
      .gte("created_at", new Date(from).toISOString())
      .lt("created_at", new Date(today + DAY).toISOString())
      .limit(500_000);
    if (error) throw error;
    const byDay = new Map<number, number>();
    let monthUsd = 0;
    for (const r of runs ?? []) {
      const t = Date.parse(r.created_at as string);
      const cost = Number(r.estimated_cost ?? 0);
      const day = Math.floor(t / DAY) * DAY;
      byDay.set(day, (byDay.get(day) ?? 0) + cost);
      if (t >= month) monthUsd += cost;
    }
    const yesterday = today - DAY;
    const previousDaysUsd = Array.from({ length: 7 }, (_, i) => byDay.get(yesterday - (i + 1) * DAY) ?? 0);
    const { count } = await db
      .from("usage_holds")
      .select("id", { count: "exact", head: true })
      .eq("state", "active")
      .lt("expires_at", now.toISOString())
      .gte("expires_at", new Date(now.getTime() - DAY).toISOString());
    const { data: settings } = await db.from("app_settings").select("settings").eq("id", 1).maybeSingle();
    const billing = resolveBilling((settings?.settings as { billing?: unknown } | null)?.billing);
    const siteCapUsd = billing.siteMonthlyCapUsd > 0 ? billing.siteMonthlyCapUsd : (serverEnv().monthlyAiBudgetUsd ?? 0);
    const findings = dailyFindings({ yesterdayUsd: byDay.get(yesterday) ?? 0, previousDaysUsd, monthUsd, siteCapUsd, unrecordedHolds: count ?? 0 });
    const dateKey = new Date(today).toISOString().slice(0, 10);
    const sent: string[] = [];
    for (const f of findings) {
      if (await claimNotification(null, `owner:${f.key}`, dateKey, "owner")) {
        alertOwner(`daily:${f.key}`, f.subject, f.text);
        sent.push(f.key);
      }
    }
    return NextResponse.json({ ok: true, yesterdayUsd: Math.round((byDay.get(yesterday) ?? 0) * 100) / 100, monthUsd: Math.round(monthUsd * 100) / 100, findings: findings.map((f) => f.key), sent });
  } catch (err) {
    reportError(err, { where: "cron.daily" });
    return NextResponse.json({ error: "Daily check failed." }, { status: 500 });
  }
}
