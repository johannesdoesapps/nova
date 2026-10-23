import "server-only";
import { safeMessage } from "./alerts";
import { serviceSupabase } from "./supabase/admin";

/**
 * Emails to customers (welcome, usage warnings, payment problems), sent through Resend.
 * Off until RESEND_API_KEY is set; EMAIL_FROM sets the sender (a domain verified in Resend),
 * otherwise ALERT_FROM, otherwise Resend's test sender, which only delivers to the Resend
 * account's own address.
 *
 * Each message is recorded in `notifications` under (user, kind, period) before it is sent,
 * so a retried webhook, two servers or a repeated request can never send it twice.
 * Messages say what happened and what to do; never prompts, replies or payment details.
 */

export function emailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.RESEND_API_KEY?.trim());
}

const site = () => (process.env.NEXT_PUBLIC_SITE_URL ?? "https://tryorbis.app").replace(/\/$/, "");

export type CustomerEmailKind =
  | "welcome"
  | "payment_failed"
  | "payment_action_required"
  | "usage_week_80"
  | "usage_week_100"
  | "usage_top_100"
  | "budget_100"
  | "topup_charged"
  | "topup_failed"
  | "topup_cap_reached";

export interface CustomerEmail {
  subject: string;
  text: string;
}

/** The words of each email. Pure, so it can be tested. */
export function customerEmail(
  kind: CustomerEmailKind,
  data: { plan?: string; resetsAt?: number | null; graceUntil?: number | null; url?: string | null; amountUsd?: number; units?: number } = {},
): CustomerEmail {
  const when = (t: number | null | undefined) => (t ? new Date(t).toUTCString().replace(/:\d\d GMT$/, " UTC") : null);
  const usage = `${site()}/usage`;
  const sign = "\n\n— Orbis";
  switch (kind) {
    case "welcome":
      return {
        subject: `You're on Orbis ${data.plan ?? "Pro"}`,
        text: `Thanks for subscribing. Your ${data.plan ?? "paid"} plan is active now: higher limits and the models it includes are ready in Chat and Code.\n\nSee your allowance and manage your subscription at ${usage}.${sign}`,
      };
    case "payment_failed": {
      const until = when(data.graceUntil);
      return {
        subject: "Your Orbis payment didn't go through",
        text: `We couldn't take the payment for your ${data.plan ?? "Orbis"} plan. ${until ? `Your plan keeps working until ${until} while we try the card again.` : "We'll try the card again over the next few days."}\n\nTo keep your plan, update your card at ${usage} (Manage subscription).${sign}`,
      };
    }
    case "payment_action_required":
      return {
        subject: "Your bank needs you to confirm an Orbis payment",
        text: `Your bank asked for confirmation before taking the payment for your ${data.plan ?? "Orbis"} plan.${data.url ? `\n\nConfirm it here: ${data.url}` : `\n\nConfirm it from ${usage} (Manage subscription).`}${sign}`,
      };
    case "usage_week_80":
      return {
        subject: "You've used 80% of this week's Orbis allowance",
        text: `You've used 80% of your weekly allowance.${when(data.resetsAt) ? ` It resets ${when(data.resetsAt)}.` : ""}\n\nLower-cost models use far less of it. Details at ${usage}.${sign}`,
      };
    case "usage_week_100":
      return {
        subject: "You've reached this week's Orbis limit",
        text: `You've used your weekly allowance.${when(data.resetsAt) ? ` It resets ${when(data.resetsAt)}.` : ""}\n\nYou can upgrade or, on paid plans, buy extra usage at ${usage}.${sign}`,
      };
    case "usage_top_100":
      return {
        subject: "You've reached this week's limit for premium models",
        text: `You've used this week's allowance for premium models. Other models still work.${when(data.resetsAt) ? ` It resets ${when(data.resetsAt)}.` : ""}\n\nDetails at ${usage}.${sign}`,
      };
    case "topup_charged":
      return {
        subject: "Orbis topped up your extra usage",
        text: `Your extra usage was low, so we charged your saved card $${(data.amountUsd ?? 0).toFixed(2)} for ${(data.units ?? 0).toLocaleString("en-US")} units, as you set up. Stripe sends the receipt.\n\nChange or turn off automatic top-ups at ${usage}.${sign}`,
      };
    case "topup_failed":
      return {
        subject: "Automatic top-up didn't work",
        text: `We couldn't charge your saved card for an automatic top-up, so automatic top-ups are now off. Nothing was charged.\n\nYou can buy extra usage or turn automatic top-ups back on at ${usage}.${sign}`,
      };
    case "topup_cap_reached":
      return {
        subject: "Your monthly top-up limit is reached",
        text: `Automatic top-ups have reached the $${(data.amountUsd ?? 0).toFixed(2)} monthly limit you set, so no more will be charged this month. You can raise the limit at ${usage}.${sign}`,
      };
    case "budget_100":
      return {
        subject: "You've reached this month's Orbis AI allowance",
        text: `You've used this month's AI allowance.${when(data.resetsAt) ? ` It renews ${when(data.resetsAt)}.` : ""}\n\nYou can upgrade or buy extra usage at ${usage}.${sign}`,
      };
  }
}

/** Record a notification once; true only for the call that recorded it (and so should send it). */
export async function claimNotification(userId: string | null, kind: string, periodKey: string, channel: "email" | "owner" = "email"): Promise<boolean> {
  const db = serviceSupabase();
  if (!db) return false;
  // The unique index (user, kind, period) makes a second insert fail: that call must not send.
  const { data, error } = await db
    .from("notifications")
    .insert({ user_id: userId, kind, period_key: periodKey.slice(0, 80), channel })
    .select("id");
  if (error) return false; // already recorded (23505) or the table is unavailable: don't send
  return (data?.length ?? 0) > 0;
}

/** Send one customer email at most once per (user, kind, period). Never throws. */
export async function sendCustomerEmail(userId: string, kind: CustomerEmailKind, periodKey: string, data: Parameters<typeof customerEmail>[1] = {}): Promise<boolean> {
  try {
    if (!emailConfigured()) return false;
    const db = serviceSupabase();
    if (!db) return false;
    if (!(await claimNotification(userId, kind, periodKey))) return false;
    const { data: u } = await db.auth.admin.getUserById(userId);
    const to = u?.user?.email;
    if (!to) return false;
    const { subject, text } = customerEmail(kind, data);
    await sendEmailTo(to, subject, text);
    await db.from("notifications").update({ sent: true }).eq("user_id", userId).eq("kind", kind).eq("period_key", periodKey.slice(0, 80));
    return true;
  } catch (err) {
    console.error("[orbis] customer email failed", kind, safeMessage(err));
    return false;
  }
}

export async function sendEmailTo(to: string, subject: string, text: string): Promise<void> {
  const from = process.env.EMAIL_FROM?.trim() || process.env.ALERT_FROM?.trim() || "Orbis <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}`);
}
