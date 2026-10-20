import { NextResponse } from "next/server";
import { z } from "zod";
import { applyFileChanges, codeContext, getProjectRow, optionalBox } from "@/lib/code/server";
import { fileContent, MAX_PROJECT_BYTES, projectPath } from "@/lib/code/projects";
import { removeFromWorkspace, writeToWorkspace } from "@/lib/code/workspace";
import { ApiError, errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { reportError } from "@/lib/observability";

const body = z.object({
  changes: z
    .array(z.object({ path: projectPath, content: fileContent.nullable() }))
    .min(1)
    .max(100),
});

/**
 * POST /api/code/projects/[id]/files — save, create or delete files (null
 * content deletes; a rename is a delete plus a create). Saved to the project
 * and, when its computer is running, copied there too.
 */
export async function POST(req: Request, ctx: RouteContext<"/api/code/projects/[id]/files">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const input = await parseJsonBody(req, body, MAX_PROJECT_BYTES + 64_000);
    if (new Set(input.changes.map((c) => c.path)).size !== input.changes.length) throw new ApiError("bad_request", "Each file can appear only once.");
    const auth = await codeContext("code-files", 240);
    await getProjectRow(auth, id);
    await applyFileChanges(auth, id, input.changes);
    const box = await optionalBox(auth, id);
    if (box) {
      try {
        await removeFromWorkspace(box, input.changes.filter((c) => c.content === null).map((c) => c.path));
        await writeToWorkspace(box, input.changes.filter((c): c is { path: string; content: string } => c.content !== null));
      } catch (err) {
        reportError(err, { where: "code.files.mirror" });
        return NextResponse.json({ ok: true, mirrored: false });
      }
    }
    return NextResponse.json({ ok: true, mirrored: Boolean(box) });
  } catch (err) {
    return errorResponse(err);
  }
}
