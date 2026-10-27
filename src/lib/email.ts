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
  | "signup_welcome"
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
  /** A designed version for mail apps that show HTML; the text is always sent too. */
  html?: string;
}

/** The words of each email. Pure, so it can be tested. */
export function customerEmail(
  kind: CustomerEmailKind,
  data: { plan?: string; resetsAt?: number | null; graceUntil?: number | null; url?: string | null; amountUsd?: number; units?: number; name?: string | null } = {},
): CustomerEmail {
  const when = (t: number | null | undefined) => (t ? new Date(t).toUTCString().replace(/:\d\d GMT$/, " UTC") : null);
  const usage = `${site()}/usage`;
  const sign = "\n\n— Orbis";
  switch (kind) {
    case "signup_welcome":
      return signupWelcome(data.name);
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

/** What a new account can do first, and where. Shared by the text and HTML versions of the welcome email. */
const START_HERE: { title: string; text: string; path: string }[] = [
  { title: "Chat", text: "Ask, research and write with leading AI models in one place.", path: "/chat" },
  { title: "Code", text: "Describe a website or app and the coding agent builds it. Publish it to a live address when it's ready.", path: "/code" },
  { title: "Jarvis", text: "A voice-first assistant that plans and carries out tasks, and with the Desktop Agent can open apps and files on your computer.", path: "/jarvis" },
  { title: "Agents", text: "Specialists for deep research, code review and security checks.", path: "/agents" },
];

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The welcome email for a new account: plain text plus a simple, table-based HTML version that mail apps render reliably. */
function signupWelcome(rawName: string | null | undefined): CustomerEmail {
  // A name is shown only if it looks like a name (no addresses or links someone typed into the sign-up form).
  const name = rawName?.trim().replace(/\s+/g, " ").slice(0, 40) ?? "";
  const first = name && !/[@/:<>]|www\./i.test(name) ? name.split(" ")[0]! : "";
  const hi = first ? `Hi ${first},` : "Hi,";
  const home = `${site()}/home`;
  const usage = `${site()}/usage`;
  const text = [
    hi,
    "",
    "Welcome to Orbis. Your account is ready.",
    "",
    "Where to start:",
    ...START_HERE.map((x) => `- ${x.title}: ${x.text} ${site()}${x.path}`),
    "",
    `Your free plan includes a weekly allowance. See what's left at any time: ${usage}`,
    "",
    `Open Orbis: ${home}`,
    "",
    "— Orbis",
    "",
    "You're getting this one-time email because you created an Orbis account.",
  ].join("\n");

  const ink = "#141416";
  const muted = "#56555c";
  const faint = "#85848b";
  const accent = "#5b54c4";
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
  const rows = START_HERE.map(
    (x) => `<tr><td style="padding:14px 0;border-top:1px solid #e8e7e3;">
      <a href="${site()}${x.path}" style="font:600 16px/1.4 ${font};color:${ink};text-decoration:none;">${x.title} <span style="color:${accent};">&rarr;</span></a>
      <div style="font:400 14px/1.55 ${font};color:${muted};padding-top:3px;">${escapeHtml(x.text)}</div>
    </td></tr>`,
  ).join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><title>Welcome to Orbis</title></head>
<body style="margin:0;padding:0;background:#f2f1ee;">
<div style="display:none;max-height:0;overflow:hidden;">Your account is ready. Here's where to start.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f1ee;"><tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:18px;border:1px solid #e3e2de;">
    <tr><td style="padding:32px 32px 8px;">
      <div style="font:600 13px/1 ${font};letter-spacing:0.14em;text-transform:uppercase;color:${accent};">Orbis</div>
      <h1 style="margin:18px 0 0;font:600 26px/1.25 ${font};color:${ink};">${first ? `Welcome to Orbis, ${escapeHtml(first)}` : "Welcome to Orbis"}</h1>
      <p style="margin:12px 0 0;font:400 16px/1.6 ${font};color:${muted};">Your account is ready. Here's where to start.</p>
    </td></tr>
    <tr><td style="padding:12px 32px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table></td></tr>
    <tr><td style="padding:18px 32px 0;">
      <p style="margin:0;font:400 14px/1.6 ${font};color:${muted};">Your free plan includes a weekly allowance. <a href="${usage}" style="color:${accent};">See what's left</a> at any time.</p>
    </td></tr>
    <tr><td style="padding:24px 32px 32px;">
      <a href="${home}" style="display:inline-block;background:${ink};color:#ffffff;font:600 15px/1 ${font};text-decoration:none;padding:14px 22px;border-radius:12px;">Open Orbis</a>
    </td></tr>
  </table>
  <p style="max-width:560px;margin:16px auto 0;font:400 12px/1.5 ${font};color:${faint};">You're getting this one-time email because you created an Orbis account.</p>
</td></tr></table>
</body></html>`;
  return { subject: "Welcome to Orbis", text, html };
}

/** New accounts only: one created in the last week counts as new, so older accounts signing in never get a welcome. */
export const WELCOME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Welcome a new account, once ever. Called when sign-up completes: after the email-confirmation or Google/GitHub
 * callback, and from the sign-up form when no confirmation is needed. Never throws.
 */
export async function sendSignupWelcome(userId: string, now = Date.now()): Promise<boolean> {
  try {
    if (!emailConfigured()) return false;
    const db = serviceSupabase();
    if (!db) return false;
    const { data: u } = await db.auth.admin.getUserById(userId);
    const user = u?.user;
    if (!user?.email || !user.created_at || now - Date.parse(user.created_at) > WELCOME_WINDOW_MS) return false;
    if (!(await claimNotification(userId, "signup_welcome", "once"))) return false;
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const name = [meta.display_name, meta.full_name, meta.name].find((v): v is string => typeof v === "string" && v.trim().length > 0) ?? null;
    const { subject, text, html } = customerEmail("signup_welcome", { name });
    await sendEmailTo(user.email, subject, text, html);
    await db.from("notifications").update({ sent: true }).eq("user_id", userId).eq("kind", "signup_welcome").eq("period_key", "once");
    return true;
  } catch (err) {
    console.error("[orbis] welcome email failed", safeMessage(err));
    return false;
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
    const { subject, text, html } = customerEmail(kind, data);
    await sendEmailTo(to, subject, text, html);
    await db.from("notifications").update({ sent: true }).eq("user_id", userId).eq("kind", kind).eq("period_key", periodKey.slice(0, 80));
    return true;
  } catch (err) {
    console.error("[orbis] customer email failed", kind, safeMessage(err));
    return false;
  }
}

export async function sendEmailTo(to: string, subject: string, text: string, html?: string): Promise<void> {
  const from = process.env.EMAIL_FROM?.trim() || process.env.ALERT_FROM?.trim() || "Orbis <onboarding@resend.dev>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, text, ...(html ? { html } : {}) }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Resend answered ${res.status}`);
}

/** A security notice from Orbis Bastion, at most once per (user, kind, key). Never throws. */
export async function sendSecurityEmail(userId: string, kind: string, periodKey: string, subject: string, text: string, footer?: string): Promise<boolean> {
  try {
    if (!emailConfigured()) return false;
    const db = serviceSupabase();
    if (!db) return false;
    if (!(await claimNotification(userId, kind.slice(0, 60), periodKey))) return false;
    const { data: u } = await db.auth.admin.getUserById(userId);
    const to = u?.user?.email;
    if (!to) return false;
    await sendEmailTo(to, subject, footer !== undefined ? `${text}${footer}\n\n— Orbis` : `${text}\n\nDetected by Orbis Bastion — this is a signal to review, not a confirmed incident. Details: ${site()}/agents/security/bastion\n\nTurn these emails off in Bastion → Policies → Notifications.\n\n— Orbis`);
    await db.from("notifications").update({ sent: true }).eq("user_id", userId).eq("kind", kind.slice(0, 60)).eq("period_key", periodKey.slice(0, 80));
    return true;
  } catch (err) {
    console.error("[orbis] security email failed", kind, safeMessage(err));
    return false;
  }
}
