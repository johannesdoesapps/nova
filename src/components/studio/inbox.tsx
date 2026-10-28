"use client";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Bell, CheckCircle2, CircleAlert, Hand } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import { ago } from "@/lib/home";
import type { InboxItem } from "@/lib/inbox";
import { cn } from "@/lib/utils";
import { Switch } from "./ui";

/**
 * The user's inbox, read by one shared poller for the whole tab: the sidebar's badge and the Activity page show the
 * same numbers. Once a minute while the tab is visible (every two when it isn't, and straight away when it comes
 * back). With browser alerts on, an update that arrives while the tab is in the background shows a system notice.
 */
export interface InboxState {
  items: InboxItem[];
  unread: number;
  /** Tasks waiting for the user now. */
  waiting: number;
}

let state: InboxState | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
/** Updates marked read while on the Activity page: still shown as new there until the page is left. */
const seenThisVisit = new Set<number>();
/** The newest update already seen in this tab; null until the first read (which never alerts). */
let newestSeen: number | null = null;

const ALERTS_KEY = "orbis.inbox.alerts";
export function alertsWanted(): boolean {
  try {
    return localStorage.getItem(ALERTS_KEY) === "1" && typeof Notification !== "undefined" && Notification.permission === "granted";
  } catch {
    return false;
  }
}

/** This browser's alerts: "on", "off", or "blocked" (no support, or the user blocked Orbis). Read as a store. */
type AlertsState = "on" | "off" | "blocked";
const alertListeners = new Set<() => void>();
const readAlerts = (): AlertsState => (typeof Notification === "undefined" || Notification.permission === "denied" ? "blocked" : alertsWanted() ? "on" : "off");
const subscribeAlerts = (l: () => void) => {
  alertListeners.add(l);
  return () => alertListeners.delete(l);
};
const useAlerts = () => useSyncExternalStore(subscribeAlerts, readAlerts, () => "off" as AlertsState);

function setAlertsWanted(on: boolean) {
  try {
    localStorage.setItem(ALERTS_KEY, on ? "1" : "0");
  } catch {
    /* not remembered */
  }
  alertListeners.forEach((l) => l());
}

function emit() {
  listeners.forEach((l) => l());
}

/** The updates newer than `seen` (for alerts). Pure; exported for tests. */
export function freshUpdates(items: InboxItem[], seen: number | null): InboxItem[] {
  if (seen === null) return [];
  return items.filter((i) => i.id > seen && !i.read);
}

async function poll() {
  try {
    const res = await fetch("/api/inbox", { cache: "no-store" });
    if (!res.ok) return;
    const next = (await res.json()) as InboxState;
    const fresh = freshUpdates(next.items, newestSeen);
    newestSeen = Math.max(newestSeen ?? 0, ...next.items.map((i) => i.id));
    state = next;
    emit();
    if (fresh.length && document.visibilityState === "hidden" && alertsWanted()) {
      for (const u of fresh.slice(0, 3)) {
        const n = new Notification(u.title, { body: u.body ?? undefined, tag: `orbis-${u.id}` });
        n.onclick = () => {
          window.focus();
          if (u.href) window.location.assign(u.href);
          n.close();
        };
      }
    }
  } catch {
    /* offline or signed out: try again on the next tick */
  }
}

function schedule() {
  timer = setTimeout(
    () => {
      void poll().finally(schedule);
    },
    document.visibilityState === "hidden" ? 120_000 : 60_000,
  );
}

function onVisible() {
  if (document.visibilityState !== "visible" || !timer) return;
  clearTimeout(timer);
  void poll().finally(schedule);
}

function subscribe(l: () => void) {
  listeners.add(l);
  if (listeners.size === 1) {
    void poll().finally(schedule);
    document.addEventListener("visibilitychange", onVisible);
  }
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      if (timer) clearTimeout(timer);
      timer = null;
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}
const noSubscribe = () => () => {};

/** The inbox for signed-in users (null until read, and always for guests). */
export function useInbox(signedIn: boolean): InboxState | null {
  return useSyncExternalStore(signedIn ? subscribe : noSubscribe, () => (signedIn ? state : null), () => null);
}

/** Read the inbox again now (after marking updates read, say). */
export const refreshInbox = () => poll();

async function markRead(ids: number[] | "all") {
  if (state) {
    state = { ...state, unread: ids === "all" ? 0 : Math.max(0, state.unread - ids.length), items: state.items.map((i) => (ids === "all" || ids.includes(i.id) ? { ...i, read: true } : i)) };
    emit();
  }
  await jsonFetch("/api/inbox", { method: "POST", body: JSON.stringify({ ids }) }).catch(() => refreshInbox());
}

const ICON = { task_done: CheckCircle2, task_failed: CircleAlert, task_waiting: Hand } as const;

/**
 * Updates on the Activity page: what happened while nobody had the task's page open. With `markSeen`, they're marked
 * read after a few seconds on the page (the badge clears), and stay highlighted as new for the rest of the visit.
 */
export function InboxUpdates({ signedIn, markSeen = false }: { signedIn: boolean; markSeen?: boolean }) {
  const inbox = useInbox(signedIn);
  const unread = inbox?.unread ?? 0;
  useEffect(() => {
    if (!markSeen || unread === 0) return;
    const t = setTimeout(() => {
      for (const i of state?.items ?? []) if (!i.read) seenThisVisit.add(i.id);
      void markRead("all");
    }, 3_000);
    return () => clearTimeout(t);
  }, [markSeen, unread]);
  useEffect(() => () => seenThisVisit.clear(), []);
  if (!inbox || inbox.items.length === 0) return null;
  const isNew = (u: InboxItem) => !u.read || seenThisVisit.has(u.id);
  const newCount = inbox.items.filter(isNew).length;
  return (
    <section aria-labelledby="inbox-updates" className="glass mt-4 rounded-[18px] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="inbox-updates" className="text-[14px] font-semibold">
          Updates
        </h2>
        {newCount > 0 && <span className="rounded-full bg-s-accent/15 px-2 text-[11.5px] font-medium text-s-accent">{newCount} new</span>}
        <div className="ml-auto flex items-center gap-3">
          <BrowserAlertsButton />
          {inbox.unread > 0 && (
            <button type="button" onClick={() => void markRead("all")} className="text-[12.5px] text-s-ink-2 underline-offset-2 hover:text-s-ink hover:underline">
              Mark all read
            </button>
          )}
        </div>
      </div>
      <p className="mt-1 text-[12.5px] text-s-ink-3">Tasks that finished, stopped or need you while their page was closed.</p>
      <ul className="mt-3 space-y-1">
        {inbox.items.slice(0, 10).map((u) => {
          const Icon = ICON[u.kind];
          const body = (
            <>
              <Icon aria-hidden className={cn("mt-0.5 h-4 w-4 shrink-0", u.kind === "task_failed" ? "text-s-danger" : u.kind === "task_waiting" ? "text-amber-600 dark:text-amber-300" : "text-s-accent")} />
              <span className="min-w-0 flex-1">
                <span className={cn("block truncate text-[13.5px]", isNew(u) && "font-medium")}>
                  {u.kind === "task_done" ? "Done: " : u.kind === "task_failed" ? "Stopped: " : "Needs you: "}
                  {u.title}
                </span>
                {u.body && <span className="block truncate text-[12.5px] text-s-ink-3">{u.body}</span>}
              </span>
              <span className="shrink-0 text-[11.5px] text-s-ink-3">{ago(u.createdAt)}</span>
              {isNew(u) && <span aria-label="New" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-s-accent" />}
            </>
          );
          const cls = "flex items-start gap-2.5 rounded-xl px-2 py-2 transition hover:bg-s-hover";
          return (
            <li key={u.id}>
              {u.href ? (
                <Link href={u.href} className={cls} onClick={() => !u.read && void markRead([u.id])}>
                  {body}
                </Link>
              ) : (
                <div className={cls}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Turn system notices on for this browser (asks the browser's permission once). */
function BrowserAlertsButton() {
  const alerts = useAlerts();
  if (alerts !== "off") return null;
  return (
    <button
      type="button"
      onClick={() => void enableAlerts()}
      className="inline-flex items-center gap-1.5 text-[12.5px] text-s-ink-2 underline-offset-2 hover:text-s-ink hover:underline"
    >
      <Bell className="h-3.5 w-3.5" aria-hidden /> Alert me in this browser
    </button>
  );
}

async function enableAlerts(): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  setAlertsWanted(p === "granted");
  return p === "granted";
}

/** Settings → Notifications: task emails (saved with the account) and browser alerts (this browser). */
export function NotificationSettings() {
  const [email, setEmail] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alerts = useAlerts();
  useEffect(() => {
    jsonFetch<{ email: boolean }>("/api/inbox/settings")
      .then((r) => setEmail(r.email))
      .catch((e: Error) => setError(e.message));
  }, []);
  return (
    <div className="space-y-2 text-[12.5px] text-s-ink-3">
      {error ? (
        <p className="text-s-danger">{error}</p>
      ) : (
        email !== null && (
          <span className="flex items-center gap-2">
            <Switch
              checked={email}
              label="Email me about tasks"
              onChange={async (v) => {
                setEmail(v);
                try {
                  await jsonFetch("/api/inbox/settings", { method: "PATCH", body: JSON.stringify({ email: v }) });
                } catch (e) {
                  setEmail(!v);
                  setError((e as Error).message);
                }
              }}
            />
            <span>{email ? "Email when a background task finishes or needs you" : "No task emails"}</span>
          </span>
        )
      )}
      <span className="flex items-center gap-2">
        <Switch checked={alerts === "on"} disabled={alerts === "blocked"} label="Alerts in this browser" onChange={(v) => (v ? void enableAlerts() : setAlertsWanted(false))} />
        <span>{alerts === "blocked" ? "This browser blocks alerts from Orbis (change it in the site settings)" : alerts === "on" ? "Alerts on while an Orbis tab is open" : "No browser alerts"}</span>
      </span>
    </div>
  );
}
