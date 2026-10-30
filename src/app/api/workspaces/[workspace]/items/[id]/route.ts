import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { errorResponse, parseJsonBody, requireUuid } from "@/lib/http";
import { deleteItem, getItem, requireWorkspace, updateItem } from "@/lib/workspaces/items";

type Ctx = RouteContext<"/api/workspaces/[workspace]/items/[id]">;

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { workspace: ws, id } = await ctx.params;
    const workspace = requireWorkspace(ws);
    const auth = await requireUser();
    return NextResponse.json({ item: await getItem(auth.supabase, workspace, requireUuid(id)) });
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.object({ title: z.string().max(200).optional(), data: z.record(z.string(), z.unknown()).optional() });

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { workspace: ws, id } = await ctx.params;
    const workspace = requireWorkspace(ws);
    const auth = await requireUser();
    const input = await parseJsonBody(req, body, 700_000);
    return NextResponse.json({ item: await updateItem(auth.supabase, workspace, requireUuid(id), input) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { workspace: ws, id } = await ctx.params;
    const workspace = requireWorkspace(ws);
    const auth = await requireUser();
    await deleteItem(auth.supabase, workspace, requireUuid(id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
