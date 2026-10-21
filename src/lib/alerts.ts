/**
 * Error alerts by email. When the server reports several errors in a short
 * time, the owner gets one email (via Resend) saying so, with the kinds of
 * error and where they happened: never request bodies, prompts or secrets.
 * Off until RESEND_API_KEY and ALERT_EMAIL are set. Each server instance
 * sends at most one email per quiet period, so a burst is one message.
 */

const WINDOW_MS = 10 * 60_000;
const THRESHOLD = 5;
const QUIET_MS = 60 * 60_000;

type Seen = { at: number; where: string; message: string };
let recent: Seen[] = [];
let lastSent = Number.NEGATIVE_INFINITY;
let sending = false;

export function alertsConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim() && env.ALERT_EMAIL?.trim());
}

/** What an alert says: counts by place and a short, safe message for each. */
export function alertText(errors: Seen[], site: string): { subject: string; text: string } {
  const by = new Map<string, { n: number; message: string }>();
  for (const e of errors) {
    const k = e.where;
    const cur = by.get(k);
    by.set(k, { n: (cur?.n ?? 0) + 1, message: cur?.message ?? e.message });
  }
  const lines = [...by.entries()].sort((a, b) => b[1].n - a[1].n).map(([where, v]) => `• ${where}: ${v.n}× — ${v.message}`);
  return {
    subject: `Orbis: ${errors.length} errors in the last ${WINDOW_MS / 60_000} minutes`,
    text: `${site} reported ${errors.length} server errors in the last ${WINDOW_MS / 60_000} minutes.\n\n${lines.join("\n")}\n\nDetails are in Vercel → Project → Logs. You'll get at most one of these emails an hour from each server.`,
  };
}

/** Keep only the first line of a message, without anything that looks like a key or token. */
export function safeMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : ((err as { message?: string })?.message ?? "Unknown error");
  return String(raw)
    .split("\n")[0]!
    .replace(/\b(?:sk|pk|rk|re|ghp|gho|ghs|github_pat)[-_][A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_.-]{20,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted]")
    .slice(0, 200);
}

/** Note an error; send an alert when there have been enough of them recently. */
export function noteError(err: unknown, where: string, now = Date.now(), send: (subject: string, text: string) => Promise<void> = sendEmail): void {
  if (!alertsConfigured()) return;
  recent = [...recent.filter((e) => now - e.at < WINDOW_MS), { at: now, where, message: safeMessage(err) }].slice(-200);
  if (recent.length < THRESHOLD || sending || now - lastSent < QUIET_MS) return;
  const { subject, text } = alertText(recent, process.env.NEXT_PUBLIC_SITE_URL ?? "Orbis");
  sending = true;
  lastSent = now;
  recent = [];
  void send(subject, text)
    .catch((e) => console.error("[orbis] alert email failed", safeMessage(e)))
    .finally(() => {
      sending = false;
    });
}

async function sendEmail(subject: string, text: string): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.ALERT_FROM?.trim() || "Orbis alerts <onboarding@resend.dev>", to: [process.env.ALERT_EMAIL!.trim()], subject, text }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}`);
}

/** For tests. */
export function resetAlerts(): void {
  recent = [];
  lastSent = Number.NEGATIVE_INFINITY;
  sending = false;
}
