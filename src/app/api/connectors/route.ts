import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth";
import { catalogFor } from "@/lib/connectors/server";
import { errorResponse } from "@/lib/http";

/**
 * GET /api/connectors — every connector Orbis supports, whether it's set up
 * on this site, and the caller's connection to each (never tokens).
 * Administrators also see what's missing to set each one up.
 */
export async function GET() {
  try {
    return NextResponse.json(await catalogFor(await getAuth()));
  } catch (err) {
    return errorResponse(err);
  }
}
