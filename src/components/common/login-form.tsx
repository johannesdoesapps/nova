"use client";
import { GitHubLogo } from "./github-logo";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { track } from "@vercel/analytics";
import { LEGAL } from "@/content/legal-meta";
import { PENDING_COOKIE } from "@/lib/legal";
import { browserSupabase } from "@/lib/supabase/client";
import { friendlyAuthError, LOGIN_MESSAGES, oauthErrorCode, oauthRedirectTo, RESET_PASSWORD_PATH } from "@/lib/auth-flow";
import { Button, Input, Notice } from "@/components/ui/primitives";

type Mode = "signin" | "signup";

const COPY: Record<Mode, { title: string; subtitle: string; divider: string }> = {
  signin: { title: "Welcome back to Orbis", subtitle: "Sign in to save conversations, searches and projects.", divider: "or continue with email" },
  signup: { title: "Create your Orbis account", subtitle: "Save conversations, searches and projects across devices.", divider: "or sign up with email" },
};

export function LoginForm({
  url,
  supabaseKey,
  next,
  siteUrl,
  initialMode = "signin",
  google,
  github = false,
}: {
  url: string;
  supabaseKey: string;
  next: string;
  siteUrl: string;
  initialMode?: Mode;
  /** Whether Google is switched on in Supabase Auth; null when that couldn't be checked. */
  google: boolean | null;
  /** Whether GitHub is switched on in Supabase Auth (the button is only shown then). */
  github?: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [githubBusy, setGithubBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  // Blocks a second click before React re-renders the button as busy.
  const googleStarted = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // Sign-up: both documents must be accepted before an account is created (by email, Google or GitHub).
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [agreePrivacy, setAgreePrivacy] = useState(false);
  const consentRef = useRef<HTMLFieldSetElement>(null);
  const consented = agreeTerms && agreePrivacy;
  const needConsent = () => {
    if (mode !== "signup" || consented) return false;
    setError("To create an account, tick both boxes to agree to the Terms of Service and the Privacy Policy.");
    consentRef.current?.querySelector<HTMLInputElement>("input:not(:checked)")?.focus();
    return true;
  };
  const [info, setInfo] = useState<string | null>(null);
  const copy = COPY[mode];
  // Redirects go to the main site address, which is the one on Supabase's
  // redirect allow-list, even when signing in from a preview URL.
  const origin = () => (siteUrl.includes("localhost") && typeof window !== "undefined" ? window.location.origin : siteUrl);

  // Sign-up funnel, counted anonymously by Vercel Web Analytics: no email address or other detail is sent.
  const count = (event: "signup_started" | "signup_completed", props: Record<string, string>) => {
    try {
      track(event, props);
    } catch {
      /* not counted */
    }
  };

  const continueWithGoogle = () => continueWith("google");
  const continueWith = async (provider: "google" | "github") => {
    if (googleStarted.current || busy) return;
    if (needConsent()) return;
    const setProviderBusy = provider === "google" ? setGoogleBusy : setGithubBusy;
    setError(null);
    setInfo(null);
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      setError("You're offline. Check your connection and try again.");
      return;
    }
    googleStarted.current = true;
    setProviderBusy(true);
    if (mode === "signup") count("signup_started", { method: provider });
    // Carried through the provider's sign-in, so the acceptance is recorded when the new account comes back.
    if (mode === "signup") document.cookie = `${PENDING_COOKIE}=${LEGAL.version}; Max-Age=1800; Path=/; SameSite=Lax; Secure`;
    try {
      // Supabase runs the OAuth flow with PKCE and checks state (and, for
      // Google, the OpenID nonce); Orbis never sees Google or GitHub credentials.
      const { error } = await browserSupabase(url, supabaseKey).auth.signInWithOAuth(
        provider === "google"
          ? {
              provider: "google",
              options: {
                redirectTo: oauthRedirectTo(origin(), next),
                // Always show Google's account chooser, so a shared device doesn't
                // silently continue as whoever used Google last.
                queryParams: { prompt: "select_account" },
              },
            }
          : // Only the public profile and email; repository access is granted separately, per repository.
            { provider: "github", options: { redirectTo: oauthRedirectTo(origin(), next, "github"), scopes: "read:user user:email" } },
      );
      if (error) throw error;
      // The browser is now leaving for the provider; keep the button busy until it does.
    } catch (e) {
      googleStarted.current = false;
      setProviderBusy(false);
      const m = String((e as Error)?.message ?? "");
      setError(/fetch|network/i.test(m) ? "Couldn't reach the sign-in service. Check your connection and try again." : LOGIN_MESSAGES[oauthErrorCode(m)].text);
    }
  };

  const submit = async () => {
    if (needConsent()) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    const supabase = browserSupabase(url, supabaseKey);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        router.replace(next);
        router.refresh();
      } else {
        count("signup_started", { method: "email" });
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            // Recorded with the new account as its acceptance of these documents' current version.
            data: { display_name: name.trim() || undefined, terms_version: LEGAL.version },
            emailRedirectTo: `${origin()}/auth/callback?next=${encodeURIComponent(next)}`,
          },
        });
        if (error) throw error;
        if (data.session) {
          // Email confirmation is off: the new account is signed in straight away.
          count("signup_completed", { method: "email", confirm: "none" });
          router.replace(next);
          router.refresh();
        } else if (data.user && data.user.identities?.length === 0) {
          // Supabase hides whether an email is registered; an empty identity list means it already is.
          setMode("signin");
          setInfo("You already have an account with this email. Enter your password, or continue with Google if you used it before.");
        } else {
          count("signup_completed", { method: "email", confirm: "email" });
          setInfo("Check your inbox to confirm your email, then sign in.");
        }
      }
    } catch (e) {
      setError(friendlyAuthError((e as Error).message, mode));
    } finally {
      setBusy(false);
    }
  };

  // Emails a password reset link. The reply is the same whether or not an
  // account exists, so the form can't be used to discover who has signed up.
  const forgotPassword = async () => {
    setError(null);
    setInfo(null);
    if (!email.trim()) {
      setError("Enter your email above, then choose “Forgot password?” again.");
      return;
    }
    setResetBusy(true);
    try {
      const { error } = await browserSupabase(url, supabaseKey).auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${origin()}/auth/callback?next=${encodeURIComponent(RESET_PASSWORD_PATH)}`,
      });
      if (error) throw error;
      setInfo("If an account exists for that email, we’ve sent a link to reset your password.");
    } catch (e) {
      setError(friendlyAuthError((e as Error)?.message, "reset"));
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <div>
      <h1 className="font-serif text-[34px] leading-[1.05] tracking-[-0.01em]">{copy.title}</h1>
      <p className="mt-1 text-sm text-muted">{copy.subtitle}</p>

      {mode === "signup" && (
        <fieldset ref={consentRef} className="mt-5 space-y-2.5 rounded-xl border border-border bg-panel-2 p-3.5 text-[13px] leading-snug">
          <legend className="sr-only">Agreements</legend>
          <label className="flex items-start gap-2.5">
            <input type="checkbox" required checked={agreeTerms} onChange={(e) => setAgreeTerms(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]" />
            <span>
              I agree to the{" "}
              <Link href="/terms" target="_blank" className="text-fg underline underline-offset-2 hover:text-accent">
                Terms of Service
              </Link>
              .
            </span>
          </label>
          <label className="flex items-start gap-2.5">
            <input type="checkbox" required checked={agreePrivacy} onChange={(e) => setAgreePrivacy(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]" />
            <span>
              I have read the{" "}
              <Link href="/privacy" target="_blank" className="text-fg underline underline-offset-2 hover:text-accent">
                Privacy Policy
              </Link>{" "}
              and{" "}
              <Link href="/cookies" target="_blank" className="text-fg underline underline-offset-2 hover:text-accent">
                Cookie Policy
              </Link>
              , which explain how Orbis uses my data.
            </span>
          </label>
          <p className="text-xs text-muted">You must be 13 or older. If you&apos;re under 18, you need a parent&apos;s or guardian&apos;s permission.</p>
        </fieldset>
      )}

      <div className="mt-5">
        <GoogleButton onClick={() => void continueWithGoogle()} loading={googleBusy} disabled={google === false || busy} />
        {google === false && (
          <p className="mt-2 text-center text-xs text-muted">Google sign-in isn&rsquo;t set up on this site yet. Use your email below.</p>
        )}
        {github && (
          <Button
            type="button"
            variant="outline"
            className="mt-2 w-full bg-bg-elev focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => void continueWith("github")}
            loading={githubBusy}
            disabled={busy || googleBusy}
            aria-busy={githubBusy}
          >
            {!githubBusy && <GitHubLogo />}
            <span>{githubBusy ? "Opening GitHub…" : "Continue with GitHub"}</span>
          </Button>
        )}
      </div>

      <div className="my-5 flex items-center gap-3 text-xs text-muted" role="separator" aria-label={copy.divider}>
        <span className="h-px flex-1 bg-border" aria-hidden />
        <span aria-hidden>{copy.divider}</span>
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {mode === "signup" && (
          <label className="block">
            <span className="mb-1 block text-xs text-muted">Name</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" />
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Email</span>
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">Password</span>
          <Input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signin" ? "current-password" : "new-password"} />
        </label>
        {mode === "signin" && (
          <div className="-mt-1 text-right text-xs">
            <button
              type="button"
              onClick={() => void forgotPassword()}
              disabled={resetBusy || busy}
              className="rounded text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
            >
              {resetBusy ? "Sending link…" : "Forgot password?"}
            </button>
          </div>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
        {info && <Notice tone="success">{info}</Notice>}
        <Button type="submit" className="w-full" loading={busy} disabled={googleBusy}>{mode === "signin" ? "Sign in" : "Create account"}</Button>
        <p className="text-center text-xs text-muted">
          {mode === "signin" ? "Don’t have an account?" : "Already have an account?"}{" "}
          <button
            type="button"
            className="rounded text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
              setInfo(null);
            }}
          >
            {mode === "signin" ? "Sign up" : "Sign in"}
          </button>
        </p>
      </form>
    </div>
  );
}

/** "Continue with Google" in Google's neutral button style, with the standard multicolour G. */
function GoogleButton({ onClick, loading, disabled }: { onClick: () => void; loading: boolean; disabled: boolean }) {
  return (
    <Button
      type="button"
      variant="outline"
      className="w-full bg-bg-elev focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      onClick={onClick}
      loading={loading}
      disabled={disabled}
      aria-busy={loading}
    >
      {!loading && <GoogleLogo />}
      <span>{loading ? "Opening Google…" : "Continue with Google"}</span>
    </Button>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 48 48" className="h-[18px] w-[18px]" aria-hidden focusable="false">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}
