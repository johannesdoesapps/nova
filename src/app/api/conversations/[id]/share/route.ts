import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { getChatShare, shareChat, unshareChat } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/http";
import { uuid } from "@/lib/validation";

async function idFrom(ctx: RouteContext<"/api/conversations/[id]/share">) {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) throw new ApiError("not_found", "Conversation not found.");
  return id;
}

/** GET — whether this chat has a read-only link, and up to when it shows the chat. */
export async function GET(_req: Request, ctx: RouteContext<"/api/conversations/[id]/share">) {
  try {
    const id = await idFrom(ctx);
    const { supabase, user } = await requireUser();
    return NextResponse.json(await getChatShare(supabase, user.id, id));
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST — turn the link on, or update it to include the chat up to now. */
export async function POST(_req: Request, ctx: RouteContext<"/api/conversations/[id]/share">) {
  try {
    const id = await idFrom(ctx);
    const { supabase, user } = await requireUser();
    // 24 random bytes: 32 URL-safe characters that can't be guessed.
    return NextResponse.json(await shareChat(supabase, user.id, id, randomBytes(24).toString("base64url")));
  } catch (err) {
    return errorResponse(err);
  }
}

/** DELETE — stop sharing; the link stops working. */
export async function DELETE(_req: Request, ctx: RouteContext<"/api/conversations/[id]/share">) {
  try {
    const id = await idFrom(ctx);
    const { supabase, user } = await requireUser();
    await unshareChat(supabase, user.id, id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
