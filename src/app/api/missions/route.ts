import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { createMission, listMissions } from "@/lib/db/missions";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { missionCreate } from "@/lib/missions/schema";

/** GET /api/missions — the user's missions with task counts by status. */
export async function GET() {
  try {
    const auth = await requireUser();
    return NextResponse.json({ missions: await listMissions(auth.supabase, auth.user.id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/missions — create a mission (from an edited AI plan, or empty). */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    const body = await parseJsonBody(req, missionCreate, 200_000);
    return NextResponse.json({ mission: await createMission(auth.supabase, auth.user.id, body) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
