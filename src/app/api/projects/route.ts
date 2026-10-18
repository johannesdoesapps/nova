import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createProject, listProjects } from "@/lib/db";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { projectCreate } from "@/lib/validation";

/** GET /api/projects — the authenticated user's projects. */
export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    return NextResponse.json({ projects: await listProjects(supabase, user.id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/projects — create a project. */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, projectCreate, 8_000);
    const { supabase, user } = await requireUser();
    const project = await createProject(supabase, user.id, body);
    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
