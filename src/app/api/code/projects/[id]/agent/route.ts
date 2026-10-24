import { NextResponse } from "next/server";
import { MAX_ATTACHMENTS } from "@/lib/code/attachments";
import { linkAttachments, pendingAttachments } from "@/lib/code/attachments-store";
import { z } from "zod";
import { SITE_TEMPLATE_IDS } from "@/lib/code/site-templates";
import { isWebTask } from "@/lib/code/agent/protocol";
import { DEFAULT_ROUNDS, MAX_ROUNDS, newPairState, type PairSettings } from "@/lib/code/pair/protocol";
import { changeCounts, createRun, getRun, listRuns, openRun, toRunView } from "@/lib/code/agent/runs";
import { DEFAULT_STEP_LIMIT, ENDED_STATUSES, MAX_STEP_LIMIT } from "@/lib/code/agent/types";
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
      /** The website template the project was started from; only for a new website task. */
      siteTemplate: z.enum(SITE_TEMPLATE_IDS).optional(),
    })
    .optional(),
  stepLimit: z.number().int().min(3).max(MAX_STEP_LIMIT).optional(),
  /** Files and images uploaded for this task (POST …/attachments first). */
  attachments: z.array(z.string().uuid()).max(MAX_ATTACHMENTS).optional(),
  /** A finished task in this project to continue: the new task is given its record (nothing is replayed). */
  continueFrom: z.string().uuid().optional(),
  /** Pair coding: an Architect and a Reviewer, each with its own model, for up to maxRounds review rounds. */
  pair: z
    .object({
      architect: z.string().max(120).nullable().optional(),
      reviewer: z.string().max(120).nullable().optional(),
      maxRounds: z.number().int().min(1).max(MAX_ROUNDS).optional(),
      approvePlan: z.boolean().optional(),
      runTests: z.boolean().optional(),
    })
    .optional(),
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
    // The task to continue must be the user's (row-level security), in this project, and finished.
    if (input.continueFrom) {
      const prior = await getRun(auth, input.continueFrom);
      if (prior.project_id !== id) throw new ApiError("bad_request", "That task belongs to another project.");
      if (!ENDED_STATUSES.includes(prior.status)) throw new ApiError("conflict", "That task is still open: resume it instead.", { runId: prior.id });
    }
    const continueFrom = input.continueFrom ? { continueFrom: input.continueFrom } : {};
    const pair: PairSettings | undefined = input.pair
      ? {
          architect: input.pair.architect ?? null,
          reviewer: input.pair.reviewer ?? null,
          maxRounds: input.pair.maxRounds ?? DEFAULT_ROUNDS,
          approvePlan: input.pair.approvePlan ?? true,
          runTests: input.pair.runTests ?? true,
        }
      : undefined;
    const o = input.options ?? {};
    // A website task gets the website guidance and the preview tools' instructions for the whole run.
    const siteTemplate = o.siteTemplate && !o.readOnly && !pair ? { siteTemplate: o.siteTemplate } : {};
    const web = !!o.siteTemplate || isWebTask(input.request, await getFiles(auth, id), project.template);
    // Every attachment must be the user's, on this project and unused, before anything starts.
    const pending = input.attachments?.length ? await pendingAttachments(auth, id, input.attachments) : [];
    const attachments = pending.length ? { texts: pending.filter((a) => a.kind === "text").length, images: pending.filter((a) => a.kind === "image").length } : undefined;
    const row = await createRun(auth, {
      projectId: id,
      request: input.request,
      ...(pair ? { pair: newPairState(pair) } : {}),
      // A read-only run never plans, edits or runs anything, so its other switches are fixed.
      options: o.readOnly && !pair
        ? { modelId: o.modelId ?? null, approvePlans: false, reviewEdits: false, commands: "off", readOnly: true, web, attachments, ...continueFrom }
        : { modelId: o.modelId ?? null, approvePlans: o.approvePlans ?? true, reviewEdits: o.reviewEdits ?? false, commands: o.commands ?? "safe", readOnly: false, web, attachments, ...continueFrom, ...siteTemplate, ...(pair ? { pair, approvePlans: false } : {}) },
      // A pair task takes about three steps per review round (revise, test, review) plus planning and the summary.
      stepLimit: input.stepLimit ?? (pair ? Math.min(MAX_STEP_LIMIT, 8 + pair.maxRounds * 4) : DEFAULT_STEP_LIMIT),
    });
    const linked = pending.length ? await linkAttachments(auth, id, row.id, pending.map((a) => a.id)) : [];
    return NextResponse.json({ run: toRunView(row), attachments: linked }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
