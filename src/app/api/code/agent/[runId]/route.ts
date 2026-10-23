import { NextResponse } from "next/server";
import { getRunForView, getRunVersion, listChanges, listEvents, runOptions, toRunView } from "@/lib/code/agent/runs";
import { runAttachments } from "@/lib/code/attachments-store";
import { codeContext } from "@/lib/code/server";
import { ApiError, errorResponse, requireUuid } from "@/lib/http";

/**
 * GET /api/code/agent/[runId]?after=seq&known=version&changes=1 — the run, its activity after an event number,
 * and (first read) its attachments. The page polls this while a run works, so it stays small:
 * - `known`: the run's version the page already has; when it hasn't changed, only `{ unchanged, busy,
 *   stepStartedAt }` and any new activity come back, not the whole run.
 * - `changes=1`: also the files the run changed, with their contents (the Changes panel asks; polling doesn't).
 */
export async function GET(req: Request, ctx: RouteContext<"/api/code/agent/[runId]">) {
  try {
    const runId = requireUuid((await ctx.params).runId);
    const sp = new URL(req.url).searchParams;
    const after = Math.max(0, Number(sp.get("after") ?? 0) || 0);
    const known = sp.get("known");
    const wantChanges = sp.get("changes") === "1";
    const auth = await codeContext("code-agent-read", 240);
    const changes = wantChanges ? listChanges(auth, runId) : Promise.resolve(undefined);
    if (known) {
      const v = await getRunVersion(auth, runId);
      if (!v) throw new ApiError("not_found", "Agent run not found.");
      if (v.version === known) {
        const [events, ch] = await Promise.all([listEvents(auth, runId, after), changes]);
        return NextResponse.json({ unchanged: true, busy: v.busy, stepStartedAt: v.stepStartedAt, events, ...(ch ? { changes: ch } : {}) });
      }
    }
    const row = await getRunForView(auth, runId);
    // Attachment names and sizes (never contents), on the first read only: they don't change.
    const withAttachments = after === 0 && !!runOptions(row).attachments;
    const [events, ch, attachments] = await Promise.all([listEvents(auth, runId, after), changes, withAttachments ? runAttachments(auth, runId) : Promise.resolve(undefined)]);
    return NextResponse.json({ run: toRunView(row), events, ...(ch ? { changes: ch } : {}), ...(attachments ? { attachments } : {}) });
  } catch (err) {
    return errorResponse(err);
  }
}
