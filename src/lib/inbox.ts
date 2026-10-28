import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthContext } from "./auth";
import { sendCustomerEmail } from "./email";
import { reportError } from "./observability";

type Authed = Extract<AuthContext, { mode: "authenticated" }>;

export type InboxKind = "task_done" | "task_failed" | "task_waiting";

export interface InboxItem {
  id: number;
  kind: InboxKind;
  title: string;
  body: string | null;
  href: string | null;
  createdAt: string;
  read: boolean;
}

/**
 * Set while the background worker drives a task (nobody has its page open): updates that happen then are also
 * emailed, because nobody is watching. Updates while the page is open only go to the inbox.
 */
const background = new AsyncLocalStorage<true>();
export const inBackground = <T>(fn: () => Promise<T>): Promise<T> => background.run(true, fn);
export const runningInBackground = (): boolean => background.getStore() === true;

/** Only links inside Orbis (a path), never another site. */
export const safeHref = (href: string | null | undefined): string | null => (href && /^\/[A-Za-z0-9]/.test(href) && !href.includes("//") && href.length <= 300 ? href : null);

/** Whether the user wants task emails (Settings → Notifications; on unless turned off). */
async function wantsEmail(auth: Authed): Promise<boolean> {
  const { data } = await auth.supabase.from("profiles").select("preferences").eq("id", auth.user.id).maybeSingle();
  return (data?.preferences as { notifyEmail?: unknown } | null)?.notifyEmail !== false;
}

/**
 * Tell the user about a task: one inbox entry per `key` (a repeat is ignored), and an email too when it happened in
 * the background. Never throws: a task never fails because its notice couldn't be written.
 */
export async function notifyUser(auth: Authed, n: { kind: InboxKind; key: string; title: string; body?: string | null; href?: string | null }): Promise<void> {
  try {
    const title = n.title.replace(/\s+/g, " ").trim().slice(0, 200) || "Your task";
    const body = n.body ? n.body.replace(/\s+/g, " ").trim().slice(0, 600) : null;
    const href = safeHref(n.href);
    const key = n.key.slice(0, 120);
    const { data, error } = await auth.supabase
      .from("user_notifications")
      .upsert({ user_id: auth.user.id, kind: n.kind, dedupe_key: key, title, body, href }, { onConflict: "user_id,dedupe_key", ignoreDuplicates: true })
      .select("id");
    if (error) {
      reportError(error, { where: "inbox.notify" });
      return;
    }
    // A repeat (already recorded) isn't emailed again either.
    if (!data?.length || !runningInBackground() || !(await wantsEmail(auth))) return;
    await sendCustomerEmail(auth.user.id, n.kind, key, { task: title, detail: body, path: href ?? "/activity" });
  } catch (err) {
    reportError(err, { where: "inbox.notify" });
  }
}

/** The user's latest updates and how many are unread. */
export async function listInbox(auth: Authed, limit = 30): Promise<{ items: InboxItem[]; unread: number }> {
  const [list, unread] = await Promise.all([
    auth.supabase.from("user_notifications").select("id, kind, title, body, href, created_at, read_at").order("created_at", { ascending: false }).limit(limit),
    auth.supabase.from("user_notifications").select("id", { count: "exact", head: true }).is("read_at", null),
  ]);
  if (list.error) throw list.error;
  type Row = { id: number; kind: InboxKind; title: string; body: string | null; href: string | null; created_at: string; read_at: string | null };
  return {
    items: ((list.data ?? []) as Row[]).map((r) => ({ id: Number(r.id), kind: r.kind, title: r.title, body: r.body, href: safeHref(r.href), createdAt: r.created_at, read: !!r.read_at })),
    unread: unread.count ?? 0,
  };
}

/** Mark updates read: the given ones, or all of them. */
export async function markInboxRead(auth: Authed, ids: number[] | "all"): Promise<void> {
  let q = auth.supabase.from("user_notifications").update({ read_at: new Date().toISOString() }).is("read_at", null);
  if (ids !== "all") q = q.in("id", ids);
  const { error } = await q;
  if (error) throw error;
}

/** How many tasks wait for the user right now (coding tasks and workflows asking for an answer or an approval). */
export async function waitingCount(auth: Authed): Promise<number> {
  const [runs, flows] = await Promise.all([
    auth.supabase.from("code_agent_runs").select("id", { count: "exact", head: true }).in("status", ["awaiting_approval", "needs_input"]),
    auth.supabase.from("agent_workflows").select("id", { count: "exact", head: true }).in("status", ["needs_approval", "waiting"]),
  ]);
  if (runs.error) reportError(runs.error, { where: "inbox.waiting" });
  // Workflows may not exist on every deployment yet; a missing table counts as none.
  return (runs.count ?? 0) + (flows.error ? 0 : (flows.count ?? 0));
}
