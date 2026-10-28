import "server-only";
import { inBackground, notifyUser } from "@/lib/inbox";
import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";
import { displayNameFrom } from "../../auth-flow";
import { publicEnv } from "../../env";
import { reportError } from "../../observability";
import { serviceSupabase } from "../../supabase/admin";
import type { ServerSupabase } from "../../supabase/server";
import type { Authed } from "../server";
import { stepRun } from "./engine";
import { addEvents } from "./runs";
import { WORKING_STATUSES, type RunStatus } from "./types";

/**
 * Keep a coding task going after its page is closed.
 *
 * A step request from the page ends by asking the worker (POST /api/code/agent/worker, secret-protected) to look at
 * the run a little later. If the page has taken the next step meanwhile, the worker leaves it to the page. If not,
 * it opens a session for the run's owner and takes steps for up to a few minutes, then hands over to a fresh worker
 * call, until the run ends or waits for the user (a question, an approval, a limit).
 *
 * The worker acts as the user, not as an administrator: the admin key is used only to open a short-lived session
 * for the run's owner (a magic-link token redeemed on the server; no email is sent), so every query still goes
 * through row-level security and every model call through the user's own plan limits and metering. That session is
 * signed out when the worker stops. Only runs started with "keep working" (options.background) are touched.
 */

/** How long the worker waits for the page to take the next step before it takes it itself. */
export const QUIET_MS = 8_000;
/** Steps one worker call may take (the route stops at 300 s; the last step must finish inside it). */
export const WORKER_STEP_MS = 230_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether a request carries the worker secret (CRON_SECRET), compared in constant time. */
export function workerAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  const given = req.headers.get("authorization") ?? "";
  if (!secret) return false;
  const want = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(given);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Background runs need the admin key (to open the owner's session) and the worker secret. */
export const backgroundAvailable = () => !!serviceSupabase() && !!process.env.CRON_SECRET?.trim() && !!publicEnv.supabaseUrl && !!publicEnv.supabaseKey;

/** Ask the worker to look after a run. Waits only for the worker to accept (it answers at once, then works). */
export async function kickWorker(runId: string, origin: string): Promise<void> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || !backgroundAvailable()) return;
  try {
    const res = await fetch(new URL("/api/code/agent/worker", origin), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: JSON.stringify({ runId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 202) reportError(new Error(`The background worker answered ${res.status}`), { where: "code.agent.background.kick" });
  } catch (err) {
    reportError(err, { where: "code.agent.background.kick" });
  }
}

/**
 * A session for the run's owner, opened on the server: their row-level security and metering apply to everything
 * done with it. `end` signs that session out (only it; the user's own sessions are untouched).
 */
export async function ownerSession(userId: string): Promise<{ auth: Authed; end: () => Promise<void> } | null> {
  const admin = serviceSupabase();
  if (!admin || !publicEnv.supabaseUrl || !publicEnv.supabaseKey) return null;
  const { data: found, error: userError } = await admin.auth.admin.getUserById(userId);
  const email = found?.user?.email;
  if (userError || !email) return null;
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link?.properties?.hashed_token;
  if (linkError || !tokenHash) {
    if (linkError) reportError(linkError, { where: "code.agent.background.link" });
    return null;
  }
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
  const anon = createClient(publicEnv.supabaseUrl, publicEnv.supabaseKey, options);
  const { data: verified, error: verifyError } = await anon.auth.verifyOtp({ type: "email", token_hash: tokenHash });
  const session = verified?.session;
  if (verifyError || !session || verified.user?.id !== userId) {
    if (verifyError) reportError(verifyError, { where: "code.agent.background.session" });
    return null;
  }
  const supabase = createClient(publicEnv.supabaseUrl, publicEnv.supabaseKey, { ...options, global: { headers: { Authorization: `Bearer ${session.access_token}` } } });
  const user = found.user!;
  return {
    auth: {
      mode: "authenticated",
      // The same queries as a request's client; this one carries the owner's access token instead of cookies.
      supabase: supabase as unknown as ServerSupabase,
      user: { id: user.id, email: user.email ?? null, displayName: displayNameFrom((user.user_metadata ?? {}) as Record<string, unknown>) },
    },
    end: async () => {
      await admin.auth.admin.signOut(session.access_token, "local").catch(() => {});
    },
  };
}

type RunGlance = {
  id: string;
  user_id: string;
  status: RunStatus;
  options: { background?: boolean } | null;
  locked_until: string | null;
  updated_at: string;
  steps: number;
  pending: unknown;
  checks: { verify?: { queue?: unknown[]; attempts?: number } | null } | null;
  usage: { modelFailuresInRow?: number } | null;
  request?: string;
  project_id?: string;
};

/** How far the run's verification has got (checks left, tries of the current one): it moves without taking steps. */
const verifyMark = (r: RunGlance | null) => JSON.stringify([r?.checks?.verify?.queue?.length ?? null, r?.checks?.verify?.attempts ?? null]);

async function glance(runId: string): Promise<RunGlance | null> {
  const admin = serviceSupabase();
  if (!admin) return null;
  const { data } = await admin.from("code_agent_runs").select("id, user_id, status, options, locked_until, updated_at, steps, pending, checks, usage, request, project_id").eq("id", runId).maybeSingle();
  return (data as RunGlance | null) ?? null;
}

/** Whether the worker should take the run's next step now. */
export function needsWorker(r: RunGlance | null, now = Date.now()): r is RunGlance {
  if (!r || !r.options?.background || !WORKING_STATUSES.includes(r.status) || r.pending) return false;
  // Someone (the page, or another worker) is taking a step, or did very recently: they hand over when they finish.
  if (r.locked_until && Date.parse(r.locked_until) > now) return false;
  return now - Date.parse(r.updated_at) >= QUIET_MS - 1_000;
}

/** Still a background run that's working with nothing to wait for (a worker may pick it up after the pause). */
function needsWorkerSoon(r: RunGlance | null): boolean {
  return !!r && !!r.options?.background && WORKING_STATUSES.includes(r.status) && !r.pending;
}

/** The worker's job for one call: wait for the page, then take steps as the owner, then hand over if work is left. */
export async function driveInBackground(runId: string, origin: string, opts: { wait?: number } = {}): Promise<"page" | "done" | "handed_over" | "unavailable" | "error"> {
  await sleep(opts.wait ?? QUIET_MS);
  const before = await glance(runId);
  if (!needsWorker(before)) return "page";
  const owner = await ownerSession(before.user_id);
  if (!owner) return "unavailable";
  let progressed = false;
  try {
    const req = new Request(new URL(`/api/code/agent/${runId}/step`, origin), { method: "POST", headers: { "x-orbis-background": "1" } });
    // Updates while nobody's watching also go to the user's inbox and email (lib/inbox.ts).
    const r = await inBackground(() => stepRun(req, owner.auth, runId, { expectStep: before.steps, keepGoingMs: WORKER_STEP_MS }));
    progressed = !r.skipped && r.run.steps > before.steps;
  } catch (err) {
    // The model failed (busy or unreachable provider): the engine counted it and logged it. Try again from a fresh
    // worker after the usual pause; after MAX_MODEL_FAILURES in a row the engine fails the run, so this ends.
    const now = await glance(runId).catch(() => null);
    if ((now?.usage?.modelFailuresInRow ?? 0) > (before.usage?.modelFailuresInRow ?? 0) && needsWorkerSoon(now)) {
      await kickWorker(runId, origin);
      return "handed_over";
    }
    // Anything else (a plan limit, say) is added to the activity log, and the run waits for the user rather than
    // retrying in a loop.
    reportError(err, { where: "code.agent.background.step" });
    const message = err instanceof Error ? err.message : "a step failed";
    await addEvents(owner.auth, runId, [{ kind: "status", title: `Stopped working in the background: ${message}`.slice(0, 380) }]).catch(() => {});
    // It won't go on until the user looks at it: tell them.
    if (now?.request && now.project_id) await inBackground(() => notifyUser(owner.auth, { kind: "task_waiting", key: `code_run:${runId}:stopped:${before.steps}`, title: now.request!.slice(0, 100), body: `Stopped working in the background: ${message}`, href: `/code/${now.project_id}?run=${runId}` }));
    return "error";
  } finally {
    await owner.end();
  }
  const after = await glance(runId);
  // Verification checks don't count as steps; a call that moved verification on also made progress (bounded: each
  // check is tried a few times at most).
  if (!progressed && after && after.steps === before.steps && verifyMark(after) !== verifyMark(before)) progressed = true;
  if (progressed && after?.options?.background && WORKING_STATUSES.includes(after.status) && !after.pending) {
    await kickWorker(runId, origin);
    return "handed_over";
  }
  return "done";
}
