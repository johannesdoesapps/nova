import { featureLabel } from "../usage-labels";
import { MIN_SAMPLE, RATING_LABELS, type FeedbackRating } from "./events";

/** When product events and feedback started being recorded: event-based figures only cover time since. */
export const EVENTS_SINCE = "2026-10-22";

/** What admin_product_metrics returns. */
export interface RawMetrics {
  since: string;
  people: number;
  signups: number;
  onboarded: number;
  first_prompt: number;
  activated: number;
  first_useful: number;
  minutes_to_first_result: number | null;
  minutes_to_first_useful: number | null;
  retention: { d7_cohort: number; d7_returned: number; d30_cohort: number; d30_returned: number };
  returned_after_gap: number;
  active_users: number;
  features: Record<string, number>;
  events: Record<string, number>;
  workflows: { template: string | null; started: number; completed: number; failed: number }[];
  limits: { scope: string; times: number; users: number }[];
  feedback: Partial<Record<FeedbackRating, number>>;
  feedback_by_feature: { feature: string; helpful: number; total: number }[];
  projects_created: number;
  paid: { live_subscriptions: number; any_paid_ever: number };
  /** From admin_code_funnel, added by the API; missing if it couldn't be loaded. */
  code?: CodeFunnel | null;
}

/** What admin_code_funnel returns. */
export interface CodeFunnel {
  signups: number;
  started: number;
  completed: number;
  minutes_to_first_run: number | null;
}

export interface MetricRow {
  id: string;
  /** The headline figure, or null when it can't be worked out yet. */
  value: string | null;
  /** What the figure is out of, e.g. "2 of 3 sign-ups". */
  detail: string;
  /** Why there's no figure, or why to read it with care. */
  note: string | null;
}

const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;
const small = (n: number) => (n < MIN_SAMPLE ? `Only ${n} ${n === 1 ? "person" : "people"}, too few for the rate to mean much yet.` : null);

export function duration(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes)) return null;
  if (minutes < 1) return "under a minute";
  if (minutes < 90) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} days`;
}

function codeRow(c: CodeFunnel | null | undefined): MetricRow {
  if (!c) return { id: "first_build", value: null, detail: "Coding agent runs", note: "Couldn't be loaded." };
  const first = duration(c.minutes_to_first_run);
  return {
    id: "first_build",
    value: c.signups ? pct(c.started, c.signups) : null,
    detail: `${c.started} of ${c.signups} sign-ups started a coding agent run within 7 days · ${c.completed} had one finish${first ? ` · median ${first} to the first run` : ""}`,
    note: c.signups ? small(c.signups) : "No sign-ups in this period.",
  };
}

/** The measurement plan's figures, each with what it's based on and its caveats. Nothing is estimated or filled in. */
export function productReport(m: RawMetrics): MetricRow[] {
  const eventsNote = `Recorded since ${EVENTS_SINCE}; earlier activity isn't included.`;
  const fb = Object.entries(m.feedback) as [FeedbackRating, number][];
  const fbTotal = fb.reduce((n, [, v]) => n + v, 0);
  const started = m.workflows.reduce((n, w) => n + w.started, 0);
  const completed = m.workflows.reduce((n, w) => n + w.completed, 0);
  const limitTimes = m.limits.reduce((n, l) => n + l.times, 0);
  const limitUsers = m.limits.reduce((n, l) => Math.max(n, l.users), 0);

  return [
    {
      id: "activation",
      value: m.signups ? pct(m.activated, m.signups) : null,
      detail: `${m.activated} of ${m.signups} sign-ups got an AI result within 7 days · ${m.first_prompt} sent a first request`,
      note: m.signups ? small(m.signups) : "No sign-ups in this period.",
    },
    {
      id: "first_result",
      value: duration(m.minutes_to_first_result),
      detail: "Median, sign-up to first successful AI result",
      note: m.minutes_to_first_result === null ? "Nobody who signed up in this period has had a result yet." : small(m.signups),
    },
    {
      id: "first_useful",
      value: duration(m.minutes_to_first_useful),
      detail: `${m.first_useful} of ${m.signups} sign-ups used a result (copied, saved, rated helpful, or finished a template, check or comparison)`,
      note: m.minutes_to_first_useful === null ? `No useful results recorded yet. ${eventsNote}` : eventsNote,
    },
    codeRow(m.code),
    {
      id: "retention",
      value: m.retention.d7_cohort
        ? `${pct(m.retention.d7_returned, m.retention.d7_cohort)} at 7 days${m.retention.d30_cohort ? ` · ${pct(m.retention.d30_returned, m.retention.d30_cohort)} at 30 days` : ""}`
        : null,
      detail: `7 days: ${m.retention.d7_returned} of ${m.retention.d7_cohort} · 30 days: ${m.retention.d30_returned} of ${m.retention.d30_cohort} (all sign-ups old enough)`,
      note: !m.retention.d7_cohort ? "Nobody signed up long enough ago to measure." : !m.retention.d30_cohort ? "Nobody signed up 30+ days ago yet." : small(m.retention.d7_cohort),
    },
    { id: "returning", value: String(m.returned_after_gap), detail: `people came back after 7+ days away · ${m.active_users} active in the period`, note: null },
    {
      id: "workflows",
      value: started ? pct(completed, started) : null,
      detail: started ? `${completed} of ${started} template runs finished` : "No template runs yet",
      note: started ? eventsNote : `Nothing to measure yet. ${eventsNote}`,
    },
    {
      id: "adoption",
      value: Object.keys(m.features).length ? `${Object.keys(m.features).length} features used` : null,
      detail:
        Object.entries(
          Object.entries(m.features).reduce<Record<string, number>>((acc, [purpose, users]) => {
            const label = featureLabel(purpose);
            acc[label] = Math.max(acc[label] ?? 0, users);
            return acc;
          }, {}),
        )
          .sort((a, b) => b[1] - a[1])
          .map(([label, users]) => `${label} ${users}`)
          .join(" · ") || "No successful AI requests in this period",
      note: m.active_users ? small(m.active_users) : null,
    },
    {
      id: "satisfaction",
      value: fbTotal ? `${pct(m.feedback.helpful ?? 0, fbTotal)} helpful` : null,
      detail: fbTotal
        ? fb
            .sort((a, b) => b[1] - a[1])
            .map(([r, n]) => `${RATING_LABELS[r] ?? r} ${n}`)
            .join(" · ")
        : "No ratings yet",
      note: fbTotal ? (fbTotal < MIN_SAMPLE ? `Only ${fbTotal} rating${fbTotal === 1 ? "" : "s"} so far. ${eventsNote}` : eventsNote) : `Nothing to measure yet. ${eventsNote}`,
    },
    {
      id: "limits",
      value: String(limitTimes),
      detail: limitTimes ? m.limits.map((l) => `${l.scope}: ${l.times} times, ${l.users} ${l.users === 1 ? "person" : "people"}`).join(" · ") : "No requests refused by a usage limit",
      note: limitUsers ? eventsNote : `${eventsNote}`,
    },
    {
      id: "conversion",
      value: m.paid.any_paid_ever ? pct(m.paid.live_subscriptions, m.people) : null,
      detail: `${m.paid.live_subscriptions} live paid subscription${m.paid.live_subscriptions === 1 ? "" : "s"} among ${m.people} people`,
      note: m.paid.any_paid_ever ? small(m.people) : "Can't be calculated yet: no paid subscriptions have been recorded (payments aren't live).",
    },
  ];
}
