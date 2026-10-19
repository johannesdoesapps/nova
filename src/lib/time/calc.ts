/**
 * Calendar and time-zone arithmetic on top of the IANA rules built into the
 * runtime (Intl), so daylight saving time and historical rule changes are
 * handled by the time-zone database rather than by fixed offsets.
 */

export interface CivilDate {
  year: number;
  month: number; // 1-12
  day: number;
}

export interface ZonedParts extends CivilDate {
  hour: number;
  minute: number;
  second: number;
  weekday: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "long",
    });
    partsFormatters.set(tz, f);
  }
  return f;
}

/** The wall-clock date and time at `instant` in `tz`. */
export function zonedParts(instant: Date, tz: string): ZonedParts {
  const p = Object.fromEntries(partsFormatter(tz).formatToParts(instant).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: p.weekday!,
  };
}

/** UTC offset of `tz` at `instant`, in minutes (Zurich in summer: +120). */
export function offsetMinutes(instant: Date, tz: string): number {
  const p = zonedParts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "−" : "+";
  const a = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

function zoneName(instant: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "long" }).formatToParts(instant);
  return p.find((x) => x.type === "timeZoneName")?.value ?? tz;
}

export function formatCivilDate(d: CivilDate): string {
  return `${weekdayOf(d)}, ${d.day} ${MONTHS[d.month - 1]} ${d.year}`;
}

/** "Monday, 19 October 2026, 18:49 (UTC+02:00, Central European Summer Time)". */
export function formatZoned(instant: Date, tz: string): string {
  const p = zonedParts(instant, tz);
  const time = `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
  return `${formatCivilDate(p)}, ${time} (${formatOffset(offsetMinutes(instant, tz))}, ${zoneName(instant, tz)})`;
}

export function weekdayOf(d: CivilDate): string {
  return WEEKDAYS[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()]!;
}

/** Calendar arithmetic: adds whole days to a date, independent of time zones and DST. */
export function addDays(d: CivilDate, days: number): CivilDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

export function daysBetween(a: CivilDate, b: CivilDate): number {
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export function validCivilDate(d: CivilDate): boolean {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return t.getUTCFullYear() === d.year && t.getUTCMonth() === d.month - 1 && t.getUTCDate() === d.day;
}

export interface WallTimeResult {
  instant: Date;
  /** The wall time was skipped by a DST change (e.g. 02:30 on a spring-forward night); the next valid time is used. */
  nonexistent: boolean;
  /** The wall time happened twice (autumn fall-back); the first occurrence is used. */
  ambiguous: boolean;
}

/** The instant at which the clocks in `tz` show the given wall time. */
export function wallTimeToInstant(d: CivilDate, hour: number, minute: number, tz: string): WallTimeResult {
  const guess = Date.UTC(d.year, d.month - 1, d.day, hour, minute);
  const candidates = new Set<number>();
  for (const probe of [guess - 36 * 3_600_000, guess, guess + 36 * 3_600_000]) {
    candidates.add(guess - offsetMinutes(new Date(probe), tz) * 60_000);
  }
  const matches = [...candidates]
    .filter((t) => {
      const p = zonedParts(new Date(t), tz);
      return p.year === d.year && p.month === d.month && p.day === d.day && p.hour === hour && p.minute === minute;
    })
    .sort((a, b) => a - b);
  if (matches.length) return { instant: new Date(matches[0]!), nonexistent: false, ambiguous: matches.length > 1 };
  // In a spring-forward gap: move forward by the size of the gap.
  const before = offsetMinutes(new Date(guess - 12 * 3_600_000), tz);
  return { instant: new Date(guess - before * 60_000), nonexistent: true, ambiguous: false };
}
