import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import { createFromDemonstration } from "@/lib/mimic/server";
import { demonstration } from "@/lib/mimic/types";

/** POST /api/mimic/workflows — learn an automation from a demonstration recorded in Teach mode. */
export async function POST(req: Request) {
  try {
    const { demonstration: demo } = await parseJsonBody(req, z.object({ demonstration }), 200_000);
    const auth = await codeContext("mimic-write", 60);
    if (!limiter("mimic-teach", 20, 10 * 60_000).check(`u:${auth.user.id}`, 1).ok) throw new ApiError("rate_limited", "Too many new automations. Please wait a few minutes.");
    return NextResponse.json({ workflow: await createFromDemonstration(auth, demo) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
