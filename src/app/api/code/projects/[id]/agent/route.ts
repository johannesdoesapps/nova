import { NextResponse } from "next/server";
import { MAX_ATTACHMENTS } from "@/lib/code/attachments";
import { linkAttachments, pendingAttachments } from "@/lib/code/attachments-store";
import { z } from "zod";
import { isWebTask } from "@/lib/code/agent/protocol";
import { changeCounts, createRun, listRuns, openRun, toRunView } from "@/lib/code/agent/runs";
import { DEFAULT_STEP_LIMIT, MAX_STEP_LIMIT } from "@/lib/code/agent/types";
import { codeContext, getFiles, getProjectRow } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

type Ctx = RouteContext<"/api/code/projects/[id]/agent">;

/** GET /api/code/projects/[id]/agent — the project's agent runs (newest first), with how many files each changed. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("code-agent-read", 240);
    await getProjectRow(auth, id);
    const runs = await listRuns(auth, id);
    const counts = await changeCounts(auth, runs.map((r) => r.id));
    return NextResponse.json({ runs: runs.map((r) => ({ ...r, changedFiles: counts[r.id] ?? 0 })) });
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.object({
  request: z.string().trim().min(1).max(8_000),
  options: z
    .object({
      modelId: z.string().max(120).nullable().optional(),
      approvePlans: z.boolean().optional(),
      reviewEdits: z.boolean().optional(),
      commands: z.enum(["safe", "ask", "off"]).optional(),
      readOnly: z.boolean().optional(),
    })
    .optional(),
  stepLimit: z.number().int().min(3).max(MAX_STEP_LIMIT).optional(),
  /** Files and images uploaded for this task (POST …/attachments first). */
  attachments: z.array(z.string().uuid()).max(MAX_ATTACHMENTS).optional(),
});

/**
 * POST /api/code/projects/[id]/agent — start an agent run on the project.
 * Nothing happens until the page asks for the first step; one open run per project.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const input = await parseJsonBody(req, body, 20_000);
    const auth = await codeContext("code-agent", 20);
    const project = await getProjectRow(auth, id);
    const open = await openRun(auth, id);
    if (open) throw new ApiError("conflict", "The agent is already working on this project. Stop that run or let it finish first.", { runId: open.id });
    const o = input.options ?? {};
    // A website task gets the website guidance and the preview tools' instructions for the whole run.
    const web = isWebTask(input.request, await getFiles(auth, id), project.template);
    // Every attachment must be the user's, on this project and unused, before anything starts.
    const pending = input.attachments?.length ? await pendingAttachments(auth, id, input.attachments) : [];
    const attachments = pending.length ? { texts: pending.filter((a) => a.kind === "text").length, images: pending.filter((a) => a.kind === "image").length } : undefined;
    const row = await createRun(auth, {
      projectId: id,
      request: input.request,
      // A read-only run never plans, edits or runs anything, so its other switches are fixed.
      options: o.readOnly
        ? { modelId: o.modelId ?? null, approvePlans: false, reviewEdits: false, commands: "off", readOnly: true, web, attachments }
        : { modelId: o.modelId ?? null, approvePlans: o.approvePlans ?? true, reviewEdits: o.reviewEdits ?? false, commands: o.commands ?? "safe", readOnly: false, web, attachments },
      stepLimit: input.stepLimit ?? DEFAULT_STEP_LIMIT,
    });
    const linked = pending.length ? await linkAttachments(auth, id, row.id, pending.map((a) => a.id)) : [];
    return NextResponse.json({ run: toRunView(row), attachments: linked }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
