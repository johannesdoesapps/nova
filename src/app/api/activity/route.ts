import { NextResponse } from "next/server";
import { recentActivity } from "@/lib/agent-platform/activity-server";
import { codeContext } from "@/lib/code/server";
import { errorResponse } from "@/lib/http";

/** GET /api/activity — the signed-in user's recent agent tasks (coding, reviews, research), newest activity first. */
export async function GET() {
  try {
    const auth = await codeContext("activity", 120);
    return NextResponse.json(await recentActivity(auth), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
