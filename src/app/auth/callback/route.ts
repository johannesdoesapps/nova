import { NextResponse } from "next/server";
import { isSupabaseConfigured } from "@/lib/env";
import { createServerSupabase } from "@/lib/supabase/server";

/** Email-confirmation / OAuth callback: exchanges the code for a session cookie. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const nextRaw = url.searchParams.get("next") ?? "/";
  const next = nextRaw.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "/";
  if (code && isSupabaseConfigured()) {
    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, url.origin));
  }
  // Supabase has already confirmed the email by the time it redirects here. The
  // exchange fails when the link is opened in another browser or on another
  // address than the one used to sign up, so ask for a normal sign-in instead.
  const login = new URL("/login", url.origin);
  login.searchParams.set("notice", "Your email is confirmed. Sign in with your password to continue.");
  if (next !== "/") login.searchParams.set("next", next);
  return NextResponse.redirect(login);
}
