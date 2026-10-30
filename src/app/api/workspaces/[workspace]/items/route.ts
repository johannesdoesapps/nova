import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { ApiError, errorResponse, parseJsonBody } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import { createItem, duplicateItem, listItems, requireWorkspace } from "@/lib/workspaces/items";

type Ctx = RouteContext<"/api/workspaces/[workspace]/items">;

/** GET /api/workspaces/[workspace]/items?kind= — the user's saved items, newest first (their history). */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const workspace = requireWorkspace((await ctx.params).workspace);
    const auth = await requireUser();
    const kind = new URL(req.url).searchParams.get("kind") ?? undefined;
    return NextResponse.json({ items: await listItems(auth.supabase, workspace, kind || undefined) });
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.object({
  kind: z.string().max(60).optional(),
  title: z.string().max(200).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  /** Make a copy of an existing item instead of a fresh one. */
  duplicateOf: z.string().uuid().optional(),
});

/** POST — create an item, or duplicate one with `duplicateOf`. */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const workspace = requireWorkspace((await ctx.params).workspace);
    const auth = await requireUser();
    if (!limiter("workspace-items", 120, 60_000).check(`u:${auth.user.id}`, 1).ok) throw new ApiError("rate_limited", "Too many changes. Please wait a moment.");
    const input = await parseJsonBody(req, body, 700_000);
    const item = input.duplicateOf ? await duplicateItem(auth.supabase, workspace, input.duplicateOf) : await createItem(auth.supabase, workspace, input);
    return NextResponse.json({ item }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
