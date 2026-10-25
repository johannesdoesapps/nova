import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { decideRun } from "@/lib/mimic/server";
import { CATEGORIES, FIELDS } from "@/lib/mimic/types";

export const maxDuration = 60;

type Ctx = RouteContext<"/api/mimic/runs/[id]">;

const body = z.object({
  action: z.enum(["approve", "reject"]),
  corrections: z.record(z.enum(FIELDS), z.string().trim().max(200)).optional(),
  category: z.enum(CATEGORIES).optional(),
  /** Save the category as a rule for this supplier, instead of using it for this invoice only. */
  remember: z.boolean().optional(),
  /** The user confirms a probable duplicate is a different invoice. */
  notDuplicate: z.boolean().optional(),
});

/** POST /api/mimic/runs/[id] — decide on a run waiting for you: approve (with corrections) or reject. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("mimic-write", 60);
    const d = await parseJsonBody(req, body, 8_000);
    return NextResponse.json({ run: await decideRun(req, auth, id, d) });
  } catch (err) {
    return errorResponse(err);
  }
}
