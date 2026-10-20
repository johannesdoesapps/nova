import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext, dbError, getFiles, getProjectRow, liveSession, optionalBox, previewUrl, stopSession, toSummary } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";

type Ctx = RouteContext<"/api/code/projects/[id]">;

/** GET /api/code/projects/[id] — the project, its files and whether its workspace computer is running. */
export async function GET(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext();
    const project = await getProjectRow(auth, id);
    const [files, live] = await Promise.all([getFiles(auth, id), liveSession(auth, id)]);
    const box = live ? await optionalBox(auth, id) : null;
    return NextResponse.json({ project, files, session: live && box ? { ...live, previewUrl: previewUrl(box) } : null });
  } catch (err) {
    return errorResponse(err);
  }
}

const patch = z.object({ name: z.string().trim().min(1).max(80).optional(), runCommand: z.string().max(500).optional() });

/** PATCH /api/code/projects/[id] — rename, or change the Run command. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const body = await parseJsonBody(req, patch, 4_000);
    const auth = await codeContext();
    const update: Record<string, string> = {};
    if (body.name !== undefined) update.name = body.name;
    if (body.runCommand !== undefined) update.run_command = body.runCommand;
    const { data, error } = await auth.supabase.from("code_projects").update(update).eq("id", id).select("id, name, template, run_command, source_repo, updated_at").maybeSingle();
    if (error) throw dbError(error, "code.projects.patch");
    if (!data) throw new ApiError("not_found", "Project not found.");
    return NextResponse.json({ project: toSummary(data) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/code/projects/[id] — stop its computer and delete the project and its files. */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext();
    await getProjectRow(auth, id);
    await stopSession(auth, id);
    const { error } = await auth.supabase.from("code_projects").delete().eq("id", id);
    if (error) throw dbError(error, "code.projects.delete");
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
