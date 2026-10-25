import { NextResponse } from "next/server";
import { z } from "zod";
import { commandOp } from "@/lib/bastion/guards";
import { enforce } from "@/lib/bastion/server";
import { codeContext, getProjectRow, requireBox, syncBack } from "@/lib/code/server";
import { PREVIEW_JOB, stopPreview } from "@/lib/code/preview";
import { claimSync, killJob, readJob, startJob } from "@/lib/code/workspace";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { reportError } from "@/lib/observability";

export const maxDuration = 60;

type Ctx = RouteContext<"/api/code/projects/[id]/exec">;
const JOB = /^[a-z0-9]{6,32}$/;

const body = z.object({ command: z.string().trim().min(1).max(2_000), preview: z.boolean().optional() });

/**
 * POST /api/code/projects/[id]/exec — run a terminal command in the project's computer, in the background.
 * With `preview`, it's the project's server: it replaces the running preview (the one the agent uses too).
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const { command, preview } = await parseJsonBody(req, body, 4_000);
    const auth = await codeContext("code-exec", 30);
    await getProjectRow(auth, id);
    // Orbis Bastion: the user typed this in their own terminal (that's the approval); lockdown and an
    // administrator switching commands off still apply.
    await enforce({ db: auth.supabase, userId: auth.user.id, kind: "user", agent: "terminal" }, preview ? "preview.start" : commandOp(command), command, { approved: true });
    const { box } = await requireBox(auth, id);
    if (preview) {
      await stopPreview(box);
      await startJob(box, PREVIEW_JOB, command);
      return NextResponse.json({ jobId: PREVIEW_JOB });
    }
    const jobId = `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await startJob(box, jobId, command);
    return NextResponse.json({ jobId });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * GET /api/code/projects/[id]/exec?job=…&offset=… — the command's output from
 * a byte offset and whether it has finished. When it has, the files it
 * created, changed or deleted are copied back to the project (once).
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const url = new URL(req.url);
    const job = url.searchParams.get("job") ?? "";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (!JOB.test(job) || !Number.isFinite(offset) || offset < 0) throw new ApiError("bad_request", "Unknown command.");
    const auth = await codeContext("code-poll", 240);
    const { box } = await requireBox(auth, id);
    const read = await readJob(box, job, offset);
    let sync = null;
    if (read.done && (await claimSync(box, job))) {
      try {
        sync = await syncBack(auth, id, box, read.startedAt, job);
      } catch (err) {
        reportError(err, { where: "code.exec.sync" });
        sync = { changed: [], deleted: [], skipped: [], error: "Files changed by this command couldn't be copied back to your project." };
      }
    }
    return NextResponse.json({ ...read, sync });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/code/projects/[id]/exec?job=… — stop a running command and everything it started. */
export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const job = new URL(req.url).searchParams.get("job") ?? "";
    if (!JOB.test(job)) throw new ApiError("bad_request", "Unknown command.");
    const auth = await codeContext("code-exec", 30);
    const { box } = await requireBox(auth, id);
    await killJob(box, job);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
