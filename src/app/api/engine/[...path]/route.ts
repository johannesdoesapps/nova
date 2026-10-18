import { NextResponse } from "next/server";
import { engineFetch } from "@/lib/engine";
import { ApiError, clientIp, errorResponse } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";

export const maxDuration = 120;

/** Engine paths the browser may reach through this proxy. Everything else is 404. */
const ALLOWED = /^(health|lab|radar|workspaces|community|connectors|connections|conflicts|share)(\/[\w.:-]+)*$/;

async function proxy(req: Request, ctx: RouteContext<"/api/engine/[...path]">) {
  try {
    const { path: parts } = await ctx.params;
    const path = parts.map((p) => encodeURIComponent(decodeURIComponent(p))).join("/");
    if (!ALLOWED.test(path)) throw new ApiError("not_found", "Unknown engine endpoint.");
    const ip = clientIp(req);
    if (!limiter("engine", 240, 60_000).check(ip, req.method === "GET" ? 1 : 3).ok) throw new ApiError("rate_limited", "Too many requests. Please slow down.");
    const max = path.endsWith("import") ? 10_500_000 : 2_000_000;
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
    if (body && body.length > max) throw new ApiError("payload_too_large", "Request body too large.");
    const query = new URL(req.url).searchParams.toString();
    const res = await engineFetch(path, { method: req.method, body: body || undefined, query, requestId: crypto.randomUUID() });

    if (path === "connectors/oauth/callback") {
      // Browser redirect back from the provider: show the result in the app instead of raw JSON.
      const ok = res.ok;
      const msg = ok ? "connected=1" : `error=${encodeURIComponent(((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message ?? "Connection failed")}`;
      return NextResponse.redirect(new URL(`/integrations?${msg}`, req.url));
    }
    const text = await res.text();
    return new NextResponse(text, { status: res.status, headers: { "Content-Type": res.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err);
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
