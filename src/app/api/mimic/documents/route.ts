import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext } from "@/lib/code/server";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import { addDocument } from "@/lib/mimic/server";

export const maxDuration = 60;

const body = z.object({ name: z.string().trim().min(1).max(200), text: z.string().trim().min(20, "That's too short to be an invoice.").max(60_000), source: z.enum(["upload", "paste"]) });

/** POST /api/mimic/documents — add an invoice (its text) to Mimic's inbox. Automations triggered by new invoices run on it. */
export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, body, 130_000);
    const auth = await codeContext("mimic-write", 60);
    if (!limiter("mimic-doc", 30, 10 * 60_000).check(`u:${auth.user.id}`, 1).ok) throw new ApiError("rate_limited", "Too many documents at once. Please wait a few minutes.");
    return NextResponse.json(await addDocument(req, auth, input), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
