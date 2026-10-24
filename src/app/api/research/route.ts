import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import { createResearch, listResearch } from "@/lib/research/server";

/** GET /api/research — the user's research runs, newest first. */
export async function GET() {
  try {
    const auth = await codeContext("research-read", 120);
    return NextResponse.json({ runs: await listResearch(auth) });
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.object({
  question: z.string().trim().min(5, "Describe what to research.").max(2000),
  depth: z.enum(["quick", "standard", "deep"]).default("standard"),
  context: z.string().trim().max(60_000).nullable().optional(),
});

/** POST /api/research — start Deep Research. The steps run as the page asks (POST /api/research/[id]/step). */
export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, body, 80_000);
    const auth = await codeContext("research-create", 20);
    if (!limiter("research-new", 8, 10 * 60_000).check(`u:${auth.user.id}`, 1).ok) throw new ApiError("rate_limited", "Too many new research runs. Please wait a few minutes.");
    return NextResponse.json({ run: await createResearch(auth, { question: input.question, depth: input.depth, context: input.context || null }) }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
