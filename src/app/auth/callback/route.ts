import { NextResponse } from "next/server";
import { exchangeFailureCode, oauthErrorCode, safeNext, type LoginMessageCode } from "@/lib/auth-flow";
import { isSupabaseConfigured } from "@/lib/env";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Email-confirmation and Google (OAuth) callback. Supabase has already
 * validated the provider response (state, nonce); here the one-time code is
 * exchanged for a session using the PKCE verifier stored in this browser.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const via = url.searchParams.get("via");
  const next = safeNext(url.searchParams.get("next"));
  const toLogin = (msg: LoginMessageCode) => {
    const login = new URL("/login", url.origin);
    login.searchParams.set("msg", msg);
    if (next !== "/") login.searchParams.set("next", next);
    return NextResponse.redirect(login);
  };

  // Cancelled or failed at Google or Supabase: they report it on the URL.
  const error = url.searchParams.get("error");
  if (error) return toLogin(oauthErrorCode(error, url.searchParams.get("error_code")));

  if (code && isSupabaseConfigured()) {
    const supabase = await createServerSupabase();
    // The flow id names this attempt's PKCE verifier (several tabs can each
    // have one pending); passing it also lets Supabase delete that verifier.
    const flowId = url.searchParams.get("sb_flow_id");
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
    if (!exchangeError) return NextResponse.redirect(new URL(next, url.origin));
  }
  // The exchange fails when the code was used already, expired, or the flow
  // was started in another browser (no PKCE verifier here).
  return toLogin(exchangeFailureCode(via));
}
