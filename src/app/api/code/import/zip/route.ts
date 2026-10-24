import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdmin } from "@/lib/admin";
import { MAX_FILE_BYTES, projectLimits, validProjectPath, type ProjectFile } from "@/lib/code/projects";
import { codeContext, createProject } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { unzip } from "@/lib/review/unzip";

const ZIP_BYTES = 3_000_000;
const body = z.object({ name: z.string().trim().min(1).max(80), data: z.string().max(Math.ceil((ZIP_BYTES * 4) / 3) + 8) });

/**
 * POST /api/code/import/zip — a new project from a .zip the user uploads (base64, up to 3 MB). Only
 * text files with safe relative paths are kept (no dependency or build folders, binaries or encrypted
 * entries), within the project limits. The archive's contents are stored as data and never run here.
 */
export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, body, Math.ceil((ZIP_BYTES * 4) / 3) + 2_000);
    const auth = await codeContext("code-import", 5);
    const buf = Buffer.from(input.data, "base64");
    if (buf.length > ZIP_BYTES) throw new ApiError("payload_too_large", "The ZIP is over 3 MB. Leave out dependencies and build output.");
    const limits = projectLimits(await isAdmin(auth));
    let r;
    try {
      r = unzip(buf, { maxFiles: limits.files, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: limits.bytes });
    } catch (e) {
      throw new ApiError("bad_request", (e as Error).message);
    }
    const files: ProjectFile[] = r.files.filter((f) => validProjectPath(f.path)).map((f) => ({ path: f.path, content: f.content }));
    if (!files.length) throw new ApiError("bad_request", "The ZIP has no text files Orbis can open.");
    const project = await createProject(auth, { name: input.name, template: "blank", runCommand: "", files });
    return NextResponse.json({ project, imported: files.length, leftOut: r.skipped + (r.files.length - files.length) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
