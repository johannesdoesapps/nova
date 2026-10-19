import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { councilSessionInput } from "@/lib/council/schema";
import { listCouncilSessions, saveCouncilSession } from "@/lib/db/council";
import { errorResponse, parseJsonBody, parseQuery } from "@/lib/http";

const query = z.object({ kind: z.enum(["council", "arena"]).default("council") });

/** GET /api/council/sessions?kind= — the signed-in user's saved sessions. */
export async function GET(req: Request) {
  try {
    const auth = await requireUser();
    const { kind } = parseQuery(req.url, query);
    return NextResponse.json({ sessions: await listCouncilSessions(auth.supabase, auth.user.id, kind) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST /api/council/sessions — save a finished Council or Arena run. */
export async function POST(req: Request) {
  try {
    const auth = await requireUser();
    const input = await parseJsonBody(req, councilSessionInput, 420_000);
    return NextResponse.json({ session: await saveCouncilSession(auth.supabase, auth.user.id, input) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
