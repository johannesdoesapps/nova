import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listFindings } from "@/lib/db/security";
import { errorResponse, parseQuery } from "@/lib/http";
import { findingsQuery } from "@/lib/security/schema";

/** GET /api/security/findings — filter, search and sort findings from all agents. */
export async function GET(req: Request) {
  try {
    const auth = await requireUser();
    const q = parseQuery(req.url, findingsQuery);
    return NextResponse.json({ findings: await listFindings(auth.supabase, auth.user.id, { ...q, includeDuplicates: q.includeDuplicates === "1" }) });
  } catch (err) {
    return errorResponse(err);
  }
}
