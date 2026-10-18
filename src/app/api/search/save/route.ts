import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { moveSearchToProject } from "@/lib/db";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { saveSearchRequest } from "@/lib/validation";

/** POST /api/search/save — attach a saved search session to a project. */
export async function POST(req: Request) {
  try {
    const body = await parseJsonBody(req, saveSearchRequest, 4_000);
    const { supabase, user } = await requireUser();
    await moveSearchToProject(supabase, user.id, body.searchId, body.projectId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
