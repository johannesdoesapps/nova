import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listChats, searchChats } from "@/lib/db";
import { ApiError, errorResponse } from "@/lib/http";
import { conversationSearch } from "@/lib/validation";

/**
 * GET /api/conversations — the user's chats: pinned first, then the most recent.
 * `?q=` searches titles and message text; `?archived=1` lists archived chats; `?project=<id>` one project's chats.
 */
export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const parsed = conversationSearch.safeParse({ q: params.get("q") ?? undefined, archived: params.get("archived") ?? undefined, project: params.get("project") ?? undefined });
    if (!parsed.success) throw new ApiError("bad_request", "That search is not valid.");
    const { q, archived, project } = parsed.data;
    const { supabase, user } = await requireUser();
    const conversations = q
      ? await searchChats(supabase, user.id, q, !!archived)
      : await listChats(supabase, user.id, { archived: !!archived, projectId: project, limit: archived || project ? 200 : 50 });
    return NextResponse.json({ conversations }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
