import { NextResponse } from "next/server";
import { codeContext } from "@/lib/code/server";
import { errorResponse } from "@/lib/http";
import { overview } from "@/lib/mimic/server";

/** GET /api/mimic — everything the Mimic page shows: automations, runs, rules, Demo Books, inbox, settings and the audit log. */
export async function GET() {
  try {
    const auth = await codeContext("mimic-read", 120);
    return NextResponse.json(await overview(auth), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}
