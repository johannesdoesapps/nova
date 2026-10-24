import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { reportError } from "@/lib/observability";
import { cookiesToClear, SIGNED_OUT_COOKIE } from "@/lib/sign-out";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * POST /auth/signout — POST-only so a link or image can't sign the user out.
 *
 * Ends this browser's session at Supabase (its refresh token can't be used again; other devices stay
 * signed in), then expires every session cookie whatever happened there, so a failed or partial
 * sign-out call can never leave the browser signed in. The proxy doesn't refresh the session on this
 * request (see proxy.ts), so no fresh session cookie is sent alongside the expired ones.
 */
export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL("/", req.url), { status: 303 });
  res.headers.set("Cache-Control", "no-store");
  if (isSupabaseConfigured()) {
    try {
      const supabase = await createServerSupabase();
      const { error } = await supabase.auth.signOut({ scope: "local" });
      if (error) reportError(error, { where: "auth.signout" });
    } catch (err) {
      reportError(err, { where: "auth.signout" });
    }
  }
  // An expiry date in the past (Next leaves out Max-Age=0), so the browser deletes each cookie. Set on
  // the request's cookie store too: Next merges that store into the response, and its entry for a name wins.
  const store = await cookies();
  const expired = { path: "/", expires: new Date(0) };
  for (const name of cookiesToClear(store.getAll().map((c) => c.name))) {
    store.set(name, "", expired);
    res.cookies.set(name, "", expired);
  }
  res.cookies.set(SIGNED_OUT_COOKIE, "1", { path: "/", maxAge: 600, httpOnly: true, sameSite: "lax", secure: new URL(req.url).protocol === "https:" });
  return res;
}
