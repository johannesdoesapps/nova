/**
 * Feedback and product analytics: properties are filtered to fixed lists (no
 * text gets through), the opt-out, the feedback and events endpoints, and the
 * admin report never inventing a figure it can't compute.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanProps, EVENT_NAMES, EVENTS, METRICS } from "@/lib/analytics/events";
import { duration, productReport, type RawMetrics } from "@/lib/analytics/metrics";

const st = vi.hoisted(() => ({
  signedIn: true,
  tracked: [] as [string, Record<string, unknown>][],
  upserts: [] as Record<string, unknown>[],
  deletes: [] as Record<string, unknown>[],
  dbError: false,
}));

vi.mock("@/lib/analytics/server", async (orig) => ({
  ...(await orig<typeof import("@/lib/analytics/server")>()),
  trackEvent: (_a: unknown, event: string, props: Record<string, unknown>) => st.tracked.push([event, props]),
}));
vi.mock("@/lib/auth", async () => {
  const { ApiError } = await import("@/lib/http");
  const supabase = {
    from: () => ({
      upsert: async (row: Record<string, unknown>) => {
        st.upserts.push(row);
        return { error: st.dbError ? { message: "x" } : null };
      },
      delete: () => {
        const filters: Record<string, unknown> = {};
        const chain = {
          eq: (k: string, v: unknown) => {
            filters[k] = v;
            return chain;
          },
          then: (ok: (v: { error: null }) => unknown) => {
            st.deletes.push(filters);
            return Promise.resolve({ error: null }).then(ok);
          },
        };
        return chain;
      },
    }),
  };
  const auth = () => (st.signedIn ? { mode: "authenticated", user: { id: "u1" }, supabase } : { mode: "guest", user: null, supabase: null });
  return {
    getAuth: async () => auth(),
    requireUser: async () => {
      if (!st.signedIn) throw new ApiError("unauthorized", "Please sign in to continue.");
      return auth();
    },
  };
});

beforeEach(() => {
  st.signedIn = true;
  st.tracked = [];
  st.upserts = [];
  st.deletes = [];
  st.dbError = false;
});

describe("event properties", () => {
  it("keep only the listed properties with allowed values", () => {
    expect(cleanProps("workflow_started", { template: "research-topic", prompt: "my secret plan" })).toEqual({ template: "research-topic" });
    expect(cleanProps("workflow_started", { template: "Research a topic about my divorce" })).toEqual({});
    expect(cleanProps("usage_limit_reached", { scope: "day" })).toEqual({ scope: "day" });
    expect(cleanProps("useful_result", { how: "copy", feature: "chat", text: "the reply" })).toEqual({ how: "copy", feature: "chat" });
    expect(cleanProps("useful_result", { how: "exfiltrate" })).toEqual({});
    expect(cleanProps("comparison_completed", { kind: "arena", models: 3 })).toEqual({ kind: "arena", models: "3" });
  });

  it("can never carry free text: every allowed value is a short pattern", () => {
    for (const e of EVENT_NAMES) for (const re of Object.values(EVENTS[e].props)) expect(re.test("a sentence someone typed into the chat, with spaces and punctuation.")).toBe(false);
  });

  it("respect the user's opt-out", async () => {
    const { eventsAllowed } = await vi.importActual<typeof import("@/lib/analytics/server")>("@/lib/analytics/server");
    expect(eventsAllowed({})).toBe(true);
    expect(eventsAllowed(null)).toBe(true);
    expect(eventsAllowed({ productEvents: false })).toBe(false);
    expect(eventsAllowed({ productEvents: true })).toBe(true);
  });
});

describe("POST /api/feedback", () => {
  const post = async (body: unknown) => {
    const { POST } = await import("@/app/api/feedback/route");
    return POST(new Request("https://x.test/api/feedback", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
  };

  it("saves a rating with the user's own id, and counts helpful ones as useful", async () => {
    expect((await post({ feature: "chat", subjectId: "m1", rating: "helpful" })).status).toBe(200);
    expect(st.upserts[0]).toMatchObject({ user_id: "u1", feature: "chat", subject_id: "m1", rating: "helpful", comment: null });
    expect(st.tracked).toEqual([["useful_result", { how: "helpful", feature: "chat" }]]);
  });

  it("keeps a reason and the user's note, without counting it as useful", async () => {
    expect((await post({ feature: "template", subjectId: "research-topic:2026", rating: "incomplete", comment: "  Missed the costs  " })).status).toBe(200);
    expect(st.upserts[0]).toMatchObject({ rating: "incomplete", comment: "Missed the costs" });
    expect(st.tracked).toEqual([]);
  });

  it("rejects unknown ratings, long notes, and guests; reports save failures", async () => {
    expect((await post({ feature: "chat", subjectId: "m1", rating: "amazing" })).status).toBe(400);
    expect((await post({ feature: "chat", subjectId: "m1", rating: "other", comment: "x".repeat(1001) })).status).toBe(400);
    expect((await post({ feature: "email", subjectId: "m1", rating: "helpful" })).status).toBe(400);
    st.dbError = true;
    expect((await post({ feature: "chat", subjectId: "m1", rating: "helpful" })).status).toBe(500);
    st.signedIn = false;
    expect((await post({ feature: "chat", subjectId: "m1", rating: "helpful" })).status).toBe(401);
  });

  it("takes a rating back, only the user's own", async () => {
    const { DELETE } = await import("@/app/api/feedback/route");
    expect((await DELETE(new Request("https://x.test/api/feedback?feature=chat&subject=m1", { method: "DELETE" }))).status).toBe(204);
    expect(st.deletes[0]).toEqual({ user_id: "u1", feature: "chat", subject_id: "m1" });
    expect((await DELETE(new Request("https://x.test/api/feedback?feature=chat", { method: "DELETE" }))).status).toBe(400);
  });
});

describe("POST /api/events", () => {
  const post = async (body: unknown) => {
    const { POST } = await import("@/app/api/events/route");
    return POST(new Request("https://x.test/api/events", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
  };
  it("accepts only the browser-side events", async () => {
    expect((await post({ event: "useful_result", props: { how: "copy", feature: "chat" } })).status).toBe(204);
    expect(st.tracked).toEqual([["useful_result", { how: "copy", feature: "chat" }]]);
    expect((await post({ event: "workflow_completed", props: {} })).status).toBe(400);
    expect((await post({ event: "usage_limit_reached", props: {} })).status).toBe(400);
  });
  it("ignores guests", async () => {
    st.signedIn = false;
    expect((await post({ event: "palette_command", props: { group: "Actions" } })).status).toBe(204);
    expect(st.tracked).toEqual([]);
  });
});

const empty: RawMetrics = {
  since: "2026-07-24T00:00:00Z",
  people: 0,
  signups: 0,
  onboarded: 0,
  first_prompt: 0,
  activated: 0,
  first_useful: 0,
  minutes_to_first_result: null,
  minutes_to_first_useful: null,
  retention: { d7_cohort: 0, d7_returned: 0, d30_cohort: 0, d30_returned: 0 },
  returned_after_gap: 0,
  active_users: 0,
  features: {},
  events: {},
  workflows: [],
  limits: [],
  feedback: {},
  feedback_by_feature: [],
  projects_created: 0,
  paid: { live_subscriptions: 0, any_paid_ever: 0 },
};

describe("the admin report", () => {
  it("covers every metric in the plan", () => {
    expect(productReport(empty).map((r) => r.id)).toEqual(METRICS.map((m) => m.id));
  });

  it("says a figure can't be worked out rather than showing zero or a guess", () => {
    const rows = Object.fromEntries(productReport(empty).map((r) => [r.id, r]));
    for (const id of ["activation", "first_result", "first_useful", "retention", "workflows", "satisfaction", "conversion"]) expect(rows[id]!.value, id).toBeNull();
    expect(rows.activation!.note).toBe("No sign-ups in this period.");
    expect(rows.conversion!.note).toMatch(/Can't be calculated yet: no paid subscriptions/);
    expect(rows.retention!.note).toMatch(/Nobody signed up long enough ago/);
  });

  it("computes rates from the counts and flags small samples", () => {
    const rows = Object.fromEntries(
      productReport({
        ...empty,
        people: 12,
        signups: 10,
        activated: 7,
        first_prompt: 9,
        minutes_to_first_result: 4.4,
        retention: { d7_cohort: 8, d7_returned: 2, d30_cohort: 0, d30_returned: 0 },
        workflows: [
          { template: "research-topic", started: 4, completed: 3, failed: 1 },
          { template: "weekly-plan", started: 1, completed: 1, failed: 0 },
        ],
        feedback: { helpful: 3, incorrect: 1 },
        features: { chat: 9, council: 2, "council-synthesis": 2, compare: 1 },
        active_users: 9,
        paid: { live_subscriptions: 1, any_paid_ever: 1 },
      }).map((r) => [r.id, r]),
    );
    expect(rows.activation!.value).toBe("70%");
    expect(rows.activation!.note).toMatch(/Only 10 people, too few/);
    expect(rows.first_result!.value).toBe("4 min");
    expect(rows.retention!.value).toBe("25% at 7 days");
    expect(rows.retention!.note).toBe("Nobody signed up 30+ days ago yet.");
    expect(rows.workflows!.value).toBe("80%");
    expect(rows.satisfaction!.value).toBe("75% helpful");
    expect(rows.satisfaction!.detail).toBe("Helpful 3 · Incorrect 1");
    expect(rows.adoption!.detail).toBe("Chat 9 · Council 2 · Arena 1");
    expect(rows.conversion!.value).toBe("8%");
  });

  it("formats durations plainly", () => {
    expect(duration(null)).toBeNull();
    expect(duration(0.2)).toBe("under a minute");
    expect(duration(75)).toBe("75 min");
    expect(duration(300)).toBe("5 h");
    expect(duration(4 * 1440)).toBe("4 days");
  });
});
