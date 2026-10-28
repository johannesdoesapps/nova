import { NextResponse } from "next/server";
import { z } from "zod";
import { codeContext } from "@/lib/code/server";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { listInbox, markInboxRead, waitingCount } from "@/lib/inbox";

/**
 * GET /api/inbox — the signed-in user's latest updates (tasks that finished, stopped or need them while nobody had
 * their page open), how many are unread, and how many tasks wait for them now. Polled by the sidebar.
 */
export async function GET() {
  try {
    const auth = await codeContext("inbox", 60);
    const [inbox, waiting] = await Promise.all([listInbox(auth), waitingCount(auth)]);
    return NextResponse.json({ ...inbox, waiting }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

const body = z.object({ ids: z.union([z.literal("all"), z.array(z.number().int().positive()).min(1).max(100)]) });

/** POST /api/inbox — mark updates read: { ids: [..] } or { ids: "all" }. */
export async function POST(req: Request) {
  try {
    const auth = await codeContext("inbox-read", 60);
    const { ids } = await parseJsonBody(req, body, 4_000);
    await markInboxRead(auth, ids);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
