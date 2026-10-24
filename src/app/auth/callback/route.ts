import { NextResponse } from "next/server";
import { track } from "@vercel/analytics/server";
import { LEGAL } from "@/content/legal-meta";
import { hasAccepted, PENDING_COOKIE, recordAcceptance } from "@/lib/legal";
import { afterSignIn, exchangeFailureCode, oauthErrorCode, safeNext, type LoginMessageCode } from "@/lib/auth-flow";
import { isSupabaseConfigured } from "@/lib/env";
import { SIGNED_OUT_COOKIE } from "@/lib/sign-out";
import { createServerSupabase } from "@/lib/supabase/server";

/**
 * Email-confirmation, password-reset, Google and GitHub (OAuth) callback, and
 * the return from connecting GitHub to a signed-in account (via=github-link). Supabase has already
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
  const toPage = (msg: LoginMessageCode) => {
    const back = new URL(next, url.origin);
    back.searchParams.set("github", msg);
    return NextResponse.redirect(back);
  };

  // Cancelled or failed at Google or Supabase: they report it on the URL.
  const error = url.searchParams.get("error");
  if (error) {
    const msg = oauthErrorCode(error, url.searchParams.get("error_code"), via);
    // Linking GitHub happens while signed in: report back on the page it started from.
    if (via === "github-link") return toPage(msg);
    return toLogin(msg);
  }

  if (code && isSupabaseConfigured()) {
    const supabase = await createServerSupabase();
    // The flow id names this attempt's PKCE verifier (several tabs can each
    // have one pending); passing it also lets Supabase delete that verifier.
    const flowId = url.searchParams.get("sb_flow_id");
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined);
    if (!exchangeError) {
      const res = NextResponse.redirect(new URL(afterSignIn(next), url.origin));
      res.cookies.set(SIGNED_OUT_COOKIE, "", { path: "/", expires: new Date(0) });
      // Signed up with Google or GitHub after ticking both boxes: record the acceptance now.
      const pending = readCookie(req, PENDING_COOKIE);
      if (pending) {
        if (pending === LEGAL.version && (await hasAccepted(supabase)) === false) {
          await recordAcceptance(supabase, "signup");
          // A new account made with Google or GitHub: counted anonymously, like email sign-ups (no address or name is sent).
          await track("signup_completed", { method: via === "github" ? "github" : "google" }, { request: req }).catch(() => {});
        }
        res.cookies.set(PENDING_COOKIE, "", { path: "/", maxAge: 0 });
      }
      return res;
    }
  }
  // The exchange fails when the code was used already, expired, or the flow
  // was started in another browser (no PKCE verifier here).
  if (via === "github-link") return toPage(exchangeFailureCode(via, Boolean(code), next));
  return toLogin(exchangeFailureCode(via, Boolean(code), next));
}

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
}
