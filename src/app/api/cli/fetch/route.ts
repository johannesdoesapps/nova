import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCliUser } from "@/lib/cli-auth";
import { errorResponse, parseJsonBody } from "@/lib/http";
import { readLink } from "@/lib/links/read";

const MAX_TEXT = 100_000;

const body = z.object({ url: z.string().url().max(2_000).refine((u) => /^https?:\/\//i.test(u), "Only http and https addresses.") });

/**
 * POST /api/cli/fetch — the terminal app's web_fetch tool. Pages are read here, with Orbis's guarded link reader
 * (public addresses only, checked at connect time; size, time and redirect limits), so the agent on the user's
 * computer can't be steered into the user's own network. Rate limited; not metered (no model is called).
 */
export async function POST(req: Request) {
  try {
    await requireCliUser(req, "cli-fetch", 30);
    const { url } = await parseJsonBody(req, body, 8_000);
    const r = await readLink(url, req.signal);
    if (!r.ok) return NextResponse.json({ ok: false, url: r.url, reason: r.reason }, { headers: { "Cache-Control": "no-store" } });
    return NextResponse.json(
      { ok: true, url: r.url, finalUrl: r.finalUrl, title: r.title, text: r.text.slice(0, MAX_TEXT), truncated: r.text.length > MAX_TEXT },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
