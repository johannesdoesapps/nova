/**
 * Trusted time: the time service and tools with a controllable clock, and the
 * chat and agent routes passing fresh time context to the model (demo provider,
 * mocked; no real model is called here).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { addDays, offsetMinutes, wallTimeToInstant, zonedParts } from "@/lib/time/calc";
import { calculateDates, runTimeTools, timeContext, timePrompt, timeSystemBlock } from "@/lib/time/context";
import { findZones, validTimeZone } from "@/lib/time/zones";
import { demoProvider } from "@/lib/ai/providers/demo";
import type { GenerateParams } from "@/lib/ai/types";

const at = (iso: string) => new Date(iso);
const results = (msg: string, tz: string | null, now: Date) => runTimeTools(msg, timeContext(tz, now)).map((c) => `${c.call} → ${c.result}`);

describe("time service", () => {
  it("reports the current date and time from the trusted clock, in the user's zone", () => {
    const ctx = timeContext("Europe/Zurich", at("2026-10-19T16:40:00Z"));
    const block = timeSystemBlock(ctx);
    expect(block).toContain("Monday, 19 October 2026, 18:40 (UTC+02:00, Central European Summer Time)");
    expect(block).toContain("time zone Europe/Zurich");
    expect(block).toContain("2026-10-19 16:40 UTC");
  });

  it("answers for another zone, with daylight saving time", () => {
    const r = results("What time is it in New York?", "Europe/Zurich", at("2026-10-19T16:40:00Z"));
    expect(r).toContain("get_current_time(America/New_York) → Monday, 19 October 2026, 12:40 (UTC−04:00, Eastern Daylight Time)");
    // After New York's clocks go back (1 Nov 2026) the offset is −05:00.
    expect(results("time in NYC?", "Europe/Zurich", at("2026-11-02T17:00:00Z"))).toContain(
      "get_current_time(America/New_York) → Monday, 2 November 2026, 12:00 (UTC−05:00, Eastern Standard Time)",
    );
  });

  it("calculates tomorrow on the user's local calendar around midnight", () => {
    // 23:30 UTC on 19 October is already 01:30 on 20 October in Zurich.
    const now = at("2026-10-19T23:30:00Z");
    expect(calculateDates("What day is tomorrow?", "Europe/Zurich", now)[0]!.result).toBe("Wednesday, 21 October 2026");
    expect(calculateDates("What day is tomorrow?", "America/Los_Angeles", now)[0]!.result).toBe("Tuesday, 20 October 2026");
    expect(calculateDates("and yesterday?", "Asia/Tokyo", now)[0]!.result).toBe("Monday, 19 October 2026");
  });

  it("adds calendar days across a DST change without drifting an hour", () => {
    expect(addDays({ year: 2026, month: 3, day: 28 }, 1)).toEqual({ year: 2026, month: 3, day: 29 });
    // Zurich springs forward at 01:00 UTC on 29 March 2026.
    expect(offsetMinutes(at("2026-03-29T00:59:00Z"), "Europe/Zurich")).toBe(60);
    expect(offsetMinutes(at("2026-03-29T01:00:00Z"), "Europe/Zurich")).toBe(120);
    // 22:30 UTC on the 28th is 23:30 local (still the 28th); 23:30 UTC is 00:30 on the 29th.
    expect(calculateDates("tomorrow", "Europe/Zurich", at("2026-03-28T22:30:00Z"))[0]!.result).toBe("Sunday, 29 March 2026");
    expect(calculateDates("tomorrow", "Europe/Zurich", at("2026-03-28T23:30:00Z"))[0]!.result).toBe("Monday, 30 March 2026");
  });

  it("handles wall times that are skipped or repeated by DST", () => {
    const gap = wallTimeToInstant({ year: 2026, month: 3, day: 8 }, 2, 30, "America/New_York");
    expect(gap.nonexistent).toBe(true);
    expect(zonedParts(gap.instant, "America/New_York")).toMatchObject({ hour: 3, minute: 30 });
    const repeat = wallTimeToInstant({ year: 2026, month: 11, day: 1 }, 1, 30, "America/New_York");
    expect(repeat.ambiguous).toBe(true);
    expect(repeat.instant.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("converts a time between zones", () => {
    const r = results("Our call is at 3pm EST — what time is that in London?", "Europe/Zurich", at("2026-10-19T10:00:00Z"));
    expect(r.find((x) => x.startsWith("convert_time"))).toBe(
      "convert_time(15:00 on Monday, 19 October 2026, America/New_York → Europe/London) → Monday, 19 October 2026, 20:00 (UTC+01:00, British Summer Time)",
    );
    const here = results("meeting at 9am, what time is that in Sydney", "Europe/Zurich", at("2026-10-19T10:00:00Z"));
    expect(here.find((x) => x.startsWith("convert_time"))).toContain("→ Monday, 19 October 2026, 18:00 (UTC+11:00");
  });

  it("works out relative and absolute dates", () => {
    const now = at("2026-10-19T10:00:00Z"); // Monday
    const r = calculateDates("How many days until Christmas? And next friday, in 2 weeks, 3 days ago", "Europe/Zurich", now).map((c) => c.result);
    expect(r).toContain("67 days (from Monday, 19 October 2026 to Friday, 25 December 2026)");
    expect(r).toContain("Friday, 23 October 2026");
    expect(r).toContain("Monday, 2 November 2026");
    expect(r).toContain("Friday, 16 October 2026");
    expect(calculateDates("What day of the week was 4 July 1776?", "UTC", now)[0]!.result).toBe("Thursday, 4 July 1776");
  });

  it("is honest when the user's time zone is unknown or a place can't be matched", () => {
    const ctx = timeContext(undefined, at("2026-10-19T10:00:00Z"));
    expect(timeSystemBlock(ctx)).toMatch(/time zone is unknown/);
    expect(timeContext("Mars/Olympus", at("2026-10-19T10:00:00Z")).timeZone).toBeNull();
    expect(results("what time is it in Gotham City", null, at("2026-10-19T10:00:00Z")).at(-1)).toMatch(/Not run: Orbis couldn't match this place/);
  });

  it("validates zone names and recognises places and abbreviations", () => {
    expect(validTimeZone("Europe/Zurich")).toBe("Europe/Zurich");
    expect(validTimeZone("Europe/Nowhere")).toBeNull();
    expect(findZones("From Zürich to new york, or 9am PST, or Asia/Tokyo").map((z) => z.zone)).toEqual(["Europe/Zurich", "America/New_York", "America/Los_Angeles", "Asia/Tokyo"]);
    // Ordinary words aren't places.
    expect(findZones("la la land, uk spelling")).toEqual([]);
  });

  it("only runs the time tools for date and time questions", () => {
    expect(timePrompt("Write a poem about rain", timeContext("Europe/Zurich", at("2026-10-19T10:00:00Z"))).calls).toEqual([]);
    expect(timePrompt("Write a poem about rain", timeContext("Europe/Zurich", at("2026-10-19T10:00:00Z"))).system).toContain("User's local time");
  });
});

describe("time context in chat and agent requests", () => {
  beforeAll(() => {
    for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ORBIS_MODELS"]) delete process.env[k];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function systemPromptFor(path: "/api/chat" | "/api/agents/chat", body: Record<string, unknown>, nowIso: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(nowIso));
    const seen: GenerateParams[] = [];
    const original = demoProvider.stream.bind(demoProvider);
    vi.spyOn(demoProvider, "stream").mockImplementation((p: GenerateParams) => {
      seen.push(p);
      return original(p);
    });
    const mod = path === "/api/chat" ? await import("@/app/api/chat/route") : await import("@/app/api/agents/chat/route");
    const res = await mod.POST(
      new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.7.0.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify(body) }),
    );
    const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    return { system: seen[0]!.messages[0]!.content, events };
  }

  it("gives the main chat fresh time context and time-tool results for every request", async () => {
    const a = await systemPromptFor("/api/chat", { message: "whats the time in new york", timeZone: "Europe/Zurich" }, "2026-10-19T16:40:00Z");
    expect(a.system).toContain("User's local time: Monday, 19 October 2026, 18:40");
    expect(a.system).toContain("get_current_time(America/New_York) → Monday, 19 October 2026, 12:40");
    expect(a.events.find((e) => e.type === "tool")).toMatchObject({ tool: { name: "time", status: "ok" } });
    // A later request in the same conversation gets the new time, not the old one.
    const b = await systemPromptFor("/api/chat", { message: "and now?", timeZone: "Europe/Zurich", history: [{ role: "user", content: "whats the time in new york" }] }, "2026-10-19T21:05:00Z");
    expect(b.system).toContain("23:05");
    expect(b.system).not.toContain("18:40");
  });

  it("gives agents the same time context", async () => {
    const r = await systemPromptFor("/api/agents/chat", { agentId: "general", message: "What day is tomorrow?", timeZone: "Asia/Tokyo" }, "2026-10-19T16:40:00Z");
    expect(r.system).toContain("User's local time: Tuesday, 20 October 2026, 01:40");
    expect(r.system).toContain('calculate_date("tomorrow", Asia/Tokyo) → Wednesday, 21 October 2026');
  });

  it("tells the model when live information wasn't fetched", async () => {
    const r = await systemPromptFor("/api/chat", { message: "What's the latest news about the election?", timeZone: "Europe/Zurich" }, "2026-10-19T16:40:00Z");
    expect(r.system).toMatch(/no web search or live data tool ran/);
  });
});
