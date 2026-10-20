import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listConversations } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/http";
import { conversationSearch } from "@/lib/validation";

/** GET /api/conversations — the user's recent conversations, or with `?q=` those whose title matches; `?archived=1` lists archived ones. */
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const parsed = conversationSearch.safeParse({ q: params.get("q") ?? undefined, archived: params.get("archived") ?? undefined });
    if (!parsed.success) throw new ApiError("bad_request", "Search text is too long.");
    const { supabase, user } = await requireUser();
    return NextResponse.json({ conversations: await listConversations(supabase, user.id, parsed.data.archived ? 200 : 50, parsed.data.q, !!parsed.data.archived) });
  } catch (err) {
    return errorResponse(err);
  }
}
