import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listConversations } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/http";
import { conversationSearch } from "@/lib/validation";

/** GET /api/conversations — the user's recent conversations, or with `?q=` those whose title matches. */
export async function GET(req: Request) {
  try {
    const parsed = conversationSearch.safeParse({ q: new URL(req.url).searchParams.get("q") ?? undefined });
    if (!parsed.success) throw new ApiError("bad_request", "Search text is too long.");
    const { supabase, user } = await requireUser();
    return NextResponse.json({ conversations: await listConversations(supabase, user.id, 50, parsed.data.q) });
  } catch (err) {
    return errorResponse(err);
  }
}
