import "server-only";

/**
 * The daily money check (run by Vercel Cron at /api/cron/daily). Pure rules here so they can be tested;
 * the route gathers the numbers and sends the alerts.
 */

export interface DailyNumbers {
  /** Recorded AI cost yesterday (UTC), USD. */
  yesterdayUsd: number;
  /** Recorded AI cost on each of the 7 days before yesterday, USD. */
  previousDaysUsd: number[];
  /** Recorded AI cost this calendar month so far, USD. */
  monthUsd: number;
  /** The admin's site-wide monthly cap, USD; 0 = none. */
  siteCapUsd: number;
  /** Reservations from the last day that expired without a recorded run (a reply whose accounting may have failed). */
  unrecordedHolds: number;
}

export interface DailyFinding {
  key: string;
  subject: string;
  text: string;
}

/** What deserves an email today. A spike is at least 3x the previous week's daily average and at least $1. */
export function dailyFindings(n: DailyNumbers): DailyFinding[] {
  const out: DailyFinding[] = [];
  const days = n.previousDaysUsd.filter((d) => Number.isFinite(d));
  const avg = days.length ? days.reduce((a, b) => a + b, 0) / days.length : 0;
  const usd = (v: number) => `$${v.toFixed(2)}`;
  if (n.yesterdayUsd >= 1 && n.yesterdayUsd >= 3 * avg) {
    out.push({
      key: "spend_spike",
      subject: `Orbis: AI spend yesterday was ${usd(n.yesterdayUsd)}`,
      text: `Yesterday's recorded AI cost was ${usd(n.yesterdayUsd)}, against a daily average of ${usd(avg)} over the week before.\n\nAdmin → Finance shows the heaviest users and models. If it looks wrong, use Admin → Plans → Spending protection (Premium models off, or Emergency stop).`,
    });
  }
  if (n.siteCapUsd > 0 && n.monthUsd >= 0.8 * n.siteCapUsd) {
    out.push({
      key: "site_cap_80",
      subject: `Orbis: ${Math.round((n.monthUsd / n.siteCapUsd) * 100)}% of this month's AI cap used`,
      text: `This month's recorded AI cost is ${usd(n.monthUsd)} of the ${usd(n.siteCapUsd)} site-wide cap. When it's reached, new AI requests stop until next month. Raise it in Admin → Plans → Spending protection if that's expected.`,
    });
  }
  if (n.unrecordedHolds > 0) {
    out.push({
      key: "unrecorded_holds",
      subject: `Orbis: ${n.unrecordedHolds} AI request${n.unrecordedHolds === 1 ? "" : "s"} without a usage record`,
      text: `In the last day, ${n.unrecordedHolds} request${n.unrecordedHolds === 1 ? " was" : "s were"} reserved but never recorded or released. That usually means a reply was cut off by a timeout, or recording failed; those requests weren't charged to the customer. Compare the provider consoles with Admin → Finance if the number keeps growing.`,
    });
  }
  return out;
}
