import { NextResponse } from "next/server";
import { z } from "zod";
import { searchConnected } from "@/lib/connectors/runtime";
import { connectorUser } from "@/lib/connectors/server";
import { errorResponse, parseJsonBody } from "@/lib/http";

const body = z.object({ query: z.string().trim().min(1).max(200), connectors: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/)).max(20).optional() });

/** POST /api/connectors/search — search the caller's connected services at once, with each service's result or error. */
export async function POST(req: Request) {
  try {
    const input = await parseJsonBody(req, body, 2_000);
    const auth = await connectorUser("connectors-search", 20);
    const r = await searchConnected(auth, input.query, input.connectors ?? null, req.signal);
    return NextResponse.json({ items: r.items, runs: r.runs.map((x) => ({ connectorId: x.connectorId, ok: x.ok, summary: x.result?.summary ?? null, error: x.error ?? null })) });
  } catch (err) {
    return errorResponse(err);
  }
}
