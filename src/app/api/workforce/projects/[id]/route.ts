import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, parseJsonBody } from "@/lib/http";
import { validateChecks } from "@/lib/workforce/checks";
import { checkSchema, fetchPackageJson, requireOperator, wfError } from "@/lib/workforce/server";

const patch = z.object({ name: z.string().trim().min(1).max(120).optional(), notes: z.string().max(4000).nullable().optional(), checks: z.array(checkSchema).max(8).optional() });

/** PATCH /api/workforce/projects/[id] — rename, notes, or enable/require checks (validated against package.json). */
export async function PATCH(req: Request, ctx: RouteContext<"/api/workforce/projects/[id]">) {
  try {
    const { store } = await requireOperator();
    const { id } = await ctx.params;
    const body = await parseJsonBody(req, patch);
    const project = await store.getProject(id);
    if (!project) throw new ApiError("not_found", "Project not found.");
    if (body.checks) {
      const problem = validateChecks(body.checks, (await fetchPackageJson(project.repo, project.branch)) as Parameters<typeof validateChecks>[1]);
      if (problem) throw new ApiError("bad_request", problem);
      if (!body.checks.some((c) => c.required)) throw new ApiError("bad_request", "Keep at least one required check so changes can be verified.");
    }
    const updated = await store.updateProject(id, body);
    await store.addEvent({ task_id: null, level: "audit", type: "project.updated", message: `Project ${project.repo} updated: ${Object.keys(body).join(", ")}` });
    return NextResponse.json({ project: updated });
  } catch (err) {
    return wfError(err);
  }
}

/** DELETE /api/workforce/projects/[id] — removes the project, its tasks and memory. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/workforce/projects/[id]">) {
  try {
    const { store } = await requireOperator();
    const { id } = await ctx.params;
    const active = await store.listTasks({ projectId: id, statuses: ["created", "analyzing", "running", "verifying"] });
    if (active.length) throw new ApiError("bad_request", "Cancel the project's running tasks first.");
    await store.deleteProject(id);
    await store.addEvent({ task_id: null, level: "audit", type: "project.deleted", message: `Project ${id} deleted` });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return wfError(err);
  }
}
