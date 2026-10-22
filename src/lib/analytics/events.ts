/**
 * Orbis's product analytics vocabulary: the events recorded, the feedback
 * options offered, and the measurement plan built on them. First-party only
 * (stored in Orbis's own database), tied to an account but never to what
 * anyone typed: properties are short ids and labels from fixed lists.
 */

export const EVENT_NAMES = [
  "useful_result",
  "workflow_started",
  "workflow_completed",
  "workflow_failed",
  "comparison_started",
  "comparison_completed",
  "verify_completed",
  "usage_limit_reached",
  "palette_command",
] as const;
export type EventName = (typeof EVENT_NAMES)[number];

/** Each event, when it's recorded, and the only properties it may carry. */
export const EVENTS: Record<EventName, { when: string; props: Record<string, RegExp> }> = {
  useful_result: {
    when: "The user does something with a result: copies it, saves it to a project or as a prompt, or rates it helpful.",
    props: { how: /^(copy|note|task|milestone|prompt|followup|helpful)$/, feature: /^(chat|agent|template|verify)$/ },
  },
  workflow_started: { when: "The first step of a template runs.", props: { template: /^[a-z][a-z0-9-]{0,59}$/ } },
  workflow_completed: { when: "A template's last step finishes.", props: { template: /^[a-z][a-z0-9-]{0,59}$/, steps: /^\d{1,2}$/ } },
  workflow_failed: { when: "A template step fails (not when the user cancels).", props: { template: /^[a-z][a-z0-9-]{0,59}$/, step: /^[a-z][a-z0-9-]{0,59}$/ } },
  comparison_started: { when: "An Arena or Council run starts.", props: { kind: /^(arena|council)$/, models: /^\d{1,2}$/ } },
  comparison_completed: { when: "An Arena or Council run returns its answers.", props: { kind: /^(arena|council)$/, models: /^\d{1,2}$/ } },
  verify_completed: { when: "A Verify check returns results.", props: { scope: /^(answer|claims|document|responses)$/, searched: /^(yes|no)$/, claims: /^\d{1,3}$/ } },
  usage_limit_reached: { when: "A request is refused because a usage limit was reached.", props: { scope: /^[a-z_]{1,20}$/ } },
  palette_command: { when: "A command is run from the command palette.", props: { group: /^[A-Za-z ]{1,30}$/ } },
};

/** Only the listed properties, as strings that match their pattern; everything else is dropped. */
export function cleanProps(event: EventName, props: Record<string, unknown> = {}): Record<string, string> {
  const allowed = EVENTS[event].props;
  const out: Record<string, string> = {};
  for (const [k, re] of Object.entries(allowed)) {
    const v = props[k];
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (re.test(s)) out[k] = s;
  }
  return out;
}

export const FEEDBACK_RATINGS = ["helpful", "incorrect", "incomplete", "not_relevant", "too_slow", "too_costly", "other"] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

export const RATING_LABELS: Record<FeedbackRating, string> = {
  helpful: "Helpful",
  incorrect: "Incorrect",
  incomplete: "Incomplete",
  not_relevant: "Not relevant",
  too_slow: "Too slow",
  too_costly: "Used more than expected",
  other: "Something else",
};

export const FEEDBACK_FEATURES = ["chat", "agent", "template", "verify", "compare", "council", "code"] as const;
export type FeedbackFeature = (typeof FEEDBACK_FEATURES)[number];

/**
 * The measurement plan: what each metric means, how it's worked out, and from
 * which records. Shown on the admin page next to the figures.
 */
export const METRICS = [
  {
    id: "activation",
    name: "Activation rate",
    definition: "Of people who signed up in the period, the share who got a successful AI result within 7 days of signing up.",
    source: "Accounts and usage records",
  },
  { id: "first_result", name: "Time to first result", definition: "Median time from signing up to the first successful AI result.", source: "Accounts and usage records" },
  {
    id: "first_useful",
    name: "Time to first useful result",
    definition: "Median time from signing up to the first result the person used: copied, saved, rated helpful, or a finished template, check or comparison.",
    source: "Product events and feedback",
  },
  {
    id: "retention",
    name: "7- and 30-day retention",
    definition: "Of people who signed up at least 7 (or 30) days ago, the share who used AI again on or after day 7 (or 30).",
    source: "Accounts and usage records",
  },
  { id: "returning", name: "Returned after a break", definition: "People who came back in the period after at least 7 days without using AI.", source: "Usage records" },
  { id: "workflows", name: "Workflow completion rate", definition: "Templates finished ÷ templates started, per template.", source: "Product events" },
  { id: "adoption", name: "Feature adoption", definition: "How many people used each feature successfully in the period.", source: "Usage records" },
  { id: "satisfaction", name: "Reported satisfaction", definition: "Share of feedback marked helpful, and the reasons given when it wasn't.", source: "Feedback" },
  { id: "limits", name: "Usage-limit friction", definition: "How often, and for how many people, requests were refused by a usage limit, by limit.", source: "Product events" },
  { id: "conversion", name: "Free to paid", definition: "People with a live paid subscription. Measurable once payments are switched on.", source: "Subscriptions" },
] as const;

/** Below this many people a rate is shown with a warning that it isn't meaningful yet. */
export const MIN_SAMPLE = 20;
