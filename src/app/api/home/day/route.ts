import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { runTool } from "@/lib/connectors/runtime";
import type { DayEvent } from "@/lib/home";
import { calendarState } from "@/lib/home-data";
import { ApiError, errorResponse, parseQuery } from "@/lib/http";

const iso = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), "Use an ISO date and time.");
const query = z
  .object({ timeMin: iso, timeMax: iso })
  .refine((q) => Date.parse(q.timeMax) > Date.parse(q.timeMin) && Date.parse(q.timeMax) - Date.parse(q.timeMin) <= 2 * 86_400_000, "Ask for at most two days.");

/**
 * GET /api/home/day?timeMin&timeMax — the user's Google Calendar events for
 * their day (the browser sends its local day's bounds). Read only; nothing is
 * shown unless Google Calendar is connected.
 */
export async function GET(req: Request) {
  try {
    const q = parseQuery(req.url, query);
    const auth = await requireUser();
    const state = await calendarState(auth);
    if (state !== "connected") return NextResponse.json({ state, events: [] });
    const run = await runTool(auth, "calendar_events", { timeMin: q.timeMin, timeMax: q.timeMax, limit: 25 });
    if (!run.ok || !run.result) throw new ApiError("upstream_error", run.error ?? "Google Calendar didn't answer.");
    const events: DayEvent[] = run.result.items.map((i) => {
      const start = i.meta ?? "";
      // The snippet is "start → end · location…" (see the calendar connector).
      const end = (i.snippet ?? "").split(" → ")[1]?.split(" · ")[0] ?? null;
      return { title: i.title, url: i.url, start, end: end && end !== "?" ? end : null, allDay: !start.includes("T") };
    });
    return NextResponse.json({ state, events }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
