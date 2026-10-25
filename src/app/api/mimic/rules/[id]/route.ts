import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { updateRule } from "@/lib/mimic/server";
import { CATEGORIES } from "@/lib/mimic/types";

type Ctx = RouteContext<"/api/mimic/rules/[id]">;

/** PATCH /api/mimic/rules/[id] — change a rule's category, or remove it. Every change is kept in the rule's history. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("mimic-write", 60);
    const body = await parseJsonBody(req, z.object({ category: z.enum(CATEGORIES).optional(), remove: z.boolean().optional() }), 2_000);
    await updateRule(auth, id, body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
