/**
 * Trusted time context for every chat and agent turn.
 *
 * The current instant comes from the server's clock for each request (never
 * from conversation history or the model's training data). The user's time
 * zone is the browser's IANA zone when it sent a valid one. When a message is
 * about dates or times, NOVA runs its time tools on the server
 * (get_current_time, convert_time, calculate_date) and gives the model the
 * results, so answers don't depend on the model doing time-zone arithmetic.
 */
import { addDays, daysBetween, formatCivilDate, formatOffset, formatZoned, offsetMinutes, validCivilDate, wallTimeToInstant, zonedParts, type CivilDate } from "./calc";
import { findZones, validTimeZone, type ZoneMention } from "./zones";

export interface TimeContext {
  now: Date;
  /** The user's IANA zone, or null when the browser didn't send a valid one. */
  timeZone: string | null;
}

/** The trusted clock. Routes call this once per request; tests pass their own `now`. */
export function timeContext(timeZone: string | null | undefined, now: Date = new Date()): TimeContext {
  return { now, timeZone: validTimeZone(timeZone) };
}

/** System-prompt lines every turn gets: the current instant, the user's zone, and how to use them. */
export function timeSystemBlock(ctx: TimeContext): string {
  const utc = `${ctx.now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const lines = [
    "Time context (from NOVA's server clock for this message; it replaces anything earlier in the conversation):",
    ctx.timeZone
      ? `- User's local time: ${formatZoned(ctx.now, ctx.timeZone)} — time zone ${ctx.timeZone}, from the user's browser.`
      : "- The user's time zone is unknown (their browser didn't provide one). When an answer depends on local time, give it in UTC and say so, or ask which city they're in.",
    `- Current UTC time: ${utc}.`,
    "- For dates and times use this context and any <tool_result tool=\"time\"> results; don't work them out from memory. You may say the time comes from NOVA's clock; never claim you checked any other source.",
  ];
  return lines.join("\n");
}

const TIME_INTENT =
  /\b(time|clock|o'?clock|date|day|today|tonight|tomorrow|yesterday|week|weekend|month|year|hours?|minutes?|midnight|noon|am|pm|a\.m\.|p\.m\.|timezone|time zone|dst|daylight saving|until|till|ago|from now|calendar|schedule|deadline|monday|tuesday|wednesday|thursday|friday|saturday|sunday|uhr|heute|morgen|gestern|zeit|datum)\b/i;

/** Whether a message is about dates or times, so the time tools should run. */
export function isTimeQuestion(message: string): boolean {
  return TIME_INTENT.test(message) || /\d\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])/i.test(message);
}

export interface ToolCall {
  call: string;
  result: string;
}

const WEEKDAY_INDEX: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const MONTH_INDEX: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, thirty: 30 };
const num = (s: string) => NUMBER_WORDS[s.toLowerCase()] ?? Number(s);

/** A date written in the message ("25 December", "Dec 25, 2027", "2026-12-25", "Christmas"), resolved to the next occurrence. */
function parseDate(text: string, today: CivilDate): CivilDate | null {
  let m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
    return validCivilDate(d) ? d : null;
  }
  let month: number | undefined, day: number | undefined, year: number | undefined;
  m = text.match(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i"));
  if (m) [month, day, year] = [MONTH_INDEX[m[1]!.toLowerCase()], Number(m[2]), m[3] ? Number(m[3]) : undefined];
  else {
    m = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?(?:,?\\s+(\\d{4}))?\\b`, "i"));
    if (m) [day, month, year] = [Number(m[1]), MONTH_INDEX[m[2]!.toLowerCase()], m[3] ? Number(m[3]) : undefined];
  }
  if (!month && /\bchristmas\b/i.test(text)) [month, day] = [12, 25];
  if (!month && /\bnew year'?s?\b/i.test(text)) [month, day] = [1, 1];
  if (!month || !day) return null;
  let d: CivilDate = { year: year ?? today.year, month, day };
  if (!validCivilDate(d)) return null;
  if (year === undefined && daysBetween(today, d) < 0) d = { ...d, year: d.year + 1 };
  return d;
}

/** calculate_date: relative and absolute date questions on the user's local calendar. */
export function calculateDates(message: string, tz: string, now: Date): ToolCall[] {
  const today: CivilDate = zonedParts(now, tz);
  const calls: ToolCall[] = [];
  const add = (expr: string, result: string) => {
    if (!calls.some((c) => c.call.includes(`"${expr}"`))) calls.push({ call: `calculate_date("${expr}", ${tz})`, result });
  };
  const text = message.toLowerCase();
  if (/\bday after tomorrow\b/.test(text)) add("day after tomorrow", formatCivilDate(addDays(today, 2)));
  if (/\bday before yesterday\b/.test(text)) add("day before yesterday", formatCivilDate(addDays(today, -2)));
  if (/\btoday\b|\bwhat(?:'s| is) the date\b|\bwhat day is it\b|\bheute\b/.test(text)) add("today", formatCivilDate(today));
  if (/\btomorrow\b|\bmorgen\b/.test(text) && !/\bday after tomorrow\b/.test(text)) add("tomorrow", formatCivilDate(addDays(today, 1)));
  if (/\byesterday\b|\bgestern\b/.test(text) && !/\bday before yesterday\b/.test(text)) add("yesterday", formatCivilDate(addDays(today, -1)));
  for (const m of text.matchAll(/\bin (\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|thirty) (day|week|month|year)s?\b/g)) {
    add(`in ${m[1]} ${m[2]}s`, formatCivilDate(shift(today, num(m[1]!), m[2]!)));
  }
  for (const m of text.matchAll(/\b(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|thirty) (day|week|month|year)s? (ago|from now|from today)\b/g)) {
    const n = num(m[1]!) * (m[3] === "ago" ? -1 : 1);
    add(`${m[1]} ${m[2]}s ${m[3]}`, formatCivilDate(shift(today, n, m[2]!)));
  }
  for (const m of text.matchAll(/\b(next|this|last|coming|on) (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/g)) {
    const target = WEEKDAY_INDEX[m[2]!]!;
    const current = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    let diff = (target - current + 7) % 7;
    if (m[1] === "last") diff = diff === 0 ? -7 : diff - 7;
    else if (m[1] === "next") diff = diff === 0 ? 7 : diff;
    add(`${m[1]} ${m[2]}`, formatCivilDate(addDays(today, diff)));
  }
  const until = text.match(/\b(?:how (?:many|long)[\w\s]*?(?:until|till|to|before)|days? (?:until|till|left until|to go until))\s+(.+)/);
  const target = until ? parseDate(until[1]!, today) : null;
  if (target) {
    const n = daysBetween(today, target);
    add(`days until ${until![1]!.replace(/[?.!]+$/, "").trim()}`, `${n} day${Math.abs(n) === 1 ? "" : "s"} (from ${formatCivilDate(today)} to ${formatCivilDate(target)})`);
  } else if (/\bwhat day\b|\bwhich day\b|\bday of the week\b/.test(text)) {
    const d = parseDate(message, today);
    if (d) add(`weekday of ${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`, formatCivilDate(d));
  }
  return calls;
}

function shift(d: CivilDate, n: number, unit: string): CivilDate {
  if (unit === "day") return addDays(d, n);
  if (unit === "week") return addDays(d, n * 7);
  const months = unit === "year" ? n * 12 : n;
  const total = d.year * 12 + (d.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { year, month, day: Math.min(d.day, last) };
}

/** A clock time in the message, e.g. "3pm", "15:30", "9:00 am". */
function parseClock(text: string): { hour: number; minute: number; label: string; index: number } | null {
  const m = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])|\b(\d{1,2}):(\d{2})\b/i);
  if (!m) return null;
  let hour = Number(m[1] ?? m[4]);
  const minute = Number(m[2] ?? m[5] ?? 0);
  const ampm = m[3]?.toLowerCase().replace(/\./g, "");
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute, label: m[0], index: m.index! };
}

/** convert_time: "3pm in Zurich in New York", "9:00 EST to London", "when it's 10am here, what time is it in Tokyo". */
export function convertTimes(message: string, zones: ZoneMention[], userTz: string | null, now: Date): ToolCall[] {
  const clock = parseClock(message);
  if (!clock || !zones.length) return [];
  let from: string | null;
  let to: string[];
  if (zones.length >= 2) {
    from = zones[0]!.zone;
    to = zones.slice(1).map((z) => z.zone);
  } else {
    const z = zones[0]!;
    // "3pm EST" / "3pm New York time" names the source; "3pm here … in Tokyo" converts from the user's zone.
    const right = message.slice(clock.index + clock.label.length, z.index);
    const namesSource = z.index > clock.index && /^\s*(?:in\s+)?$/i.test(right) && !/\bhere\b/i.test(message);
    if (namesSource) [from, to] = [z.zone, userTz ? [userTz] : ["UTC"]];
    else [from, to] = [userTz ?? "UTC", [z.zone]];
  }
  if (!from) return [];
  const day = zonedParts(now, from);
  const r = wallTimeToInstant(day, clock.hour, clock.minute, from);
  const hhmm = `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}`;
  const notes = r.nonexistent ? " — that time doesn't exist on this date because of a daylight-saving change; the next valid time is used" : r.ambiguous ? " — that time occurs twice on this date (clocks go back); the first occurrence is used" : "";
  return to
    .filter((z) => z !== from)
    .map((target) => ({
      call: `convert_time(${hhmm} on ${formatCivilDate(day)}, ${from} → ${target})`,
      result: `${formatZoned(r.instant, target)}${notes}`,
    }));
}

/**
 * Run the time tools for a message. Returns the calls and their results, or an
 * empty list when the message isn't about dates or times.
 */
export function runTimeTools(message: string, ctx: TimeContext): ToolCall[] {
  if (!isTimeQuestion(message)) return [];
  const zones = findZones(message);
  const userTz = ctx.timeZone;
  const calls: ToolCall[] = [];
  for (const tz of [...new Set([userTz ?? "UTC", ...zones.map((z) => z.zone)])]) {
    calls.push({ call: `get_current_time(${tz})`, result: formatZoned(ctx.now, tz) });
  }
  calls.push(...convertTimes(message, zones, userTz, ctx.now));
  calls.push(...calculateDates(message, userTz ?? "UTC", ctx.now));
  const unknown = zones.length === 0 && /\b(?:time|date|day)\b.*\bin\s+([A-Z][\w-]*(?:\s+[A-Z][\w-]*)*)\s*[?.!]*\s*$/.exec(message);
  if (unknown) calls.push({ call: `get_current_time("${unknown[1]}")`, result: "Not run: NOVA couldn't match this place to a time zone. Ask the user for the country or a nearby major city." });
  return calls;
}

/** The tool results block appended to the system prompt. */
export function timeToolBlock(calls: ToolCall[]): string {
  if (!calls.length) return "";
  return [
    '<tool_result tool="time" source="NOVA server clock">',
    ...calls.map((c) => `${c.call} → ${c.result}`),
    "</tool_result>",
    "These results were computed by NOVA's time tools for this message from the IANA time-zone database (daylight saving time included). Use them as given.",
  ].join("\n");
}

/** Everything time-related for one turn: the context block and any tool results. */
export function timePrompt(message: string, ctx: TimeContext): { system: string; calls: ToolCall[] } {
  const calls = runTimeTools(message, ctx);
  return { system: [timeSystemBlock(ctx), timeToolBlock(calls)].filter(Boolean).join("\n\n"), calls };
}

export { formatOffset, offsetMinutes };
