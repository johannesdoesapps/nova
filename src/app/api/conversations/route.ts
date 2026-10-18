import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listConversations } from "@/lib/db";
import { errorResponse } from "@/lib/http";

/** GET /api/conversations — the user's recent conversations. */
export async function GET() {
  try {
    const { supabase, user } = await requireUser();
    return NextResponse.json({ conversations: await listConversations(supabase, user.id) });
  } catch (err) {
    return errorResponse(err);
  }
}
