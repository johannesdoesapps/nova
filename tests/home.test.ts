/**
 * The signed-in home: the pure helpers (prompts, picks, preferences, context
 * line), the data loader with one part failing, GET/PATCH /api/home and the
 * calendar day route, and that every suggestion leads somewhere real. The
 * database and the calendar are stand-ins.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/http";
import {
  ago,
  applyPrefs,
  contextLine,
  dailyPicks,
  DISCOVER,
  discoverFor,
  EMPTY_PREFS,
  greetingFor,
  homeActionById,
  homePrefsPatch,
  planDayPrompt,
  QUICK_TOOLS,
  readPrefs,
  SUGGESTIONS,
  type HomeAction,
} from "@/lib/home";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/observability", () => ({ reportError: vi.fn() }));

// ---------------------------------------------------------------- stand-ins

/** A Supabase query builder: every call chains; awaiting it (or maybeSingle) gives the table's rows. */
function table(rows: unknown) {
  const q: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get: (_, k) => {
        if (k === "then") return (res: (v: unknown) => void) => res({ data: rows, error: null });
        if (k === "maybeSingle") return async () => ({ data: Array.isArray(rows) ? (rows[0] ?? null) : rows, error: null });
        if (k === "update") return (patch: Record<string, unknown>) => (db.updates.push(patch), q);
        return () => q;
      },
    },
  );
  return q;
}

const db = { tables: {} as Record<string, unknown>, updates: [] as Record<string, unknown>[], signedIn: true, failMissions: false };
const supabase = { from: (name: string) => table(db.tables[name] ?? []) };
const authed = { mode: "authenticated" as const, user: { id: "user-1", email: "pat@example.com", displayName: "Pat" }, supabase: supabase as never };

vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  getAuth: async () => (db.signedIn ? authed : { mode: "guest", user: null, supabase: null }),
  requireUser: async () => {
    if (!db.signedIn) throw new ApiError("unauthorized", "Please sign in to continue.");
    return authed;
  },
}));
vi.mock("@/lib/db", () => ({
  listChats: async () => [
    { id: "c2", title: "Pricing ideas", mode: "critic", updated_at: "2026-10-20T08:00:00Z", pinned: true, project_name: null },
    { id: "c1", title: "Trip to Lisbon", mode: "research", updated_at: "2026-10-21T08:00:00Z", pinned: false, project_name: null },
  ],
}));
vi.mock("@/lib/db/missions", () => ({
  listMissions: async () => {
    if (db.failMissions) throw new Error("db down");
    return [
      { id: "m1", name: "Launch newsletter", status: "active", updated_at: "2026-10-19T08:00:00Z", counts: { pending: 2, in_progress: 1, completed: 1, blocked: 0, cancelled: 0 } },
      { id: "m2", name: "Old plan", status: "archived", updated_at: "2026-10-01T08:00:00Z", counts: { pending: 0, in_progress: 0, completed: 0, blocked: 0, cancelled: 0 } },
    ];
  },
}));
vi.mock("@/lib/code/server", () => ({
  listProjects: async () => [
    { id: "p1", name: "Website: Nova", template: "website", sourceRepo: null, updatedAt: "2026-10-18T08:00:00Z" },
    { id: "p2", name: "API", template: "node", sourceRepo: "pat/api", updatedAt: "2026-10-21T09:00:00Z" },
  ],
}));
const runTool = vi.fn();
const cal = { setUp: false, row: null as { status: string } | null };
vi.mock("@/lib/connectors/runtime", async (orig) => ({
  ...(await orig<typeof import("@/lib/connectors/runtime")>()),
  runTool: (...a: unknown[]) => runTool(...a),
  getConnection: async () => cal.row,
  usable: (_c: unknown, row: { status: string } | null) => cal.setUp && row?.status === "connected",
}));
vi.mock("@/lib/connectors/oauth", async (orig) => ({ ...(await orig<typeof import("@/lib/connectors/oauth")>()), missingSetup: () => (cal.setUp ? [] : ["GOOGLE_CLIENT_ID"]) }));

const { loadHome, previewOf, calendarState } = await import("@/lib/home-data");
const homeRoute = await import("@/app/api/home/route");
const dayRoute = await import("@/app/api/home/day/route");

beforeEach(() => {
  db.tables = {
    messages: [
      { conversation_id: "c1", role: "assistant", content: "## Plan\nHere is a **three-day** plan for [Lisbon](https://x.example).", created_at: "2026-10-21T08:00:00Z" },
      { conversation_id: "c1", role: "user", content: "older question", created_at: "2026-10-21T07:00:00Z" },
      // Saved together with its reply: the reply is the preview.
      { conversation_id: "c2", role: "user", content: "What should we charge?", created_at: "2026-10-20T08:00:00Z" },
      { conversation_id: "c2", role: "assistant", content: "Start at $12 a month.", created_at: "2026-10-20T08:00:00Z" },
    ],
    code_agent_runs: [{ project_id: "p1", status: "needs_input", request: "Build the site", updated_at: "2026-10-21T10:00:00Z" }],
    project_tasks: [
      { id: "t1", title: "Write issue #1", status: "pending", priority: "medium", project_id: "m1" },
      { id: "t2", title: "Pick a name", status: "in_progress", priority: "low", project_id: "m1" },
    ],
    profiles: [{ preferences: { chatModel: "auto", home: { hidden: ["discover"], dismissed: ["arena"], focus: null } } }],
  };
  db.updates = [];
  db.signedIn = true;
  db.failMissions = false;
  runTool.mockReset();
  Object.assign(cal, { setUp: false, row: null });
});

// ---------------------------------------------------------------- helpers

describe("plan my day", () => {
  it("uses only what Orbis knows, and asks when it knows nothing", () => {
    const empty = planDayPrompt({ date: "Tuesday 21 October", focus: [], tasks: [], events: [], calendar: "not_connected" });
    expect(empty).toContain("Tuesday 21 October");
    expect(empty).toContain("ask me a few short questions first");
    expect(empty).not.toMatch(/calendar/i);

    const full = planDayPrompt({
      date: "Tuesday",
      focus: ["Finish the deck"],
      tasks: [{ title: "Pick a name", project: "Launch" }],
      events: [{ title: "Stand-up", when: "09:30" }],
      calendar: "connected",
    });
    expect(full).toContain("- Finish the deck");
    expect(full).toContain("- Pick a name (Launch)");
    expect(full).toContain("- 09:30: Stand-up");
  });

  it("says the calendar is empty only when it was really read", () => {
    expect(planDayPrompt({ date: "d", focus: [], tasks: [], events: [], calendar: "connected" })).toContain("no events today");
    expect(planDayPrompt({ date: "d", focus: [], tasks: [], events: [], calendar: "unavailable" })).not.toContain("no events today");
  });
});

describe("discover picks", () => {
  it("are stable for a day, change between days, and skip dismissed items", () => {
    const items = discoverFor({ search: true });
    const a = dailyPicks(items, "2026-10-21", []);
    expect(a).toHaveLength(3);
    expect(dailyPicks(items, "2026-10-21", [])).toEqual(a);
    const days = new Set(
      ["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"].map((d) =>
        dailyPicks(items, d, [])
          .map((x) => x.id)
          .join(),
      ),
    );
    expect(days.size).toBeGreaterThan(1);
    const dismissed = dailyPicks(items, "2026-10-21", [a[0]!.id]);
    expect(dismissed.map((x) => x.id)).not.toContain(a[0]!.id);
    expect(
      dailyPicks(
        items,
        "2026-10-21",
        items.map((x) => x.id),
      ),
    ).toEqual([]);
  });

  it("leaves out web research when search isn't set up", () => {
    expect(discoverFor({ search: false }).some((d) => d.needsSearch)).toBe(false);
    expect(discoverFor({ search: true }).some((d) => d.needsSearch)).toBe(true);
  });
});

describe("every suggestion leads somewhere real", () => {
  const actions: HomeAction[] = [...SUGGESTIONS.map((s) => s.action), ...DISCOVER.map((d) => d.action), ...QUICK_TOOLS.map((t) => t.action)];
  it.each(actions.filter((a) => a.kind === "link").map((a) => [(a as { href: string }).href]))("%s is a page in the app", (href) => {
    const seg = href.split("?")[0]!.replace(/^\//, "");
    expect(existsSync(join(__dirname, "..", "src", "app", "(studio)", seg, "page.tsx"))).toBe(true);
  });

  it("prompts fill the box with something to finish, in a real mode", () => {
    for (const a of actions) if (a.kind === "draft") expect(a.prompt.length).toBeGreaterThan(4);
    expect(SUGGESTIONS.map((s) => s.id)).toEqual(["research", "brainstorm", "write", "plan-day", "build"]);
  });

  it("links to /home?try= never send a message by themselves", () => {
    expect(homeActionById("plan-day")).toBeNull();
    expect(homeActionById("nope")).toBeNull();
    expect(homeActionById("summarise")).toMatchObject({ kind: "draft", attach: true });
    expect(homeActionById("council")).toEqual({ kind: "link", href: "/council" });
  });
});

describe("preferences", () => {
  it("tolerate anything malformed", () => {
    expect(readPrefs(null)).toEqual(EMPTY_PREFS);
    expect(readPrefs({ hidden: ["nope"] })).toEqual(EMPTY_PREFS);
    expect(readPrefs({ hidden: ["day"] })).toEqual({ ...EMPTY_PREFS, hidden: ["day"] });
  });

  it("a change only touches what it names", () => {
    const patch = homePrefsPatch.parse({ dismissed: ["council"] });
    expect(patch).toEqual({ dismissed: ["council"] });
    expect(applyPrefs({ hidden: ["day"], dismissed: [], focus: { day: "2026-10-21", items: [] }, pinnedAgents: ["writing"] }, patch)).toEqual({
      hidden: ["day"],
      dismissed: ["council"],
      focus: { day: "2026-10-21", items: [] },
      pinnedAgents: ["writing"],
    });
    expect(homePrefsPatch.safeParse({}).success).toBe(false);
    expect(homePrefsPatch.safeParse({ admin: true }).success).toBe(false);
    expect(homePrefsPatch.safeParse({ focus: { day: "today", items: [] } }).success).toBe(false);
    expect(homePrefsPatch.safeParse({ focus: { day: "2026-10-21", items: Array.from({ length: 9 }, (_, i) => ({ id: `item${i}xx`, text: "x", done: false })) } }).success).toBe(false);
  });
});

describe("words on the home", () => {
  it("greets by time of day", () => {
    expect(greetingFor(8, "Pat")).toBe("Good morning, Pat");
    expect(greetingFor(14, null)).toBe("Good afternoon");
    expect(greetingFor(21, null)).toBe("Good evening");
    expect(greetingFor(2, null)).toBe("Good evening");
  });

  it("describes only what's there", () => {
    expect(contextLine({ signedIn: false, conversations: [], projects: [], tasks: [] })).toMatch(/sign in/);
    expect(contextLine({ signedIn: true, conversations: [], projects: [], tasks: [] })).toMatch(/your space/);
    const busy = contextLine({
      signedIn: true,
      conversations: [],
      projects: [{ kind: "code", id: "p", name: "x", updatedAt: "", href: "", detail: "", attention: "waiting" }],
      tasks: [{ id: "t", title: "x", status: "in_progress", priority: "low", project: "", href: "" }],
    });
    expect(busy).toBe("1 project needs you and 1 task in progress. Pick up below, or start something new.");
  });

  it("dates things relative to now", () => {
    const now = Date.parse("2026-10-21T12:00:00Z");
    expect(ago("2026-10-21T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-10-21T11:15:00Z", now)).toBe("45 min ago");
    expect(ago("2026-10-21T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-10-20T09:00:00Z", now)).toBe("yesterday");
    expect(ago("2026-10-17T12:00:00Z", now)).toBe("4 days ago");
  });

  it("previews messages as plain text", () => {
    expect(previewOf("## Plan\nHere is a **three-day** plan for [Lisbon](https://x.example).")).toBe("Plan Here is a three-day plan for Lisbon.");
    expect(previewOf("```js\nlet a\n```\nDone")).toBe("[code] Done");
    expect(previewOf("x".repeat(300)).length).toBe(140);
  });
});

// ---------------------------------------------------------------- data and routes

describe("loading the home", () => {
  it("brings together conversations, projects, tasks and preferences", async () => {
    const h = await loadHome(authed);
    expect(h.errors).toEqual([]);
    expect(h.conversations.map((c) => [c.id, c.preview])).toEqual([
      ["c1", "Plan Here is a three-day plan for Lisbon."],
      ["c2", "Start at $12 a month."],
    ]);
    // Projects needing the user first, then the most recently changed; archived missions left out.
    expect(h.projects.map((p) => p.id)).toEqual(["m1", "p1", "p2"]);
    expect(h.projects.find((p) => p.id === "p1")!.attention).toBe("Code: the agent is waiting for you");
    expect(h.projects.find((p) => p.id === "p2")!.detail).toBe("pat/api project");
    expect(h.projects.find((p) => p.id === "m1")!.detail).toBe("Mission · 1 of 4 tasks done");
    // In-progress tasks first.
    expect(h.tasks.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(h.tasks[0]).toMatchObject({ project: "Launch newsletter", href: "/missions/m1" });
    expect(h.prefs).toEqual({ hidden: ["discover"], dismissed: ["arena"], focus: null, pinnedAgents: [] });
    // No Google sign-in for connectors in the test environment.
    expect(h.calendar).toBe("unavailable");
  });

  it("shows the rest when one part fails", async () => {
    db.failMissions = true;
    const h = await loadHome(authed);
    expect(h.errors).toEqual(["missions"]);
    expect(h.tasks).toEqual([]);
    expect(h.projects.map((p) => p.kind)).toEqual(["code", "code"]);
    expect(h.conversations).toHaveLength(2);
  });

  it("calendar is unavailable until the site sets up Google, then follows the user's connection", async () => {
    expect(await calendarState(authed)).toBe("unavailable");
    cal.setUp = true;
    expect(await calendarState(authed)).toBe("not_connected");
    cal.row = { status: "reauth_required" };
    expect(await calendarState(authed)).toBe("reauth");
    cal.row = { status: "connected" };
    expect(await calendarState(authed)).toBe("connected");
  });
});

describe("GET and PATCH /api/home", () => {
  const patch = (body: unknown) => homeRoute.PATCH(new Request("http://x/api/home", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  it("gives guests an empty home", async () => {
    db.signedIn = false;
    const r = await (await homeRoute.GET()).json();
    expect(r).toMatchObject({ signedIn: false, conversations: [], projects: [], tasks: [] });
  });

  it("gives the signed-in user their home", async () => {
    const res = await homeRoute.GET();
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect((await res.json()).conversations).toHaveLength(2);
  });

  it("saves a change without touching other preferences", async () => {
    const res = await patch({ hidden: [] });
    expect(res.status).toBe(200);
    expect((await res.json()).prefs).toEqual({ hidden: [], dismissed: ["arena"], focus: null, pinnedAgents: [] });
    expect(db.updates).toEqual([{ preferences: { chatModel: "auto", home: { hidden: [], dismissed: ["arena"], focus: null, pinnedAgents: [] } } }]);
  });

  it("refuses bad changes and guests", async () => {
    expect((await patch({ hidden: ["nope"] })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect(db.updates).toEqual([]);
    db.signedIn = false;
    expect((await patch({ hidden: [] })).status).toBe(401);
  });
});

describe("GET /api/home/day", () => {
  const get = (q: string) => dayRoute.GET(new Request(`http://x/api/home/day?${q}`));
  const day = `timeMin=${encodeURIComponent("2026-10-21T00:00:00+02:00")}&timeMax=${encodeURIComponent("2026-10-22T00:00:00+02:00")}`;

  it("doesn't call the calendar when it isn't connected", async () => {
    const r = await (await get(day)).json();
    expect(r).toEqual({ state: "unavailable", events: [] });
    expect(runTool).not.toHaveBeenCalled();
  });

  it("lists today's events when connected", async () => {
    Object.assign(cal, { setUp: true, row: { status: "connected" } });
    runTool.mockResolvedValue({
      ok: true,
      result: {
        summary: "2 events",
        items: [
          {
            connectorId: "google_calendar",
            title: "Stand-up",
            url: "https://calendar.example/e1",
            snippet: "2026-10-21T09:30:00+02:00 → 2026-10-21T09:45:00+02:00 · Room 2",
            meta: "2026-10-21T09:30:00+02:00",
          },
          { connectorId: "google_calendar", title: "Holiday", url: null, snippet: "2026-10-21 → 2026-10-22", meta: "2026-10-21" },
        ],
      },
    });
    const r = await (await get(day)).json();
    expect(runTool.mock.calls[0]![1]).toBe("calendar_events");
    expect(runTool.mock.calls[0]![2]).toMatchObject({ timeMin: "2026-10-21T00:00:00+02:00", timeMax: "2026-10-22T00:00:00+02:00" });
    expect(r).toEqual({
      state: "connected",
      events: [
        { title: "Stand-up", url: "https://calendar.example/e1", start: "2026-10-21T09:30:00+02:00", end: "2026-10-21T09:45:00+02:00", allDay: false },
        { title: "Holiday", url: null, start: "2026-10-21", end: "2026-10-22", allDay: true },
      ],
    });
  });

  it("reports a calendar failure as an error, not an empty day", async () => {
    Object.assign(cal, { setUp: true, row: { status: "connected" } });
    runTool.mockResolvedValue({ ok: false, error: "Google Calendar didn't answer." });
    const res = await get(day);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it("asks for at most two days", async () => {
    expect((await get(`timeMin=2026-10-01T00:00:00Z&timeMax=2026-10-21T00:00:00Z`)).status).toBe(400);
    expect((await get(`timeMin=2026-10-21T00:00:00Z&timeMax=2026-10-20T00:00:00Z`)).status).toBe(400);
  });

  it("needs a signed-in user", async () => {
    db.signedIn = false;
    expect((await get(day)).status).toBe(401);
  });
});
