import "server-only";
import { after } from "next/server";
import type { AuthContext } from "../auth";
import { reportError } from "../observability";
import { cleanProps, type EventName } from "./events";

type Authed = Extract<AuthContext, { mode: "authenticated" }>;

/** Whether the user lets Orbis record product events (on unless they turned it off in Settings). */
export function eventsAllowed(prefs: unknown): boolean {
  return (prefs as { productEvents?: unknown } | null)?.productEvents !== false;
}

async function record(auth: Authed, event: EventName, props: Record<string, unknown>) {
  try {
    const { data } = await auth.supabase.from("profiles").select("preferences").eq("id", auth.user.id).maybeSingle();
    if (!eventsAllowed(data?.preferences)) return;
    const { error } = await auth.supabase.from("product_events").insert({ user_id: auth.user.id, event, props: cleanProps(event, props) });
    if (error) throw new Error(error.message);
  } catch (err) {
    reportError(err, { where: "trackEvent", event });
  }
}

/**
 * Record a product event for a signed-in user, after the response, without
 * ever failing the request. Guests aren't tracked. Properties are filtered to
 * the event's short list (see events.ts); text people typed is never stored.
 */
export function trackEvent(auth: AuthContext | null | undefined, event: EventName, props: Record<string, unknown> = {}): void {
  if (!auth || auth.mode !== "authenticated") return;
  try {
    after(() => record(auth, event, props));
  } catch {
    void record(auth, event, props); // outside a request (tests, scripts)
  }
}
