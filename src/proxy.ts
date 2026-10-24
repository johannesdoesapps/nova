import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { LEGAL } from "@/content/legal-meta";
import { ACCEPTED_COOKIE, acceptedCookieOptions, hasAccepted, needsAcceptance } from "@/lib/legal";

/**
 * Pages that require a signed-in user (only enforced when Supabase is configured).
 * /settings stays public: guests use it for appearance settings.
 */
const PROTECTED_PREFIXES = ["/projects"];

/**
 * Refreshes the Supabase session cookie on navigation and gates private pages.
 * API routes perform their own server-side auth checks; this is not the only
 * line of defence.
 */
export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/")) return guardApi(request);
  const canonical = canonicalRedirect(request);
  if (canonical) return canonical;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!url || !key) return NextResponse.next({ request });
  // Signing out ends the session: refreshing it here would send a fresh session cookie in the same response.
  if (request.nextUrl.pathname === "/auth/signout") return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers ?? {}).forEach(([k, v]) => response.headers.set(k, v));
      },
    },
  });

  // getClaims() verifies the JWT and refreshes the session if needed.
  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims?.sub);

  const path = request.nextUrl.pathname;
  if (!signedIn && PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(login);
  }

  // Signed-in users accept the current Terms of Service and Privacy Policy before using the app.
  if (signedIn && request.method === "GET" && needsAcceptance(path) && request.cookies.get(ACCEPTED_COOKIE)?.value !== LEGAL.version) {
    const accepted = await hasAccepted(supabase);
    if (accepted === false) {
      const consent = request.nextUrl.clone();
      consent.pathname = "/consent";
      consent.search = `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
      const redirect = NextResponse.redirect(consent);
      response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
      return redirect;
    }
    // Checked (or the check is unavailable: never lock people out because of it).
    if (accepted) response.cookies.set(ACCEPTED_COOKIE, LEGAL.version, acceptedCookieOptions);
  }
  return response;
}

/**
 * In production, page visits on a *.vercel.app address go to the site's own
 * domain (NEXT_PUBLIC_SITE_URL): sign-in returns there, so a session started on
 * another host would not survive the round trip. API calls are left alone.
 */
export function canonicalRedirect(request: NextRequest, env: Record<string, string | undefined> = process.env): NextResponse | null {
  if (env.VERCEL_ENV !== "production") return null;
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  let site: URL;
  try {
    site = new URL(env.NEXT_PUBLIC_SITE_URL ?? "");
  } catch {
    return null;
  }
  const host = (request.headers.get("host") ?? request.nextUrl.host).toLowerCase();
  if (!host.endsWith(".vercel.app") || site.host.endsWith(".vercel.app") || host === site.host) return null;
  const to = new URL(request.nextUrl.pathname + request.nextUrl.search, site.origin);
  return NextResponse.redirect(to, 308);
}

/** Endpoints other sites legitimately call (verified by their own signature). */
const CROSS_SITE_OK = ["/api/stripe/webhook"];

/**
 * CSRF defence in depth for API routes (they do their own auth): a request
 * that changes something must come from this site. Browsers send Origin and
 * Sec-Fetch-Site on cross-site requests; non-browser clients send neither and
 * carry no session cookie by default.
 */
export function guardApi(request: NextRequest): NextResponse {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return NextResponse.next();
  if (CROSS_SITE_OK.includes(request.nextUrl.pathname)) return NextResponse.next();
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  let sameOrigin = true;
  if (origin && origin !== "null") {
    try {
      sameOrigin = new URL(origin).host === request.headers.get("host") || new URL(origin).host === request.nextUrl.host;
    } catch {
      sameOrigin = false;
    }
  } else if (origin === "null") sameOrigin = false;
  if (site === "cross-site") sameOrigin = false;
  if (sameOrigin) return NextResponse.next();
  return NextResponse.json({ error: { code: "forbidden", message: "Cross-site requests aren't allowed." } }, { status: 403 });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|opengraph-image|twitter-image|apple-icon|icon|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml)$).*)"],
};
