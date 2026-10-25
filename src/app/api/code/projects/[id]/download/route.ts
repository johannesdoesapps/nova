import { enforce } from "@/lib/bastion/server";
import { codeContext, getFiles, getProjectRow } from "@/lib/code/server";
import { zipBaseName, zipFiles } from "@/lib/code/zip";
import { errorResponse, requireUuid } from "@/lib/http";

/** GET /api/code/projects/[id]/download — the project's saved files as a .zip (owner only; row-level security applies). */
export async function GET(_req: Request, ctx: RouteContext<"/api/code/projects/[id]/download">) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("code-download", 20);
    const project = await getProjectRow(auth, id);
    await enforce({ db: auth.supabase, userId: auth.user.id, kind: "user", agent: "exports" }, "data.export", `project ${project.name}`.slice(0, 200), { approved: true });
    const files = await getFiles(auth, id);
    const base = zipBaseName(project.name);
    const zip = zipFiles(base, files);
    return new Response(zip as Uint8Array<ArrayBuffer>, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${base}.zip"`,
        "Content-Length": String(zip.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
