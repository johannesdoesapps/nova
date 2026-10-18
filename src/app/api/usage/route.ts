import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth";
import { errorResponse } from "@/lib/http";
import { planUsage } from "@/lib/usage";

/** GET /api/usage — the signed-in user's 5-hour and weekly allowance (null for guests). */
export async function GET() {
  try {
    const auth = await getAuth();
    const state = await planUsage(auth);
    return NextResponse.json({ usage: state }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
