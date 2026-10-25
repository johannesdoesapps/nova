import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { deleteWorkflow, updateWorkflow } from "@/lib/mimic/server";
import { CURRENCIES, MODES } from "@/lib/mimic/types";

type Ctx = RouteContext<"/api/mimic/workflows/[id]">;

const patch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  mode: z.enum(MODES as [string, ...string[]]).optional(),
  trigger: z.enum(["manual", "document_added"]).optional(),
  status: z.enum(["active", "paused"]).optional(),
  steps: z.array(z.object({ id: z.string().max(40), enabled: z.boolean().optional(), requiresApproval: z.boolean().optional() })).max(20).optional(),
  autoLimit: z.number().min(0).max(1_000_000).optional(),
  currencies: z.array(z.enum(CURRENCIES)).min(1).max(5).optional(),
  answer: z.object({ questionId: z.string().max(60), answer: z.string().max(40) }).optional(),
});

/** PATCH /api/mimic/workflows/[id] — edit an automation: name, mode, trigger, steps, limits, answers; turn it on (after a test) or pause it. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("mimic-write", 60);
    const body = await parseJsonBody(req, patch, 20_000);
    return NextResponse.json({ workflow: await updateWorkflow(auth, id, body as Parameters<typeof updateWorkflow>[2]) });
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE /api/mimic/workflows/[id] — delete an automation and its run history (drafts it created stay in Demo Books). */
export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const id = requireUuid((await ctx.params).id);
    const auth = await codeContext("mimic-write", 60);
    await deleteWorkflow(auth, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
