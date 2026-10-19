/**
 * Models don't know the current date or time, so every chat and agent turn
 * tells them. The user's time zone comes from their browser and is used only
 * when it's a real IANA zone.
 */
export function validTimeZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

export function clockLine(timeZone?: string | null, now = new Date()): string {
  const utc = `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const tz = validTimeZone(timeZone);
  const local = tz
    ? `${new Intl.DateTimeFormat("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "short" }).format(now)} in the user's time zone (${tz}), which is `
    : "";
  return `Current date and time: ${local}${utc}. Use this for questions about today's date or the time; for other places, convert from UTC and allow for daylight saving time.`;
}
